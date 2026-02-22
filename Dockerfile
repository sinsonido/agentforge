# ─── Stage 1: Install production dependencies ──────────────────────────────
FROM node:20-alpine@sha256:c3324aa3efea082c8d294a93b97ba82adc5498a202bd48802f5a8af152e7dd9e AS deps

WORKDIR /app

# Copy only the manifest first so Docker can cache the npm ci layer
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --omit=dev

# ─── Stage 2: Final application image ──────────────────────────────────────
FROM node:20-alpine@sha256:c3324aa3efea082c8d294a93b97ba82adc5498a202bd48802f5a8af152e7dd9e AS app

WORKDIR /app

# Install wget for the healthcheck (alpine ships wget by default, but be explicit)
RUN apk add --no-cache wget

# Use the non-root "node" user that ships with node:alpine
USER node

# Copy production node_modules from the deps stage
COPY --from=deps --chown=node:node /app/node_modules ./node_modules

# Copy application source
COPY --chown=node:node src/ ./src/

# Seed a default config; operators mount their real agentforge.yml at runtime
COPY --chown=node:node agentforge.example.yml ./agentforge.yml

# AgentForge dashboard / API port
EXPOSE 4242

# Health check — polls the /api/status endpoint every 30 s
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4242/api/status || exit 1

CMD ["node", "src/cli.js", "start"]
