# ============================================================
# Vass Backend — Dockerfile
# Multi-stage build for a small final image.
# ============================================================

# ---- Stage 1: build ----
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm install

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Stage 2: production ----
FROM node:20-alpine AS production
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000
ENV UPLOAD_ROOT=/uploads

# ffmpeg provides ffprobe, used by services/media-dimensions.ts to read
# video width/height for placement-aware grouping in the launch UI.
RUN apk add --no-cache ffmpeg

# Only production dependencies
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy built JS from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/db ./src/db

# Copy supervisor script
COPY supervise.sh ./supervise.sh
RUN chmod +x ./supervise.sh

# Uploads volume (Docker volume mount overrides this)
RUN mkdir -p /uploads

# Run as a non-root user for security
RUN addgroup -S vass && adduser -S vass -G vass
RUN chown -R vass:vass /uploads
USER vass

EXPOSE 4000
CMD ["./supervise.sh"]
