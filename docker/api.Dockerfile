FROM node:22-bookworm-slim AS build

RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY apps/api apps/api
RUN pnpm --filter @vardum/api build \
  && pnpm --filter @vardum/api deploy --legacy --prod /output \
  && cp -R apps/api/dist apps/api/drizzle /output/

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /output ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
