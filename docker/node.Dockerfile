# syntax=docker/dockerfile:1
# Any Fastify service: --build-arg PACKAGE=@ember/api --build-arg DIR=services/api, from the repo root.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 EMBER_SKIP_HOOKS=1 TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS prune
ARG PACKAGE
ARG TURBO_VERSION=2
COPY . .
RUN pnpm dlx "turbo@${TURBO_VERSION}" prune "${PACKAGE}" --docker

FROM base AS build
ARG PACKAGE
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
RUN pnpm turbo run build --filter="${PACKAGE}"
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod --offline

FROM node:${NODE_VERSION}-slim
ARG DIR
ENV NODE_ENV=production
COPY --from=build --chown=node:node /repo /repo
WORKDIR /repo/${DIR}
USER node
CMD ["node", "dist/main.js"]
