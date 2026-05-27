# ============================================================================
# SchoolPilot API — Production Dockerfile
# Multi-stage build: compile TypeScript, then run with minimal image
# ============================================================================

FROM node:26-alpine AS builder

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
FROM node:26-alpine

WORKDIR /app

# Bundle the AWS RDS global root CA chain for TLS verify-full (SOC 2 / SC-7).
# Refreshed automatically on each image build. See:
# https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html
RUN apk add --no-cache curl ca-certificates \
    && curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /app/rds-ca.pem \
    && apk del curl

# Install production dependencies + drizzle-kit for schema migrations
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Copy schema source (needed by drizzle ORM at runtime)
COPY src/schema ./src/schema

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1

USER node

CMD ["node", "dist/index.js"]
