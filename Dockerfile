FROM node:22-slim

# Install Playwright system dependencies + ffmpeg for session recording
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libxshmfence1 \
    libglib2.0-0 \
    fonts-liberation \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json ./
RUN npm install --production

# Install Playwright Chromium into /app/browsers (matches server.js default)
ENV PLAYWRIGHT_BROWSERS_PATH=/app/browsers
RUN npx playwright install chromium

# Copy application source
COPY . .

# Create non-root user
RUN groupadd -r humanaie && useradd -r -g humanaie -d /app humanaie \
    && chown -R humanaie:humanaie /app

USER humanaie

EXPOSE 3333

CMD ["node", "server.js"]
