# Multi-stage build for the Next.js standalone Node server.
# WEAVIATE_URL and WEAVIATE_API_KEY are injected at runtime (Cloud Run
# env/secret), never baked into the image.

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- runtime ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Next's incremental cache (R6 `unstable_cache` / ISR) writes to .next/cache at
# runtime. The COPY above leaves .next root-owned and .next/cache absent, so the
# non-root `node` user gets EACCES on the first `mkdir`. Pre-create the dir and
# hand it to `node`.
RUN mkdir -p /app/.next/cache && chown -R node:node /app/.next/cache
EXPOSE 8080
# Run as the unprivileged `node` user shipped in the base image (port 8080 is
# non-privileged, so no root needed).
USER node
# Liveness probe; /api/meta is lightweight and does not touch Weaviate.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/meta || exit 1
CMD ["node", "server.js"]
