FROM node:22-bookworm-slim AS build

RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/gateway apps/gateway
ARG VITE_UPLOAD_ORIGINS
ENV VITE_UPLOAD_ORIGINS=$VITE_UPLOAD_ORIGINS
RUN pnpm --filter "@vardum/gateway..." build

FROM nginx:1.27-alpine AS runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/gateway/dist /usr/share/nginx/html
EXPOSE 80