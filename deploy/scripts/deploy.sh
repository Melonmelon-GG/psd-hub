#!/usr/bin/env bash
# =============================================================================
# PSD 展示台 · 一键推送部署
#
#   bash deploy/scripts/deploy.sh                      # 用 deploy/.env.deploy 里的 DEPLOY_MODE
#   bash deploy/scripts/deploy.sh --mode docker        # 服务器上 docker compose 构建并启动
#   bash deploy/scripts/deploy.sh --mode pm2           # 本地构建 + rsync 产物 + pm2 reload
#   bash deploy/scripts/deploy.sh --dry-run            # 只打印将要执行的命令，不动服务器
#   bash deploy/scripts/deploy.sh --skip-tests         # 跳过部署前的测试
#   bash deploy/scripts/deploy.sh --mode pm2 --rollback  # 回滚到上一个 release
#
# 退出码：0 成功 · 1 参数/环境错误 · 2 构建失败 · 3 部署失败 · 4 健康检查失败
#
# 设计约定：
#   · 构建在**本地**完成（Windows/macOS 也能跑），服务器只接收产物，因此服务器
#     不需要安装 devDependencies，也不需要 Node 之外的工具链。
#   · pm2 模式采用 releases/<时间戳> + current 软链的原子发布布局，回滚 = 切软链。
#   · 健康检查在服务器上通过 SSH 打 127.0.0.1，失败自动回滚。
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CONFIG_FILE="${ROOT_DIR}/deploy/.env.deploy"

# ------------------------------ 日志 ------------------------------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_INFO=$'\033[36m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'
else
  C_RESET=''; C_INFO=''; C_OK=''; C_WARN=''; C_ERR=''; C_DIM=''
fi
log()  { printf '%s[deploy]%s %s\n' "$C_INFO" "$C_RESET" "$*"; }
ok()   { printf '%s[  ok  ]%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '%s[ warn ]%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
die()  { printf '%s[ fail ]%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; exit "${2:-3}"; }
step() { printf '\n%s══ %s ══%s\n' "$C_DIM" "$*" "$C_RESET"; }

# ------------------------------ 默认值 ------------------------------
# 注意：一律使用 ${VAR:-默认值} 形式，否则会把调用者传入的环境变量覆盖掉
# （CI/脚本里常用 `DEPLOY_HOST=x bash deploy/scripts/deploy.sh` 这种写法）。
DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
DEPLOY_PORT="${DEPLOY_PORT:-22}"
SSH_KEY="${SSH_KEY:-}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/psd-hub}"
DEPLOY_MODE="${DEPLOY_MODE:-docker}"
APP_PORT="${APP_PORT:-4000}"
HEALTH_PATH="${HEALTH_PATH:-/api/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-15}"
HEALTH_DELAY="${HEALTH_DELAY:-2}"
PM2_APP_NAME="${PM2_APP_NAME:-psd-hub}"
REMOTE_ENV_FILE="${REMOTE_ENV_FILE:-/etc/psd-hub/psd-hub.env}"
PSD_HUB_IMAGE="${PSD_HUB_IMAGE:-psd-hub}"
PSD_HUB_VERSION="${PSD_HUB_VERSION:-1.0.0}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
RUN_TESTS_BEFORE_DEPLOY="${RUN_TESTS_BEFORE_DEPLOY:-1}"

# ------------------------------ 参数 ------------------------------
DRY_RUN=0
SKIP_BUILD=0
SKIP_TESTS=0
SKIP_HEALTHCHECK=0
ROLLBACK=0
MODE_OVERRIDE=""

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE_OVERRIDE="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --no-healthcheck) SKIP_HEALTHCHECK=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    -h|--help) usage ;;
    *) die "未知参数：$1（用 --help 查看用法）" 1 ;;
  esac
done

# ------------------------------ 载入配置 ------------------------------
if [[ -f "$CONFIG_FILE" ]]; then
  log "载入配置 ${CONFIG_FILE#"$ROOT_DIR"/}"
  # shellcheck disable=SC1090
  set -a; source "$CONFIG_FILE"; set +a
else
  warn "未找到 ${CONFIG_FILE#"$ROOT_DIR"/}，将只使用环境变量与默认值"
  warn "建议：cp deploy/.env.deploy.example deploy/.env.deploy 并填写服务器信息"
fi

[[ -n "$MODE_OVERRIDE" ]] && DEPLOY_MODE="$MODE_OVERRIDE"

case "$DEPLOY_MODE" in
  docker|pm2) ;;
  *) die "DEPLOY_MODE 只能是 docker 或 pm2，当前为「${DEPLOY_MODE}」" 1 ;;
esac

[[ -n "$DEPLOY_HOST" ]] || die "未配置 DEPLOY_HOST（服务器地址）" 1

# ------------------------------ SSH / rsync 封装 ------------------------------
SSH_OPTS=(-p "$DEPLOY_PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=30)
[[ -n "$SSH_KEY" ]] && SSH_OPTS+=(-i "$SSH_KEY")
REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"

run_remote() {
  local desc="$1"; shift
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] ssh ${REMOTE} :: $desc"
    return 0
  fi
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "$REMOTE" "$@"
}

rsync_to() {
  local src="$1" dest="$2"; shift 2
  local rsync_opts=(-az --delete --info=progress2 -e "ssh ${SSH_OPTS[*]}")
  [[ "$DRY_RUN" == "1" ]] && rsync_opts+=(--dry-run)
  rsync "${rsync_opts[@]}" "$@" "${src}" "${REMOTE}:${dest}"
}

# 统一同步入口：优先 rsync（增量、可删多余文件）；没有 rsync 就用 tar over ssh。
# Windows 的 Git Bash 默认不带 rsync，这个兜底能让脚本在 Windows 上直接可用。
push_tree() {
  local src="$1" dest="$2"; shift 2
  if [[ "$USE_RSYNC" == "1" ]]; then
    rsync_to "$src" "$dest" "$@"
    return
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] tar over ssh: ${src} -> ${REMOTE}:${dest}"
    return
  fi
  run_remote "准备目标目录 ${dest}" "mkdir -p '${dest}'"
  # shellcheck disable=SC2086
  ( cd "$src" && tar czf - "$@" . ) | ssh "${SSH_OPTS[@]}" "$REMOTE" "tar xzf - -C '${dest}'"
}

# 需要随代码一起上服务器的内容（不含 node_modules / 运行时数据 / 源码构建中间产物）
BASE_EXCLUDES=(
  --exclude '.git'
  --exclude '.github'
  --exclude 'node_modules'
  --exclude '.npm-cache'
  --exclude '.npmrc'
  --exclude 'backend/data'
  --exclude 'tools/fixtures'
  --exclude '**/*.psd'
  --exclude '**/*.psb'
  --exclude '**/*.log'
  --exclude '.env'
  --exclude '.env.*'
  --exclude 'deploy/.env.deploy'
  --exclude '**/.DS_Store'
  --exclude 'Thumbs.db'
)

# ------------------------------ 0 · 本地预检 ------------------------------
step "0/6 本地预检"
for bin in node ssh tar; do
  command -v "$bin" >/dev/null 2>&1 || die "缺少命令：$bin" 1
done
NPM_BIN="$(command -v npm.cmd >/dev/null 2>&1 && echo npm.cmd || echo npm)"
command -v "$NPM_BIN" >/dev/null 2>&1 || die "缺少命令：npm（或 npm.cmd）" 1

USE_RSYNC=0
if command -v rsync >/dev/null 2>&1; then
  USE_RSYNC=1
else
  warn "未找到 rsync（Windows 的 Git Bash 默认不带），自动改用 tar over ssh 同步"
  warn "  影响：远端多余的旧文件不会被自动删除；如需增量同步请先安装 rsync"
fi
log "同步方式：$([[ "$USE_RSYNC" == "1" ]] && echo rsync || echo 'tar over ssh')"

log "目标：${REMOTE}:${DEPLOY_PORT}  目录 ${DEPLOY_PATH}  模式 ${DEPLOY_MODE}"

if [[ "$DRY_RUN" != "1" ]]; then
  ssh "${SSH_OPTS[@]}" "$REMOTE" 'echo ok' >/dev/null 2>&1 || die "无法通过 SSH 连接到 ${REMOTE}（检查 DEPLOY_HOST/USER/PORT/SSH_KEY 与防火墙）" 1
  ok "SSH 连通性正常"
else
  log "[dry-run] 跳过 SSH 连通性检查"
fi

# ------------------------------ 回滚分支 ------------------------------
do_rollback() {
  step "回滚"
  if [[ "$DEPLOY_MODE" == "pm2" ]]; then
    run_remote "切换到上一个 release 软链" bash -s <<EOF
set -euo pipefail
cd "${DEPLOY_PATH}"
prev="\$(ls -1dt releases/*/ 2>/dev/null | sed -n '2p' || true)"
if [[ -z "\$prev" ]]; then echo "没有可回滚的历史 release"; exit 3; fi
ln -sfn "\$(cd "\$prev" && pwd)" current.new && mv -Tf current.new current
echo "已切换到 \$prev"
EOF
    run_remote "重载 pm2" "pm2 reload ${PM2_APP_NAME} --update-env"
  else
    run_remote "把 :previous 镜像重新标记为 ${PSD_HUB_IMAGE}:${PSD_HUB_VERSION}" bash -s <<EOF
set -euo pipefail
docker image inspect "${PSD_HUB_IMAGE}:previous" >/dev/null 2>&1 || { echo "没有 :previous 镜像可回滚"; exit 3; }
docker tag "${PSD_HUB_IMAGE}:previous" "${PSD_HUB_IMAGE}:${PSD_HUB_VERSION}"
cd "${DEPLOY_PATH}" && docker compose up -d --no-build
echo "已回滚到 :previous"
EOF
  fi
  ok "回滚完成"
  exit 0
}
[[ "$ROLLBACK" == "1" ]] && do_rollback

# ------------------------------ 1 · 校验 ------------------------------
step "1/6 校验（类型检查 + 测试 + 构建）"
if [[ "$SKIP_BUILD" == "1" ]]; then
  warn "--skip-build：跳过校验与构建，直接使用现有 dist 产物"
else
  if [[ "$RUN_TESTS_BEFORE_DEPLOY" == "1" && "$SKIP_TESTS" != "1" ]]; then
    log "后端类型检查…"
    "$NPM_BIN" --prefix backend run typecheck || die "后端类型检查失败" 2
    log "后端测试…"
    "$NPM_BIN" --prefix backend test || die "后端测试失败" 2
    log "前端类型检查…"
    "$NPM_BIN" --prefix frontend run typecheck || die "前端类型检查失败" 2
    log "前端测试…"
    "$NPM_BIN" --prefix frontend test || die "前端测试失败" 2
    ok "校验全部通过"
  else
    warn "已跳过测试（--skip-tests 或 RUN_TESTS_BEFORE_DEPLOY=0）"
  fi

  log "构建前端静态产物…"
  "$NPM_BIN" --prefix frontend run build || die "前端构建失败" 2
  log "编译后端…"
  "$NPM_BIN" --prefix backend run build || die "后端构建失败" 2

  [[ -f "${ROOT_DIR}/backend/dist/index.js" ]] || die "未生成 backend/dist/index.js" 2
  [[ -f "${ROOT_DIR}/frontend/dist/index.html" ]] || die "未生成 frontend/dist/index.html" 2
  ok "构建完成"
fi

# ------------------------------ 2 · 准备目录 ------------------------------
step "2/6 准备服务器目录"
run_remote "创建部署目录" "mkdir -p '${DEPLOY_PATH}/releases' '${DEPLOY_PATH}/shared'"

if [[ "$DEPLOY_MODE" == "pm2" ]]; then
  run_remote "确保数据与日志目录存在" bash -s <<EOF
set -euo pipefail
sudo mkdir -p /var/lib/psd-hub /var/log/psd-hub "\$(dirname '${REMOTE_ENV_FILE}')"
sudo chown -R '${DEPLOY_USER}':'${DEPLOY_USER}' /var/lib/psd-hub /var/log/psd-hub 2>/dev/null || true
if [[ ! -f '${REMOTE_ENV_FILE}' ]]; then
  echo "警告：${REMOTE_ENV_FILE} 不存在，请参考 deploy/systemd/psd-hub.env.example 创建（含 DATA_DIR/令牌等）"
fi
EOF
fi

RELEASE_ID="$(date -u +%Y%m%d%H%M%S)"
RELEASE_DIR="${DEPLOY_PATH}/releases/${RELEASE_ID}"
log "本次 release：${RELEASE_ID}"

# ------------------------------ 3 · 推送代码 ------------------------------
step "3/6 推送代码到服务器"
if [[ "$DEPLOY_MODE" == "docker" ]]; then
  push_tree "${ROOT_DIR}/" "${DEPLOY_PATH}/" "${BASE_EXCLUDES[@]}"
  # 生产环境变量文件放在仓库根（compose 自动读取）
  if [[ ! -f "${ROOT_DIR}/.env" ]]; then
    warn "本地没有 .env；服务器上需要已存在 ${DEPLOY_PATH}/.env，否则 compose up 会因缺少 env_file 失败"
  else
    push_tree "${ROOT_DIR}/" "${DEPLOY_PATH}/" --exclude '*' --include '.env'
    log "已单独同步 .env（含令牌等机密，请确认远端权限为 600）"
  fi
else
  push_tree "${ROOT_DIR}/" "${RELEASE_DIR}/" "${BASE_EXCLUDES[@]}"
fi
ok "代码已同步"

# ------------------------------ 4 · 起服务 ------------------------------
step "4/6 启动 / 重载服务"
if [[ "$DEPLOY_MODE" == "docker" ]]; then
  run_remote "docker compose 构建并启动" bash -s <<EOF
set -euo pipefail
cd '${DEPLOY_PATH}'
if [[ ! -f .env ]]; then echo "缺少 ${DEPLOY_PATH}/.env，请先创建（可参考 deploy/env.example）"; exit 3; fi
# 保留上一版镜像用于回滚
if docker image inspect '${PSD_HUB_IMAGE}:${PSD_HUB_VERSION}' >/dev/null 2>&1; then
  docker tag '${PSD_HUB_IMAGE}:${PSD_HUB_VERSION}' '${PSD_HUB_IMAGE}:previous'
fi
PSD_HUB_VERSION='${PSD_HUB_VERSION}' docker compose build --pull
PSD_HUB_VERSION='${PSD_HUB_VERSION}' docker compose up -d --remove-orphans
docker image prune -f --filter 'label=com.docker.compose.project=psd-hub' >/dev/null 2>&1 || true
EOF
else
  run_remote "安装生产依赖" bash -s <<EOF
set -euo pipefail
cd '${RELEASE_DIR}/backend'
if [[ -f package-lock.json ]]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi
EOF
  run_remote "切换 current 软链并重载 pm2" bash -s <<EOF
set -euo pipefail
cd '${DEPLOY_PATH}'
ln -sfn '${RELEASE_DIR}' current.new && mv -Tf current.new current
cd current
# 环境变量：优先用独立 env 文件；没有就靠 ecosystem 里的默认值
if [[ -f '${REMOTE_ENV_FILE}' ]]; then
  set -a; source '${REMOTE_ENV_FILE}'; set +a
fi
if pm2 describe '${PM2_APP_NAME}' >/dev/null 2>&1; then
  pm2 reload '${PM2_APP_NAME}' --update-env
else
  pm2 start deploy/pm2/ecosystem.config.cjs --update-env
fi
pm2 save >/dev/null
EOF
fi
ok "服务已重载"

# ------------------------------ 5 · 健康检查 ------------------------------
step "5/6 健康检查"
if [[ "$SKIP_HEALTHCHECK" == "1" ]]; then
  warn "已跳过健康检查（--no-healthcheck）"
elif [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] 跳过健康检查"
else
  healthy=0
  for attempt in $(seq 1 "$HEALTH_RETRIES"); do
    if run_remote "健康检查尝试 ${attempt}/${HEALTH_RETRIES}" \
        "curl -fsS --max-time 5 'http://127.0.0.1:${APP_PORT}${HEALTH_PATH}'"; then
      healthy=1
      break
    fi
    log "第 ${attempt} 次未通过，${HEALTH_DELAY}s 后重试…"
    sleep "$HEALTH_DELAY"
  done

  if [[ "$healthy" != "1" ]]; then
    warn "健康检查失败，尝试自动回滚…"
    if [[ "$DEPLOY_MODE" == "pm2" ]]; then
      run_remote "回滚软链" bash -s <<EOF
set -euo pipefail
cd '${DEPLOY_PATH}'
prev="\$(ls -1dt releases/*/ 2>/dev/null | sed -n '2p' || true)"
if [[ -n "\$prev" ]]; then ln -sfn "\$(cd "\$prev" && pwd)" current.new && mv -Tf current.new current && pm2 reload '${PM2_APP_NAME}' --update-env; fi
EOF
    else
      run_remote "回滚镜像" bash -s <<EOF
set -euo pipefail
cd '${DEPLOY_PATH}'
if docker image inspect '${PSD_HUB_IMAGE}:previous' >/dev/null 2>&1; then
  docker tag '${PSD_HUB_IMAGE}:previous' '${PSD_HUB_IMAGE}:${PSD_HUB_VERSION}'
  docker compose up -d --no-build
fi
EOF
    fi
    if [[ "$DEPLOY_MODE" == "docker" ]]; then
      warn "排查：ssh ${REMOTE} 'cd ${DEPLOY_PATH} && docker compose logs --tail=100 psd-hub'"
    else
      warn "排查：ssh ${REMOTE} 'pm2 logs ${PM2_APP_NAME} --lines 100'"
    fi
    die "健康检查失败（已尝试自动回滚）" 4
  fi
  ok "健康检查通过"
fi

# ------------------------------ 6 · 清理 ------------------------------
step "6/6 清理历史版本"
if [[ "$DEPLOY_MODE" == "pm2" ]]; then
  run_remote "保留最近 ${KEEP_RELEASES} 个 release" bash -s <<EOF
set -euo pipefail
cd '${DEPLOY_PATH}/releases' || exit 0
current_target="\$(readlink -f '${DEPLOY_PATH}/current' || true)"
count=0
for dir in \$(ls -1dt */ 2>/dev/null); do
  abs="\$(cd "\$dir" && pwd)"
  [[ "\$abs" == "\$current_target" ]] && continue
  count=\$((count + 1))
  if (( count > ${KEEP_RELEASES} )); then rm -rf "\$abs"; echo "已清理 \$abs"; fi
done
EOF
else
  run_remote "清理悬空镜像" "docker image prune -f" || warn "镜像清理失败（可忽略）"
fi

printf '\n%s✔ 部署完成%s  release=%s  模式=%s\n' "$C_OK" "$C_RESET" "$RELEASE_ID" "$DEPLOY_MODE"
log "站点入口： http://${DEPLOY_HOST}$([[ "$APP_PORT" != "80" ]] && echo ":${APP_PORT}")/"
log "查看日志： $([[ "$DEPLOY_MODE" == "docker" ]] && echo "ssh ${REMOTE} 'cd ${DEPLOY_PATH} && docker compose logs -f psd-hub'" || echo "ssh ${REMOTE} 'pm2 logs ${PM2_APP_NAME}'")"
