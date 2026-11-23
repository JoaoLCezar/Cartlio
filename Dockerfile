FROM node:22-bookworm-slim AS base

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS builder
COPY . .
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_SUPABASE_STORAGE_URL
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY}
ENV NEXT_PUBLIC_SUPABASE_STORAGE_URL=${NEXT_PUBLIC_SUPABASE_STORAGE_URL}
RUN test -n "$NEXT_PUBLIC_SUPABASE_URL" \
  && test -n "$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" \
  && npm run build

# Compose uses this target for the local development server and its local workers.
FROM dependencies AS development
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]

FROM base AS maintenance
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY scripts/package.json ./scripts/package.json
RUN npm ci --workspace=scripts --include-workspace-root=false --omit=dev --no-audit --no-fund
COPY scripts ./scripts
USER node
CMD ["node", "scripts/run-maintenance.mjs", "--remote"]

# Production web image. Public Supabase settings are build-time values because
# Next.js embeds NEXT_PUBLIC_* variables in browser bundles. Never pass the
# server secret key as a build argument.
FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_SUPABASE_STORAGE_URL
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL} \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY} \
    NEXT_PUBLIC_SUPABASE_STORAGE_URL=${NEXT_PUBLIC_SUPABASE_STORAGE_URL}
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --home-dir /app nextjs \
  && mkdir -p /app/.next/cache /app/scripts/lib \
  && chown -R nextjs:nodejs /app
WORKDIR /app
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/scripts/production-preflight.mjs ./scripts/production-preflight.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/lib/production-config.mjs ./scripts/lib/production-config.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/lib/quadrics-env.mjs ./scripts/lib/quadrics-env.mjs
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "scripts/production-preflight.mjs"]
