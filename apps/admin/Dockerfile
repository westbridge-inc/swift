# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Swift admin console (apps/admin, Next.js) — the self-hosted image. The
# staging stack serves it (deploy/docker-compose.yml, profile "admin", behind
# Caddy on ADMIN_HOST). Built like the website's image: install the
# workspace, build Next's standalone server, then a slim non-root runtime that
# carries only that server. Built from the MONOREPO ROOT so pnpm can resolve
# the workspace:
#     docker build -f apps/admin/Dockerfile \
#       --build-arg NEXT_PUBLIC_API_URL=https://api-staging.swiftgy.com -t swift-admin .
# NEXT_PUBLIC_API_URL is the image's ONLY input. It is public (inlined into the
# browser bundle at BUILD time) and it must be an https origin: next.config.ts
# refuses anything else in an image build. No secret, token, key or settings
# file enters any stage (.dockerignore keeps every .env out of the context);
# the console holds no credential at all, its session is the API's HttpOnly
# cookie pair.
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
COPY apps/admin/package.json apps/admin/
COPY packages/ packages/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build: Next's standalone server ---------------------------------------
FROM deps AS build
# Which API the browser calls. No default: next.config.ts refuses an image
# build without an https origin here.
ARG NEXT_PUBLIC_API_URL
# next.config.ts: the standalone server; the type check and lint stay with CI
# (its Lint & Type Check and Admin Build jobs run on every main commit, and
# deploy/pilot-up.sh builds only main commits).
ENV SWIFT_ADMIN_IMAGE_BUILD=1
# The same headroom as the API's build stage on the 8 GB host. Build stage
# only: the runtime stage below starts from node:20-slim and does not inherit it.
ENV NODE_OPTIONS=--max-old-space-size=4096
COPY tsconfig*.json ./
COPY apps/admin apps/admin
WORKDIR /app/apps/admin
RUN pnpm run build

# ---- runtime: non-root -----------------------------------------------------
# The standalone output is the server plus only the node_modules it traced.
# The console has no public/ directory and writes only its own cache under
# .next, which the node user owns.
FROM node:20-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# Docker sets HOSTNAME to the container id and Next's standalone server binds
# to $HOSTNAME; pin every interface so Caddy (admin:3000) and the probe both reach it.
ENV HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/admin/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/admin/.next/static ./apps/admin/.next/static
WORKDIR /app/apps/admin
# Drop to an unprivileged user (node ships in the base image).
USER node
EXPOSE 3000
# The sign-in page is built with the console and served by this process alone,
# so the probe says "the server answers" without depending on the API it calls.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
