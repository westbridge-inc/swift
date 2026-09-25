# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Swift web (apps/web, Next.js) — the self-hosted image. The staging stack
# serves it (deploy/docker-compose.yml, profile "web"); the public site on
# swiftgy.com is still deployed by Vercel, which never reads this file.
# Multi-stage like apps/api/Dockerfile: install the workspace, build Next's
# standalone server, then a slim non-root runtime that carries only that
# server. Built from the MONOREPO ROOT so pnpm can resolve the workspace:
#     docker build -f apps/web/Dockerfile \
#       --build-arg NEXT_PUBLIC_API_URL=https://api-staging.swiftgy.com \
#       --build-arg SWIFT_WEB_CHANNEL=staging -t swift-web .
# NEXT_PUBLIC_* values are inlined into the browser bundle at BUILD time: the
# API an image talks to is fixed when it is built, never set at runtime.
# ---------------------------------------------------------------------------

FROM node:20-slim AS base
ENV PNPM_HOME=/pnpm NEXT_TELEMETRY_DISABLED=1
# A separate instruction: within one ENV, $PNPM_HOME is not yet defined.
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ---- deps: install the workspace (cached on lockfile changes) --------------
# This app's manifest and the shared packages, as the API image installs its
# own: the other apps' dependencies (Expo, React Native, Fastify) never enter.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/ packages/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build: Next's standalone server ---------------------------------------
FROM deps AS build
# Which API the browser calls, and which release the build is for. The origin
# law (src/lib/browser-api-origin.ts) refuses any other pairing:
#   public site: NEXT_PUBLIC_API_URL=https://api.<site domain>, no SWIFT_WEB_CHANNEL
#   staging:     NEXT_PUBLIC_API_URL=https://api-staging.<site domain>, SWIFT_WEB_CHANNEL=staging
ARG NEXT_PUBLIC_API_URL
ARG SWIFT_WEB_CHANNEL
# Unset or empty keeps src/site.config.ts refusing to build while a company
# detail is still a {{TOKEN}}; only an explicit 1 lets such a build through.
ARG NEXT_PUBLIC_ALLOW_SITE_TOKENS
# next.config.ts: the standalone server, and the type check and lint stay
# with CI (the reason is written there).
ENV SWIFT_WEB_IMAGE_BUILD=1
# The same headroom as the API's build stage on the 8 GB host. Build stage
# only: the runtime stage below starts from node:20-slim and does not inherit it.
ENV NODE_OPTIONS=--max-old-space-size=4096
COPY tsconfig*.json ./
COPY apps/web apps/web
# src/lib/design-tokens.ts imports the vertical tints from the mobile kit by
# path (the canonical tokens come from packages/ui, copied above). Only
# modules it imports are compiled; src/image-build-context.test.ts fails when
# the site imports something from outside apps/web that is not copied here.
COPY apps/mobile/src/kit apps/mobile/src/kit
WORKDIR /app/apps/web
RUN pnpm run build

# ---- runtime: non-root -----------------------------------------------------
# The standalone output is the server plus only the node_modules it traced.
# The site needs no image optimizer (every <Image> is unoptimized) and writes
# only its own cache under .next, which the node user owns.
FROM node:20-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# Docker sets HOSTNAME to the container id and Next's standalone server binds
# to $HOSTNAME; pin every interface so Caddy (web:3000) and the probe both reach it.
ENV HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
WORKDIR /app/apps/web
# Drop to an unprivileged user (node ships in the base image).
USER node
EXPOSE 3000
# /robots.txt is built with the site and served by this process alone, so the
# probe says "the server answers" without depending on the API it calls.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/robots.txt').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
