FROM node:18-alpine

ARG TIMESTAMP
ARG VERSION=1.0.0

# Install dumb-init, Python, and build tools for node-sass
RUN apk add --no-cache dumb-init python3 make g++

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY client/package*.json ./client/
COPY server/package*.json ./server/

# Install dependencies
RUN cd client && npm ci --only=production && npm ci
RUN cd server && npm ci --only=production

# Copy source code
COPY . .

# Build client and server
RUN cd client && npm run build
RUN cd server && npm run build

# Create version file
RUN echo $TIMESTAMP > /app/dockerbuildversion.txt

# Create user and set permissions
RUN addgroup -g 1001 -S nodejs && \
    adduser -S gridappsd -u 1001 -G nodejs && \
    chown -R gridappsd:nodejs /app

USER gridappsd

ENV NODE_ENV=production
ENV VIZ_PORT=8082
ENV PORT=${VIZ_PORT}

EXPOSE ${VIZ_PORT}

WORKDIR /app/server

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]