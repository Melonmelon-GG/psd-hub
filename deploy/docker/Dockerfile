# =============================================================================
# PSD 展示台 · 生产镜像（三阶段构建）
#
# 构建（在仓库根目录执行，构建上下文必须是仓库根）：
#   docker build -f deploy/docker/Dockerfile -t psd-hub:1.0.0 .
#
# 最终镜像只包含：后端编译产物 + 生产依赖 + 前端静态产物，单个进程同时提供
# API 与页面（SERVE_STATIC=true），因此可以极简部署（一个容器 + 一个卷）。
# =============================================================================

# -----------------------------------------------------------------------------
# 阶段 1 · 构建前端静态站点
# -----------------------------------------------------------------------------
FROM node:24-alpine AS web-build
WORKDIR /build/frontend

# 构建期变量：前端要被挂在哪个子路径下（例如 /psd/），以及要调用的 API 前缀。
# 默认值 = 挂在根、同源 API（本地与独立部署的行为，与 v2.0 一致）。
# docker-compose 会从 .env 读 VITE_BASE_PATH / VITE_API_BASE 传进来。
ARG VITE_BASE_PATH=/
ARG VITE_API_BASE=
ENV VITE_BASE_PATH=${VITE_BASE_PATH}
ENV VITE_API_BASE=${VITE_API_BASE}

# 先只拷贝清单文件，命中 Docker 层缓存
COPY frontend/package.json frontend/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

COPY frontend/ ./
RUN npm run build


# -----------------------------------------------------------------------------
# 阶段 2 · 编译后端 TypeScript
# -----------------------------------------------------------------------------
FROM node:24-alpine AS api-build
WORKDIR /build/backend

COPY backend/package.json backend/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

COPY backend/ ./
RUN npm run build


# -----------------------------------------------------------------------------
# 阶段 3 · 只装生产依赖（体积最小化）
# -----------------------------------------------------------------------------
FROM node:24-alpine AS api-deps
WORKDIR /build/backend

COPY backend/package.json backend/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi \
    && npm cache clean --force


# -----------------------------------------------------------------------------
# 阶段 4 · 运行时
# -----------------------------------------------------------------------------
FROM node:24-alpine AS runtime

# tini 负责正确转发信号（配合后端的 SIGTERM 优雅关闭）
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    DATA_DIR=/data \
    SERVE_STATIC=true \
    STATIC_DIR=/app/public \
    TRUST_PROXY=1 \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app

COPY --from=api-deps  /build/backend/node_modules ./node_modules
COPY --from=api-build /build/backend/dist         ./dist
COPY --from=api-build /build/backend/package.json ./package.json
COPY --from=web-build /build/frontend/dist        ./public

# 运行时数据目录（PSD 工程、PNG、db.json）——务必挂卷持久化
RUN mkdir -p /data && chown -R node:node /app /data
VOLUME ["/data"]

USER node
EXPOSE 4000

# 用 Node 自带的 fetch 做健康检查，避免额外安装 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
