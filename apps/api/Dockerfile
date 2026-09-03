# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Swift API — production image (also serves the BullMQ worker via RUN_WORKERS).
# Multi-stage: a full build stage compiles TypeScript + generates the Prisma
# client, then a slim runtime stage carries only what `node dist/server.js`
# needs. Built from the MONOREPO ROOT so pnpm can resolve the workspace:
#     docker build -f apps/api/Dockerfile -t swift-api .
# ---------------------------------------------------------------------------

FROM node:20-slim AS base
ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH
# OpenSSL is required by the Prisma query engine at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ---- deps: install the whole workspace (cached on lockfile changes) --------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/ packages/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build: compile TS + generate the Prisma client -----------------------
FROM deps AS build
COPY apps/api apps/api
COPY tsconfig*.json ./
# @swift/ui ships TS source for dev/metro but the compiled (CJS) API `require`s
# its built dist via the package's "require" export condition — build it first.
WORKDIR /app/packages/ui
RUN pnpm run build
WORKDIR /app/apps/api
RUN pnpm exec prisma generate
RUN pnpm run build

# ---- runtime: non-root -----------------------------------------------------
# We carry the BUILD stage's node_modules wholesale rather than reconstructing
# a pruned tree: pnpm hoists the generated Prisma engine into the root
# content-addressed store at a version-hashed path, so selective copying is
# brittle. Correctness over image size — the right tradeoff for a self-host /
# staging image (the store dedupes the layer anyway).
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/packages ./packages

WORKDIR /app/apps/api
# Drop to an unprivileged user (node ships in the base image).
USER node
EXPOSE 3000
# [R048-006] READINESS is the container probe: GET /ready answers 503 for any
# unavailable required dependency (schema, Redis, queues, workers, clock, the
# realtime adapter, the boot contracts), so a degraded API is never a green
# container. LIVENESS is GET /live — dependency-free — for an orchestrator
# that restarts only a wedged process. Neither returns 200 for a known failure.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
