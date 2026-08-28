# Use the official Puppeteer image which comes with Chromium and all necessary OS dependencies installed
FROM ghcr.io/puppeteer/puppeteer:latest

# Switch to root to configure permissions if necessary, but puppeteer image uses 'pptruser'
USER pptruser

# Set working directory
WORKDIR /app

# Copy package.json and install dependencies
COPY --chown=pptruser:pptruser package*.json ./
RUN npm install

# Copy the rest of the application
COPY --chown=pptruser:pptruser src/ ./src/

# Set environment variables
ENV DAEMON_MODE=true
# Tells Puppeteer to skip installing Chrome since the base image already has it
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
# Points Puppeteer to the installed Chrome executable
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Start the daemon
CMD ["node", "src/index.js"]
