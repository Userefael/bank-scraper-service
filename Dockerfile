FROM node:20-slim

# apt provides chromium; puppeteer must not download its own copy.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production
ENV TZ=Asia/Jerusalem
ENV DATA_DIR=/data

# Installing chromium pulls its own shared libraries, so only fonts and tzdata are added.
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation fonts-freefont-ttf tzdata && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# The Railway Volume is mounted at /data; the service creates it on startup when absent.
CMD ["node", "src/server.js"]
