FROM ghcr.io/puppeteer/puppeteer:latest
USER pptruser
WORKDIR /app

COPY --chown=pptruser:pptruser package*.json ./
RUN npm ci

COPY --chown=pptruser:pptruser src/ ./src/

ENV DAEMON_MODE=true
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV PORT=3001

EXPOSE 3001

# Run both the API server and the Daemon using concurrently
CMD ["npx", "concurrently", "node src/server.js", "node src/index.js"]
