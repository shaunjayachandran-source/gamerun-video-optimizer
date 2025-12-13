FROM node:18-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN pip3 install --break-system-packages -U yt-dlp

# Create symlink so yt-dlp can find node
RUN ln -s /usr/local/bin/node /usr/bin/node || true

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm install --production

# Copy application files
COPY . .

# Create necessary directories
RUN mkdir -p temp output

# Expose port
EXPOSE 8080

# Set environment variables
ENV PORT=8080
ENV PATH="/usr/local/bin:${PATH}"

# Start the application
CMD ["npm", "start"]