# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Runtime stage
FROM node:20-alpine AS runtime

WORKDIR /app

RUN addgroup --system substrate && adduser --system --ingroup substrate substrate

RUN mkdir -p /app/data && chown -R substrate:substrate /app/data

COPY package.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/health || exit 1

USER substrate

CMD ["node", "dist/index.js"]
