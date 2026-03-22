# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

# Build tools needed for better-sqlite3 native module
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install all dependencies (monorepo workspaces)
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm ci

# Copy source and build both workspaces
COPY backend/ ./backend/
COPY frontend/ ./frontend/
RUN npm run build --workspace=frontend
RUN npm run build --workspace=backend


# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:22-slim AS production

# restic binary + build tools required to recompile better-sqlite3 native module
RUN apt-get update && apt-get install -y --no-install-recommends \
    restic python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies only (triggers native rebuild for better-sqlite3)
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm ci --omit=dev

# Copy compiled backend, static frontend build, and agent install script
COPY --from=builder /app/backend/dist/ ./backend/dist/
COPY --from=builder /app/backend/public/ ./backend/public/
COPY --from=builder /app/frontend/build/ ./frontend/build/

# Persistent data directory for the SQLite database
RUN mkdir -p /data

# The backend serves the frontend from ../frontend/build (relative to cwd)
WORKDIR /app/backend

ENV PORT=3001
ENV DB_PATH=/data/restic-vault.db

# Install a convenience wrapper so admins can run:
#   docker exec -it resticvault resticvault-create-admin <user> <password>
RUN printf '#!/bin/sh\ncd /app/backend && node dist/scripts/create-admin.js "$@"\n' \
    > /usr/local/bin/resticvault-create-admin && \
    chmod +x /usr/local/bin/resticvault-create-admin

EXPOSE 3001

CMD ["node", "dist/src/index.js"]
