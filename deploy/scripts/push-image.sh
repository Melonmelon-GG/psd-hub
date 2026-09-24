#!/usr/bin/env bash
# =============================================================================
# PSD 展示台 · 构建并推送镜像到镜像仓库
#
#   bash deploy/scripts/push-image.sh                          # 用 deploy/.env.deploy 的配置
#   bash deploy/scripts/push-image.sh --tag v1.2.0             # 指定版本标签
#   bash deploy/scripts/push-image.sh --registry registry.cn-hangzhou.aliyuncs.com/ns --no-push
#   bash deploy/scripts/push-image.sh --platforms linux/amd64  # 只构建 amd64（更快）
#
# 默认构建 linux/amd64 + linux/arm64 并推送。
# 服务器拉取请用 deploy/scripts/deploy.sh 或 docker compose pull。
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
log()  { printf '%s[push]%s %s\n' "$C_INFO" "$C_RESET" "$*"; }
ok()   { printf '%s[ ok ]%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
die()  { printf '%s[fail]%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; exit 1; }

# ------------------------------ 默认值 ------------------------------
REGISTRY="${REGISTRY:-}"
IMAGE_NAME="${PSD_HUB_IMAGE:-psd-hub}"
TAG="${PSD_HUB_VERSION:-}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
PUSH=1
LOAD=0
DOCKERFILE="deploy/docker/Dockerfile"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry) REGISTRY="${2:?--registry 需要参数}"; shift 2 ;;
    --image) IMAGE_NAME="${2:?--image 需要参数}"; shift 2 ;;
    --tag) TAG="${2:?--tag 需要参数}"; shift 2 ;;
    --platforms) PLATFORMS="${2:?--platforms 需要参数}"; shift 2 ;;
    --dockerfile) DOCKERFILE="${2:?--dockerfile 需要参数}"; shift 2 ;;
    --no-push) PUSH=0; shift ;;
    --load) LOAD=1; PUSH=0; shift ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

# 载入配置（CLI 参数优先，所以只在未显式设置时读取）
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$CONFIG_FILE"; set +a
  [[ -n "$REGISTRY" ]] || REGISTRY="${REGISTRY:-}"
  [[ -n "$TAG" ]] || TAG="${PSD_HUB_VERSION:-}"
  IMAGE_NAME="${IMAGE_NAME:-${PSD_HUB_IMAGE:-psd-hub}}"
fi

# 标签兜底：优先 git describe，其次日期时间
if [[ -z "$TAG" ]]; then
  if git -C "$ROOT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
    TAG="$(git -C "$ROOT_DIR" describe --tags --always --dirty 2>/dev/null || true)"
  fi
  [[ -n "$TAG" ]] || TAG="$(date -u +%Y%m%d-%H%M%S)"
fi

# 组装完整镜像名
if [[ -n "$REGISTRY" ]]; then
  FULL_IMAGE="${REGISTRY%/}/${IMAGE_NAME}"
else
  FULL_IMAGE="$IMAGE_NAME"
  [[ "$PUSH" == "1" ]] && warn "未指定 --registry，将尝试推送到默认 Docker Hub 仓库"
fi

log "镜像：   ${FULL_IMAGE}:${TAG}"
log "平台：   ${PLATFORMS}"
log "Dockerfile： ${DOCKERFILE}"
log "推送：   $([[ "$PUSH" == "1" ]] && echo 是 || echo 否)"

# ------------------------------ 预检 ------------------------------
command -v docker >/dev/null 2>&1 || die "未找到 docker"
docker info >/dev/null 2>&1 || die "docker 守护进程不可用（Docker Desktop 没启动？）"
[[ -f "${ROOT_DIR}/${DOCKERFILE}" ]] || die "找不到 ${ROOT_DIR}/${DOCKERFILE}"

if [[ "$PUSH" == "1" ]]; then
  log "校验仓库登录状态…"
  if ! docker system info --format '{{json .RegistryConfig.IndexConfigs}}' >/dev/null 2>&1; then
    warn "无法确认登录状态；推送失败请先执行：docker login ${REGISTRY:-docker.io}"
  fi
fi

# ------------------------------ 构建 ------------------------------
command -v docker-buildx >/dev/null 2>&1 || true
if ! docker buildx version >/dev/null 2>&1; then
  die "需要 docker buildx（多架构构建）。Docker Desktop 自带；Linux 上请安装 docker-buildx-plugin"
fi

BUILDER="psd-hub-builder"
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  log "创建 buildx builder：${BUILDER}"
  docker buildx create --name "$BUILDER" --driver docker-container --use >/dev/null
else
  docker buildx use "$BUILDER" >/dev/null
fi
docker buildx inspect --bootstrap >/dev/null

BUILD_ARGS=(
  --file "${ROOT_DIR}/${DOCKERFILE}"
  --platform "$PLATFORMS"
  --tag "${FULL_IMAGE}:${TAG}"
  --tag "${FULL_IMAGE}:latest"
  --label "org.opencontainers.image.title=psd-hub"
  --label "org.opencontainers.image.version=${TAG}"
  --label "org.opencontainers.image.source=$(git -C "$ROOT_DIR" config --get remote.origin.url 2>/dev/null || echo 'local')"
  --label "org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  --provenance=false
  --cache-from "type=registry,ref=${FULL_IMAGE}:buildcache"
  --cache-to "type=registry,ref=${FULL_IMAGE}:buildcache,mode=max"
)

if [[ "$PUSH" == "1" ]]; then
  BUILD_ARGS+=(--push)
elif [[ "$LOAD" == "1" ]]; then
  BUILD_ARGS+=(--load)
fi

log "开始构建（首次构建需要下载基础镜像，可能较慢）…"
docker buildx build "${BUILD_ARGS[@]}" "$ROOT_DIR"

ok "构建完成：${FULL_IMAGE}:${TAG}"

if [[ "$PUSH" == "1" ]]; then
  log "远端镜像摘要："
  docker buildx imagetools inspect "${FULL_IMAGE}:${TAG}" | sed 's/^/  /' || true
  cat <<EOF

下一步在服务器上使用该镜像：
  # 服务器 .env 里写上镜像名（compose 会优先用 .env 的值）
  PSD_HUB_IMAGE=${FULL_IMAGE}
  PSD_HUB_VERSION=${TAG}
  # 然后
  cd /opt/psd-hub && docker compose pull psd-hub && docker compose up -d --no-build psd-hub

或者直接本地一键部署：
  bash deploy/scripts/deploy.sh --mode docker
EOF
fi
