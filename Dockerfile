# ============================================================================
# SchoolPilot API — Production Dockerfile
# Multi-stage build: compile TypeScript, then run with minimal image
# ============================================================================

FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY drizzle.config.ts ./
COPY src ./src

RUN npm run build

# ============================================================================
# Production image
# ============================================================================
FROM node:22-alpine

WORKDIR /app

# Install production dependencies + drizzle-kit for schema migrations
COPY package*.json ./
RUN npm ci --omit=dev && npm install drizzle-kit && npm cache clean --force

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Copy drizzle config and schema for db:push
COPY drizzle.config.ts ./
COPY src/schema ./src/schema

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1

USER node

CMD ["sh", "-c", "npx drizzle-kit push --force && node dist/index.js"]
