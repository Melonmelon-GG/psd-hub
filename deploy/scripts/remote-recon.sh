#!/usr/bin/env bash
#
# 部署前服务器审计（只读，不做任何修改）
#
#   本地执行： bash deploy/scripts/remote-recon.sh root@7thcv.cn
#   或手动：   ssh root@7thcv.cn 'bash -s' < deploy/scripts/remote-recon.sh
#
# 为什么需要它：部署脚本会创建目录、装依赖、占端口。在一台"可能已经跑着别的站点"
# 的服务器上直接部署是危险的，先看清现状再说。
#
# ⚠️ 本脚本刻意只输出 ASCII：远端输出经 SSH 回到 Windows 控制台时，
#    中文很容易因为代码页问题变成乱码，反而干扰判断。
set -uo pipefail

TARGET="${1:-root@7thcv.cn}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

run() {
  if [[ -n "${SSH_CONNECTION:-}" || "$(uname -s)" == Linux* ]]; then
    # 已经在远端执行
    bash -s
  else
    ssh -o BatchMode=yes -o ConnectTimeout=12 "$TARGET" 'bash -s'
  fi
}

run <<'REMOTE'
echo "===== SYSTEM ====="
grep -E '^(NAME|VERSION)=' /etc/os-release
echo "kernel: $(uname -r)   arch: $(uname -m)"
echo "cpu: $(nproc) cores"
free -h | head -2
echo "--- disk ---"
df -h / | tail -1

echo
echo "===== RUNTIMES INSTALLED ====="
for c in docker node npm nginx git rsync curl pm2 python3; do
  if command -v "$c" >/dev/null 2>&1; then
    printf "  %-8s %s\n" "$c" "$("$c" --version 2>&1 | head -1)"
  else
    printf "  %-8s NOT INSTALLED\n" "$c"
  fi
done
printf "  %-8s %s\n" "compose" "$(docker compose version 2>/dev/null | head -1 || echo none)"

echo
echo "===== LISTENING PORTS ====="
ss -tlnp 2>/dev/null | awk 'NR==1 || /LISTEN/'

echo
echo "===== RELEVANT RUNNING SERVICES ====="
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null \
  | grep -Ei 'nginx|apache|httpd|docker|node|pm2|caddy|mysql|postgres|redis' || echo "  none"

echo
echo "===== EXISTING WEB SITE TRACES ====="
for d in /etc/nginx/sites-enabled /etc/nginx/conf.d /var/www /opt /srv; do
  echo "--- $d ---"
  ls -la "$d" 2>/dev/null || echo "  missing"
done
echo "--- /root ---"
ls -la /root 2>/dev/null | head -20

echo
echo "===== DOCKER CONTAINERS ====="
docker ps -a --format '  {{.Names}}  {{.Image}}  {{.Status}}  {{.Ports}}' 2>/dev/null || echo "  docker unavailable"

echo
echo "===== FIREWALL ====="
ufw status 2>/dev/null | head -10 || echo "  no ufw"
iptables -L INPUT -n 2>/dev/null | head -6 || true

echo
echo "===== EXISTING HTTP RESPONSE ====="
curl -sS -o /dev/null -w "  http  127.0.0.1:80  -> %{http_code}\n" -m 8 http://127.0.0.1/ 2>&1 || echo "  http -> no response"
curl -skS -o /dev/null -w "  https 127.0.0.1:443 -> %{http_code}\n" -m 8 https://127.0.0.1/ 2>&1 || echo "  https -> no response"
echo "--- first bytes of whatever is on :80 ---"
curl -sS -m 8 http://127.0.0.1/ 2>/dev/null | head -c 400 || echo "  (nothing)"
echo
echo "--- who owns :80 / :443 ---"
ss -tlnp 2>/dev/null | grep -E ':(80|443) ' || echo "  nothing listening on 80/443"

echo
echo "===== LETSENCRYPT CERTS ====="
ls -la /etc/letsencrypt/live/ 2>/dev/null || echo "  no letsencrypt certs"

echo
echo "===== TIMEZONE / TIME ====="
timedatectl 2>/dev/null | head -4 || date
REMOTE
