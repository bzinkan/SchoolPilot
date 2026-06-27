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

# Patch base-image packages on every build so newly-published CVEs in the
# pinned node:alpine tag (e.g. openssl libcrypto3/libssl3) don't sit unfixed
# until the upstream tag is rebuilt. Trivy fails the build loudly otherwise.
RUN apk upgrade --no-cache

# Bundle the AWS RDS global root CA chain for TLS verify-full (SOC 2 / SC-7).
# Refreshed automatically on each image build. See:
# https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html
RUN apk add --no-cache curl ca-certificates \
    && curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /app/rds-ca.pem \
    && apk del curl

# Install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force \
    # Strip the package managers from the runtime image: nothing needs them after
    # this RUN (CMD is plain node), and npm/yarn vendor their own node_modules
    # (e.g. picomatch) that show up as container CVEs we can't otherwise fix.
    && rm -rf /usr/local/lib/node_modules/npm \
              /usr/local/bin/npm /usr/local/bin/npx \
              /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
              /usr/local/bin/corepack /usr/local/lib/node_modules/corepack

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Copy non-sensitive SOC 2 readiness docs used by the Super Admin dashboard
COPY docs/soc2 ./docs/soc2

# Copy schema source (needed by drizzle ORM at runtime)
COPY src/schema ./src/schema

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1

USER node

CMD ["node", "dist/index.js"]
