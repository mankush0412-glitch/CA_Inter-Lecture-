FROM node:20-alpine

WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S botuser -u 1001

COPY package*.json ./
RUN npm install --omit=dev

COPY --chown=botuser:nodejs . .

USER botuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/health || exit 1

CMD ["node", "server.js"]
