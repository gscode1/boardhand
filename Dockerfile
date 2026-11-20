# One image, three programs: the worker (default), the board server and the board's UI.
#   worker: node dist/main.js
#   board:  node dist/server/main.js
#   ui:     node dist/server/inspect.js
# It runs as uid 10001 and writes nowhere by itself, so a read-only root filesystem works; mount emptyDirs or volumes
# where a program writes (the worker's BOARDHAND_STATE_DIR, the board's BOARD_DATA_DIR, /tmp).

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
# Dependencies first, so source changes do not reinstall them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json tsconfig.server.json ./
COPY src ./src
COPY server ./server
RUN pnpm build && pnpm prune --prod

FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/gscode1/boardhand" \
      org.opencontainers.image.description="boardhand: workers that run vercel/board tasks on coding-agent backends, and the board server" \
      org.opencontainers.image.licenses="MIT"
RUN addgroup -g 10001 boardhand && adduser -D -u 10001 -G boardhand -h /nonexistent -s /sbin/nologin boardhand
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER 10001:10001
CMD ["node", "dist/main.js"]
