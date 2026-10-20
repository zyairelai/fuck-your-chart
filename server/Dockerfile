FROM node:22-slim AS deps
WORKDIR /repo
COPY server/package.json ./server-package.json
COPY web/package.json ./web-package.json
RUN mkdir -p server web \
 && cp server-package.json server/package.json \
 && cp web-package.json web/package.json \
 && npm install --prefix server --include=dev \
 && npm install --prefix web --include=dev

FROM node:22-slim AS build-server
WORKDIR /repo
COPY --from=deps /repo/server/node_modules ./server/node_modules
COPY server/ ./server/
RUN npm run build --prefix server

FROM node:22-slim AS build-web
WORKDIR /repo
COPY --from=deps /repo/web/node_modules ./web/node_modules
COPY web/ ./web/
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build --prefix web

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# Express server runtime + compiled bundle
COPY --from=build-server /repo/server/dist ./dist
COPY server/package.json ./package.json
COPY --from=build-server /repo/server/node_modules ./node_modules
# Static Next.js export (output: "export" -> /repo/web/out)
COPY --from=build-web /repo/web/out ./web/out
EXPOSE 8000
CMD ["node", "dist/index.js"]
