FROM oven/bun:1.4.5-slim AS base
WORKDIR /app

# Prune the monorepo down to @sob/api and its workspace dependencies.
FROM base AS pruner
COPY . .
RUN bunx turbo@2.11.11 prune @sob/api --docker

# Install dependencies first so this layer is cached until a manifest changes.
FROM base AS installer
COPY --from=pruner /app/out/json/ .
RUN bun install --frozen-lockfile --production
COPY --from=pruner /app/out/full/ .

FROM base AS runner
ENV NODE_ENV=production
COPY --from=installer --chown=bun:bun /app .
USER bun
EXPOSE 3000
CMD ["bun", "apps/api/src/index.ts"]
