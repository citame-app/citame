FROM oven/bun:1.4.5-slim AS base
WORKDIR /app

# Prune the monorepo down to @sob/web and its workspace dependencies (@sob/contracts).
FROM base AS pruner
COPY . .
RUN bunx turbo@2.11.11 prune @sob/web --docker

# Build with every dependency installed (Vite, Tailwind, TanStack Start are build-time tools).
FROM base AS builder
COPY --from=pruner /app/out/json/ .
RUN bun install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN bun run --cwd apps/web build

# Runtime: production dependencies only. Vite bundles the TanStack Start runtime into
# the client and server output, so its build plugin stays in the builder.
FROM base AS installer
COPY --from=pruner /app/out/json/ .
RUN bun install --frozen-lockfile --production
COPY --from=pruner /app/out/full/ .
COPY --from=builder /app/apps/web/dist apps/web/dist

FROM base AS runner
ENV NODE_ENV=production \
    PORT=4173 \
    HOST=0.0.0.0
COPY --from=installer --chown=bun:bun /app .
USER bun
WORKDIR /app/apps/web
EXPOSE 4173
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["bun", "src/server/healthcheck.ts"]
CMD ["bun", "server.ts"]
