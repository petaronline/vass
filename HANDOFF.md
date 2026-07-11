# Vass — Full Source Handoff (assembled through patch 4.58.5)

This is the COMPLETE Vass source: the base snapshot with every patch
(4.44.0 → 4.58.5) applied in order. Both backend and frontend compile clean
(verified: `tsc --noEmit` and `next build` both pass).

## What Vass is
Meta/social organic + ads launcher. Backend: Node 20 + TypeScript + Express +
Postgres 16 + Redis + BullMQ (port 4040). Frontend: Next.js 15.0.3 App Router +
Tailwind + Lucide (port 3030). Runs in Docker Compose behind an Apache reverse
proxy. Live instance: https://vass.petaronline.us at /opt/vass.

## Layout
- backend/   Express API + workers (src/, own tsconfig.json + package.json)
- frontend/  Next.js app (src/, own tsconfig.json + tailwind.config.js)
- scripts/   install-patch.sh (patch installer for the live box)
- install.sh Full first-time installer
- docker-compose.yml, .env.example, README.md, TIKTOK-HANDOFF.md

## Install somewhere new (fresh box)
1. Copy .env.example → .env and fill values (DB url, Redis, Meta/TikTok/
   LinkedIn app credentials, SESSION secret, NEXT_PUBLIC_API_URL).
2. `docker compose up -d --build`
3. Run migrations: `docker compose exec backend npm run migrate`
4. Frontend serves on 3030, backend API on 4040. Put your reverse proxy in
   front (see README for the Apache snippet).

## Local dev (no Docker)
- backend:  `cd backend && npm install && npm run migrate && npm run dev`
- frontend: `cd frontend && npm install && NEXT_PUBLIC_API_URL=http://localhost:4040 npm run dev`

## Continuing in another Claude account
Hand Claude this zip + TIKTOK-HANDOFF.md. Key context to give it:
- Patch delivery format: flat zip mirroring source paths (backend/ + frontend/
  at root) + an install doc; installed via scripts/install-patch.sh on the box.
- The live install script does NOT force a real `next build` — after any
  frontend patch you must force a no-cache rebuild:
    cd /opt/vass && docker compose build --no-cache frontend \
      && docker compose up -d --force-recreate frontend
  Confirm `docker logs vass-frontend` shows "Compiled", not just "Ready".
- Migrations are tracked BY FILENAME — never change an applied migration's
  contents; add a new numbered file instead (e.g. 037 shipped, fix went in 038).
- IG/Threads insights need their accounts RECONNECTED (scopes added in 4.57).
  FB post insights: post_impressions/clicks deprecated Nov 2025 → use
  post_media_view; IG impressions/video_views deprecated Apr 2025 → use `views`.

## Current state of work (as of 4.58.5)
- Organic Analytics page is live. Instagram + Threads working; Facebook was
  being debugged (engagement via post node; resilience fix in 4.58.4).
- Temporary diagnostic routes exist and SHOULD BE REMOVED before production:
    GET /api/organic/_diag/insights   (added 4.58.1)
    GET /api/organic/_diag/analytics  (added 4.58.3)
    GET /api/organic/_diag/sync       (added 4.58.5)
  Search routes/organic.ts for "_diag" and delete those blocks.
- Next planned work: "Profile Performance" report rework (Sprout-style),
  per-network selector (FB/IG/LinkedIn/Threads/TikTok/All), and toggleable
  report sections persisted per user (needs a user-prefs table + routes).

## Migrations present
db/001 … db/038_insights_synced.sql. Run all via `npm run migrate`.
