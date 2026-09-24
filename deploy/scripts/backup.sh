#!/usr/bin/env bash
# =============================================================================
# PSD 展示台 · 数据备份
#
#   bash deploy/scripts/backup.sh                       # 备份本地 DATA_DIR
#   bash deploy/scripts/backup.sh --docker              # 备份 docker 卷 psd-hub_psd-data
#   bash deploy/scripts/backup.sh --remote user@host:/backups    # 额外用 ssh 传到异地
#   bash deploy/scripts/backup.sh --keep 30             # 保留最近 30 份（默认 14）
#   bash deploy/scripts/backup.sh --dry-run             # 只打印将要做什么
#
# 备份内容：db.json + projects/<id>/{original.psd|psb, preview.png, meta.json}
# 归档为 tar.gz，并在结束后校验归档完整性（tar -tzf）。
#
# 建议加进服务器 crontab（每天凌晨 3:30）：
#   30 3 * * * cd /opt/psd-hub && bash deploy/scripts/backup.sh --docker --keep 14 \
#              >> /var/log/psd-hub/backup.log 2>&1
#
# 注意：PSD 文件动辄几百 MB，备份会占用可观磁盘。若数据量很大，
# 建议改用对象存储（STORAGE_DRIVER=s3）+ 版本化，本地只做元数据备份。
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CONFIG_FILE="${ROOT_DIR}/deploy/.env.deploy"

if [[ -t 1 ]]; then
  C_INFO=$'\033[36m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_RESET=$'\033[0m'
else
  C_INFO=''; C_OK=''; C_WARN=''; C_ERR=''; C_RESET=''
fi
log()  { printf '%s[backup]%s %s\n' "$C_INFO" "$C_RESET" "$*"; }
ok()   { printf '%s[  ok  ]%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '%s[ warn ]%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
die()  { printf '%s[ fail ]%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; exit 1; }

# ------------------------------ 默认值 ------------------------------
MODE="local"                 # local | docker
DATA_DIR="${DATA_DIR:-}"
BACKUP_DIR="${BACKUP_DIR:-}"
KEEP="${KEEP:-14}"
REMOTE=""
DRY_RUN=0
COMPOSE_PROJECT="${COMPOSE_PROJECT:-psd-hub}"
VOLUME_NAME="${VOLUME_NAME:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --docker) MODE="docker"; shift ;;
    --local) MODE="local"; shift ;;
    --data-dir) DATA_DIR="${2:?--data-dir 需要参数}"; shift 2 ;;
    --out) BACKUP_DIR="${2:?--out 需要参数}"; shift 2 ;;
    --keep) KEEP="${2:?--keep 需要参数}"; shift 2 ;;
    --remote) REMOTE="${2:?--remote 需要参数}"; shift 2 ;;
    --volume) VOLUME_NAME="${2:?--volume 需要参数}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$CONFIG_FILE"; set +a
fi

[[ -n "$BACKUP_DIR" ]] || BACKUP_DIR="${ROOT_DIR}/backups"
[[ -n "$DATA_DIR" ]] || DATA_DIR="/var/lib/psd-hub"
[[ -n "$VOLUME_NAME" ]] || VOLUME_NAME="${COMPOSE_PROJECT}_psd-data"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
ARCHIVE_NAME="psd-hub-${STAMP}.tar.gz"
ARCHIVE_PATH="${BACKUP_DIR}/${ARCHIVE_NAME}"

log "模式：      $MODE"
log "备份目录：  $BACKUP_DIR"
log "保留份数：  $KEEP"
[[ -n "$REMOTE" ]] && log "异地副本：  $REMOTE"

if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] 将执行："
  log "  mkdir -p '$BACKUP_DIR'"
  if [[ "$MODE" == "docker" ]]; then
    log "  docker run --rm -v '${VOLUME_NAME}:/data:ro' -v '${BACKUP_DIR}:/backup' alpine tar czf '/backup/${ARCHIVE_NAME}' -C /data ."
  else
    log "  tar czf '${ARCHIVE_PATH}' -C '$DATA_DIR' ."
  fi
  log "  tar tzf '${ARCHIVE_PATH}' | tail -1        # 完整性校验"
  log "  清理 ${BACKUP_DIR} 中除最近 ${KEEP} 份以外的归档"
  exit 0
fi

command -v tar >/dev/null 2>&1 || die "未找到 tar"
mkdir -p "$BACKUP_DIR"

# ------------------------------ 打包 ------------------------------
if [[ "$MODE" == "docker" ]]; then
  command -v docker >/dev/null 2>&1 || die "--docker 模式需要 docker"
  if ! docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
    warn "卷 $VOLUME_NAME 不存在，列出当前所有卷供排查："
    docker volume ls | sed 's/^/    /'
    die "请用 --volume 指定正确的卷名"
  fi
  log "备份 Docker 卷 ${VOLUME_NAME} …"
  docker run --rm \
    -v "${VOLUME_NAME}:/data:ro" \
    -v "${BACKUP_DIR}:/backup" \
    alpine:3.20 \
    tar czf "/backup/${ARCHIVE_NAME}" -C /data .
else
  [[ -d "$DATA_DIR" ]] || die "数据目录不存在：$DATA_DIR"
  log "备份目录 ${DATA_DIR} …"
  tar czf "$ARCHIVE_PATH" -C "$DATA_DIR" .
fi

[[ -f "$ARCHIVE_PATH" ]] || die "归档未生成：$ARCHIVE_PATH"

# ------------------------------ 校验 ------------------------------
log "校验归档完整性…"
if ! tar tzf "$ARCHIVE_PATH" >/dev/null 2>&1; then
  die "归档损坏：$ARCHIVE_PATH（请勿删除源数据！）"
fi
ENTRIES="$(tar tzf "$ARCHIVE_PATH" | wc -l | tr -d ' ')"
SIZE="$(du -h "$ARCHIVE_PATH" | cut -f1)"
ok "归档可用：${ARCHIVE_NAME}  条目 ${ENTRIES}  大小 ${SIZE}"

# 顺手校验关键文件是否在内
if tar tzf "$ARCHIVE_PATH" | grep -q '^\./db\.json$'; then
  ok "包含 db.json（元数据库）"
else
  warn "归档里没有 db.json —— 如果这是全新空站点可以忽略；否则请检查 DATA_DIR 是否正确"
fi

# ------------------------------ 异地副本 ------------------------------
if [[ -n "$REMOTE" ]]; then
  log "传输到 ${REMOTE} …"
  if command -v rsync >/dev/null 2>&1; then
    rsync -az --info=progress2 "$ARCHIVE_PATH" "${REMOTE%/}/"
  else
    scp "$ARCHIVE_PATH" "${REMOTE%/}/"
  fi
  ok "异地副本完成"
fi

# ------------------------------ 清理旧备份 ------------------------------
log "清理旧归档（保留最近 ${KEEP} 份）…"
# shellcheck disable=SC2012
mapfile -t OLD < <(ls -1t "${BACKUP_DIR}"/psd-hub-*.tar.gz 2>/dev/null | tail -n "+$((KEEP + 1))" || true)
if [[ "${#OLD[@]}" -gt 0 ]]; then
  for f in "${OLD[@]}"; do
    rm -f "$f"
    log "  已删除 $(basename "$f")"
  done
else
  log "  无需清理"
fi

ok "备份完成：${ARCHIVE_PATH}"
cat <<EOF

恢复方法（务必先停服务，避免写到一半的数据文件被覆盖）：
  # docker 模式
  docker compose stop psd-hub
  docker run --rm -v ${VOLUME_NAME}:/data -v ${BACKUP_DIR}:/backup alpine:3.20 \\
      sh -c "rm -rf /data/* && tar xzf /backup/${ARCHIVE_NAME} -C /data"
  docker compose start psd-hub

  # local 模式
  systemctl stop psd-hub
  rm -rf ${DATA_DIR}/* && tar xzf ${ARCHIVE_PATH} -C ${DATA_DIR}
  systemctl start psd-hub

恢复后建议跑一次健康检查与端到端冒烟：
  node tools/smoke-e2e.mjs --base http://127.0.0.1:4000 --no-spawn
EOF
