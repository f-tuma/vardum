FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build

RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.mjs tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/gateway apps/gateway
# The copied setup command pins the CLI version shipped with this server.
COPY apps/cli/package.json apps/cli/package.json
ARG VITE_UPLOAD_ORIGINS
ENV VITE_UPLOAD_ORIGINS=$VITE_UPLOAD_ORIGINS
RUN pnpm --filter "@vardum/gateway..." build

FROM nginx:1.30.6-alpine@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951 AS gateway-base
# Exact Alpine 3.24 pins; libexpat availability rechecked on 2026-10-20.
# Keep security upgrades exact and fail the build if that input is unavailable.
RUN apk add --no-cache --upgrade \
  libexpat=2.9.0-r0 \
  libpng=1.6.59-r0 \
  nghttp2-libs=1.70.0-r0 \
  pcre2=10.49-r0 \
  tiff=4.7.2-r0 \
  zlib=1.3.2-r1
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
RUN rm -rf /usr/share/nginx/html/*
COPY --from=build /repo/apps/gateway/dist /usr/share/nginx/html/app/
EXPOSE 80

# The configuration travels with the image; Dokploy replaces the Git checkout
# on redeploy, so a bind mount from that checkout is not a durable config source.
FROM gateway-base AS dokploy
COPY docker/nginx.marketing.conf.template /etc/nginx/templates/default.conf.template
ENV API_UPSTREAM=api:3000 MARKETING_UPSTREAM=127.0.0.1:8080

# Keep the default build for self-hosted/dev deployments serving the SPA at /app/.
FROM gateway-base AS runtime
