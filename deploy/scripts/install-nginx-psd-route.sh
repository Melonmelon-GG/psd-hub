#!/usr/bin/env bash
#
# 在主站 nginx 配置里为 PSD 展示台挂上 /psd/ 子路径（幂等 + 带备份 + 失败自动回滚）
#
# 为什么要改主站配置：nginx 不允许在 server 块之外声明 location，
# 所以要把 `location ^~ /psd/` 插进 scvg.conf 里那个 server_name 7thcv.cn 的 server 块。
# 因此本脚本对生产配置做了三件保命的事：
#   1. 改之前先备份（带时间戳）
#   2. 改完先 `nginx -t` 校验，不通过立刻还原备份并退出非 0
#   3. 只在配置里**没有**该 location 时才插入（可重复执行）
#
# 用法（在服务器上执行）：
#   bash /tmp/install-nginx-psd-route.sh
#   BACKEND_PORT=4100 MOUNT_PATH=/psd/ bash /tmp/install-nginx-psd-route.sh
#
set -euo pipefail

CONF="${CONF:-/etc/nginx/conf.d/scvg.conf}"
MOUNT_PATH="${MOUNT_PATH:-/psd/}"
BACKEND_PORT="${BACKEND_PORT:-4100}"
SERVER_NAME="${SERVER_NAME:-7thcv.cn}"

log() { printf '[nginx-route] %s\n' "$*"; }
die() { printf '[nginx-route][fail] %s\n' "$*" >&2; exit 1; }

[[ -f "$CONF" ]] || die "找不到配置文件：$CONF"
command -v nginx >/dev/null 2>&1 || die "未安装 nginx"

# ---------------------------------------------------------------- 幂等检查
if grep -qF "location ^~ ${MOUNT_PATH}" "$CONF"; then
  log "配置里已存在 location ^~ ${MOUNT_PATH}，无需改动。"
  nginx -t
  exit 0
fi

# ---------------------------------------------------------------- 备份
STAMP="$(date +%Y%m%d%H%M%S)"
BACKUP="${CONF}.bak.${STAMP}"
cp -a "$CONF" "$BACKUP"
log "已备份：$BACKUP"

restore_and_die() {
  cp -a "$BACKUP" "$CONF"
  log "已回滚到备份：$BACKUP"
  die "$1"
}

# ---------------------------------------------------------------- 插入
# 插入锚点：server 块里「缓存配置」注释之前。
# 选这里是因为它位于所有 location 之前，且 ^~ 前缀匹配本就不受位置影响，
# 放前面能让「这条优先于下面的正则 location」这个意图一目了然。
ANCHOR='# 缓存配置'
if ! grep -qF "$ANCHOR" "$CONF"; then
  die "找不到插入锚点「${ANCHOR}」，请手工确认配置文件结构后调整锚点"
fi

BLOCK_FILE="$(mktemp)"
cat > "$BLOCK_FILE" <<EOF
    # ===== PSD 展示台（柒世纪视频组平面工程分享平台）=====
    # 挂在 ${MOUNT_PATH} 子路径下，与主站同源 → 复用主站证书，登录密码因此不必走明文 HTTP。
    # 用 ^~ 前缀匹配：确保它优先于下面的正则 location，
    # 否则 ${MOUNT_PATH}assets/xxx.js 会被那条 \.(js|css|...)\$ 的正则抢走。
    # 应用自身配置了 MOUNT_PREFIX（见 /opt/psd-hub/.env），会自己剥掉该前缀，
    # 所以这里 proxy_pass **不加尾斜杠**，原样转发。
    location ^~ ${MOUNT_PATH} {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }

EOF

# 用 awk 在锚点行之前插入，避免 sed 处理多行内容的转义地狱
awk -v anchor="$ANCHOR" -v blockfile="$BLOCK_FILE" '
  !done && index($0, anchor) { while ((getline line < blockfile) > 0) print line; done = 1 }
  { print }
' "$CONF" > "${CONF}.new"

mv "${CONF}.new" "$CONF"
log "已插入 location ^~ ${MOUNT_PATH} → 127.0.0.1:${BACKEND_PORT}"

# ---------------------------------------------------------------- 校验
if ! nginx -t 2>&1; then
  restore_and_die "nginx -t 校验失败"
fi
log "nginx -t 通过"

# ---------------------------------------------------------------- 生效
if ! systemctl reload nginx; then
  restore_and_die "nginx reload 失败"
fi
log "nginx 已重载"

# ---------------------------------------------------------------- 自检
sleep 1
CODE_LOCAL="$(curl -sS -o /dev/null -w '%{http_code}' -m 8 "http://127.0.0.1:${BACKEND_PORT}${MOUNT_PATH}api/health" || echo 000)"
CODE_PUBLIC="$(curl -skS -o /dev/null -w '%{http_code}' -m 8 -H "Host: ${SERVER_NAME}" "https://127.0.0.1${MOUNT_PATH}api/health" || echo 000)"
CODE_MAIN="$(curl -skS -o /dev/null -w '%{http_code}' -m 8 -H "Host: ${SERVER_NAME}" "https://127.0.0.1/" || echo 000)"

log "自检："
log "  容器直连   http://127.0.0.1:${BACKEND_PORT}${MOUNT_PATH}api/health  → ${CODE_LOCAL}"
log "  经 nginx   https://${SERVER_NAME}${MOUNT_PATH}api/health            → ${CODE_PUBLIC}"
log "  主站首页   https://${SERVER_NAME}/                                 → ${CODE_MAIN}（应与改动前一致）"

[[ "$CODE_PUBLIC" == "200" ]] || restore_and_die "经 nginx 访问 ${MOUNT_PATH} 未返回 200（实际 ${CODE_PUBLIC}）"
[[ "$CODE_MAIN" =~ ^(200|301|302)$ ]] || restore_and_die "主站首页异常（实际 ${CODE_MAIN}），疑似影响了现有站点"

log "完成。备份保留在：$BACKUP"
