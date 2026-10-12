ARG API_RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian13:nonroot@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c

FROM node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS build

RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.mjs tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter "@vardum/api..." build \
  && pnpm --filter @vardum/api deploy --legacy --prod /output \
  && cp -R apps/api/dist apps/api/drizzle /output/

FROM ${API_RUNTIME_IMAGE} AS runtime

# The vendor's Node entrypoint would duplicate the existing Compose/CMD node.
ENTRYPOINT []
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 \
    PATH=/nodejs/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /app
COPY --from=build --chown=65532:65532 /output ./
USER 65532:65532
EXPOSE 3000
CMD ["node", "dist/server.js"]
