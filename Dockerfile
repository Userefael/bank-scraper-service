FROM node:20-slim

# Chromium comes from apt; puppeteer must not download its own copy.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    TZ=Asia/Jerusalem \
    DATA_DIR=/data

# apt pulls chromium's own shared libraries, so only fonts and tzdata are added.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        ca-certificates \
        fonts-liberation \
        fonts-freefont-ttf \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# The Railway Volume is mounted here; connections.json lives in it.
RUN mkdir -p /data
VOLUME ["/data"]

CMD ["node", "src/server.js"]
