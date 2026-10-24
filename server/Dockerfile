# syntax=docker/dockerfile:1.4
#
# npm uses a cache mount so tarballs are reused across builds. Layer cache
# still applies: if package.json is unchanged, the whole RUN is skipped.

FROM node:22-slim AS deps
WORKDIR /repo
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json
RUN --mount=type=cache,target=/root/.npm \
    npm install --prefix server --include=dev --prefer-offline --no-audit --no-fund \
 && npm install --prefix web --include=dev --prefer-offline --no-audit --no-fund

FROM node:22-slim AS build-server
WORKDIR /repo/server
COPY --from=deps /repo/server/node_modules ./node_modules
COPY server/ ./
RUN npm run build

FROM node:22-slim AS build-web
WORKDIR /repo/web
COPY --from=deps /repo/web/node_modules ./node_modules
COPY web/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN --mount=type=cache,target=/repo/web/.next/cache \
    npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build-server /repo/server/dist ./dist
COPY server/package.json ./package.json
COPY --from=deps /repo/server/node_modules ./node_modules
COPY --from=build-web /repo/web/out ./web/out
EXPOSE 8000
CMD ["node", "dist/index.js"]
