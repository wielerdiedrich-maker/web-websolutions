# DW Web Solutions — production image.
#
# This app is NOT a fit for Vercel's serverless platform: it uses
# app.listen() (a long-running process, not a request handler export),
# a local SQLite file (data/app.db) for the DB and sessions, and local
# disk (uploads/) for media/lead-file storage — all of which need a real,
# persistent filesystem. Deploy this image to a host built for that:
# Fly.io or Railway both work with a persistent volume mounted at /app/data
# and /app/uploads. See the "Deployment" section in README.md for exact
# steps.
FROM node:22-slim AS builder
WORKDIR /app

# better-sqlite3 and sharp ship prebuilt binaries for common platforms, but
# fall back to compiling from source on less common host architectures —
# these build tools cover that case. Kept only in this stage, not the
# final image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /app /app
USER node

EXPOSE 3000
CMD ["node", "server/index.js"]
