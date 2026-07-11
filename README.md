# Vass

**Internal Meta ads launcher by Hyper Studio.** Launch ads in seconds instead of minutes, in bulk.

Vass is a private workspace tool. There is no public signup — users are created by a workspace admin. The current version supports a single workspace per install; teams come later.

## What's in this install bundle

- `install.sh` — first-time install script. Generates secrets, builds containers, runs migrations, prompts for the first admin.
- `scripts/install-patch.sh` — applies a numbered patch zip on top of an existing install.
- `docker-compose.yml` — service orchestration (Postgres, Redis, backend, frontend).
- `backend/` — TypeScript Express API + queue workers.
- `frontend/` — Next.js 15 app.
- `docs/` — deeper guides (Meta App setup, Apache proxy, troubleshooting).

## Stack

| Layer    | Tech                                              |
|----------|---------------------------------------------------|
| Frontend | Next.js 15 (App Router), React 18, Tailwind       |
| Backend  | Node 20, TypeScript, Express                      |
| Workers  | BullMQ on Redis                                   |
| Database | Postgres 16                                       |
| Auth     | Server-side sessions, bcrypt passwords            |
| Meta     | Workspace-wide Meta App, per-user OAuth tokens    |
| Deploy   | Docker Compose                                    |

## Prerequisites

A Linux server with:

- **Docker** ≥ 20.10 (which ships the `compose` plugin)
- 2 GB RAM minimum, 4 GB recommended
- 10 GB free disk
- A domain or subdomain pointed at the server (for production)
- A reverse proxy that can terminate TLS (Apache, nginx, Caddy, Traefik, cPanel AutoSSL — all work)

You do NOT need:
- Node.js installed on the host (containers ship it)
- Postgres or Redis installed on the host (containers ship them)
- A Meta App created yet — the admin configures that in-app after first sign-in

## Install

```bash
# 1. Get the files onto your server
#    (clone, scp, or unzip vass-install.zip — whatever works)
cd /opt
unzip vass-install.zip -d vass
cd vass

# 2. Run the installer
./install.sh
```

The script will:

1. Check that Docker is working
2. Generate a `.env` with strong random secrets (Postgres password, session secret)
3. Ask for your public-facing URL (e.g. `https://vass.example.com`)
4. Build the backend + frontend images
5. Start all four services
6. Wait for the backend to be reachable
7. Run database migrations
8. Prompt for the first admin user (email + name + password)

Total time: 5–10 minutes on a 2-core machine, mostly Docker building.

## Reverse proxy

Vass listens on `127.0.0.1:3030` (frontend) and `127.0.0.1:4040` (backend). Your reverse proxy needs two rules:

- `/`         → `127.0.0.1:3030`
- `/api/*`    → `127.0.0.1:4040` (stripping the `/api` prefix)

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name vass.example.com;

    ssl_certificate     /etc/letsencrypt/live/vass.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/vass.example.com/privkey.pem;

    client_max_body_size 100M;

    # API requests — strip /api/ then forward
    location /api/ {
        proxy_pass http://127.0.0.1:4040/;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }

    # Everything else → frontend
    location / {
        proxy_pass http://127.0.0.1:3030;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
    }
}
```

### Caddy (simpler)

```caddy
vass.example.com {
    encode gzip
    handle_path /api/* {
        reverse_proxy 127.0.0.1:4040
    }
    handle {
        reverse_proxy 127.0.0.1:3030
    }
}
```

Caddy gets the TLS cert from Let's Encrypt automatically.

### Apache (cPanel / WHM)

See `docs/05-apache-proxy.md` for the full cPanel-specific instructions — it's a slightly more involved setup involving `ProxyPass` rules and custom rewrite snippets.

## First sign-in

1. Visit your public URL → login screen
2. Sign in with the admin credentials you set during install
3. Go to **Settings → Meta** → enter your Meta App ID + Secret (admin only — workspace-wide)
4. Hit **Connect Facebook** → OAuth → you're connected
5. **Settings → Ad accounts** → click **Sync from Meta** → toggle on the accounts you want to launch into
6. Open **Launch** or **Bulk launch** and ship some ads

To add a tester: see `docs/02-meta-setup.md` for the "Roles → Developer/Tester" flow on your Meta App, then create their Vass user in **Team**.

## Day-to-day commands

```bash
docker compose ps                       # check what's running
docker compose logs -f                  # tail all logs
docker compose logs --tail=80 backend   # recent backend logs only
docker compose restart                  # rolling restart
docker compose down                     # stop (data preserved)
docker compose up -d                    # start again

# Apply a patch
./scripts/install-patch.sh /path/to/vass-patch-X.Y.zip

# Make a DB backup
docker compose exec -T postgres pg_dump -U vass vass > backup-$(date +%F).sql

# Restore a backup
cat backup-2026-01-15.sql | docker compose exec -T postgres psql -U vass -d vass
```

The included `Makefile` has friendly aliases: `make up`, `make down`, `make logs`, `make backup`, `make migrate`. Run `make help` for the list.

## Updating

When you have a new patch zip from your dev workflow:

```bash
./scripts/install-patch.sh /path/to/vass-patch-X.Y.zip
```

This rebuilds the changed containers and re-runs any new migrations. Existing data is preserved.

## Backups

The whole database is one Docker volume (`postgres_data`). The simplest safe backup is `pg_dump`:

```bash
docker compose exec -T postgres pg_dump -U vass vass | gzip > vass-backup-$(date +%F).sql.gz
```

Schedule this in cron. Test the restore at least once.

**Critical: back up `.env`.** Specifically `SESSION_SECRET` — it's the key used to derive the AES encryption key for stored Meta secrets. If you lose it, every Meta token in the DB becomes unrecoverable.

## Troubleshooting

| Symptom                              | First thing to check                                          |
|--------------------------------------|---------------------------------------------------------------|
| Port already in use during install   | Something else is on 3030/4040 — edit docker-compose.yml      |
| Backend keeps crash-looping          | `docker compose logs --tail=60 backend` — usually a migration failure or bad `.env` |
| Frontend shows "Application error"   | `docker compose logs --tail=80 frontend` — full stack trace there |
| Meta OAuth redirects to error page   | Your redirect URI in the Meta App doesn't match `FRONTEND_URL`/api/settings/meta/callback |
| Uploads not appearing                | `vass_uploads` Docker volume — check it's mounted properly via `docker volume inspect` |
| Can't sign in after install          | Check `docker compose logs backend` for migration errors — schema may not be applied |

`docs/06-troubleshooting.md` has the longer list.

## Security notes

- The whole stack binds to `127.0.0.1` only. Nothing is exposed to the public internet without your reverse proxy in front.
- Postgres password and `SESSION_SECRET` are 48-char random strings, generated locally by the install script.
- Meta access tokens are stored AES-256-GCM encrypted in the DB. The key is derived from `SESSION_SECRET` via SHA-256 — do not change `SESSION_SECRET` on a live install.
- Bcrypt with cost factor 12 for user passwords.
- Sessions are server-side cookies (`vass_session`), HttpOnly + Secure + SameSite=Lax.
- There is no public signup. Admin creates every account.

## License

Internal use by Hyper Studio. Not licensed for external distribution.
