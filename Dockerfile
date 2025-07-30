# Dockerfile
FROM node:20-bullseye

# Install Chrome dependencies and yt-dlp
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-driver \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    --no-install-recommends && \
    pip3 install --no-cache-dir yt-dlp && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Create sessions directory and set permissions for the 'node' user
RUN mkdir -p /app/sessions && chown -R node:node /app/sessions

# Copy package files and install dependencies
COPY package.json ./
RUN npm install

# Copy the rest of the application
COPY . .

# Ensure all files in /app are owned by 'node'
RUN chown -R node:node /app

# Environment variables for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Switch to non-root user
USER node

# Expose port and start the application
EXPOSE 7860

CMD ["npm", "run", "start"]
