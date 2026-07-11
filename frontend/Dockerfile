# ============================================================
# Vass Frontend — Dockerfile
# Uses Next.js standalone output for a tiny production image.
# ============================================================

# ---- Stage 1: deps ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install

# ---- Stage 2: build ----
FROM node:20-alpine AS builder
WORKDIR /app
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- Stage 3: runner ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

RUN addgroup -S vass && adduser -S vass -G vass

# Copy the standalone build output
COPY --from=builder /app/public ./public
COPY --from=builder --chown=vass:vass /app/.next/standalone ./
COPY --from=builder --chown=vass:vass /app/.next/static ./.next/static

USER vass
EXPOSE 3000
CMD ["node", "server.js"]
