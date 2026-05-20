# syntax=docker/dockerfile:1.7

# ----- build stage -----
FROM oven/bun:1.3 AS build
WORKDIR /app

# Copy manifests and install
COPY package.json bun.lock* tsconfig.json ./
COPY prisma ./prisma
COPY packages ./packages
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/cli/package.json ./apps/cli/package.json
RUN bun install --frozen-lockfile || bun install

# Copy source
COPY apps ./apps

# Generate Prisma client + build web
RUN bunx prisma generate
RUN cd apps/web && bun run build

# ----- runtime stage -----
FROM oven/bun:1.3-slim AS runtime
WORKDIR /app

ENV HOST=0.0.0.0
ENV PORT=3210
ENV DATABASE_URL="file:/data/comment-md.db"
ENV WEB_DIST=/app/apps/web/dist

# Install openssl (needed by prisma engine)
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy everything we need from build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist

# Volume for the SQLite database
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3210

# Health: hits /healthz via Bun's built-in fetch (slim image has no curl/wget).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e 'fetch("http://127.0.0.1:3210/healthz").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'

# Entry: run migrations then start the server
CMD ["sh", "-c", "bunx prisma migrate deploy && bun apps/server/src/index.ts"]
