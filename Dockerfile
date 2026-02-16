# ── Stage 1: Install dependencies ──────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.50.0-noble AS builder
RUN npm install -g bun
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY . .

# ── Stage 2: Production runtime ───────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.50.0-noble

RUN npm install -g bun

# Non-root user (Playwright image has pwuser:pwuser at uid 1001)
RUN mkdir -p /app /tmp/uat-artifacts /tmp/uat-traces /tmp/uat-state \
    && chown -R pwuser:pwuser /app /tmp/uat-artifacts /tmp/uat-traces /tmp/uat-state

WORKDIR /app
COPY --from=builder --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --from=builder --chown=pwuser:pwuser /app/mcp-server ./mcp-server
COPY --from=builder --chown=pwuser:pwuser /app/flows ./flows
COPY --from=builder --chown=pwuser:pwuser /app/package.json ./

USER pwuser

EXPOSE 3200

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3200/health || exit 1

CMD ["bun", "run", "mcp-server/src/index.ts"]
