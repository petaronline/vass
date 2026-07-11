# 04 — Day-to-day operations

Common commands you'll run when managing Vass on your server.

All commands assume you're SSH'd into the server and in `/opt/vass`.

---

## Status & logs

### Check if everything is running

```bash
docker compose ps
```

Healthy output: all four containers say `Up` (or `Up (healthy)` for postgres/redis).

### See live logs

```bash
docker compose logs -f
```

(Press `Ctrl+C` to exit. The app keeps running.)

### Logs of just one service

```bash
docker compose logs -f backend       # just the API
docker compose logs -f frontend      # just the Next.js app
docker compose logs -f postgres      # just the database
```

### Logs from the last hour only

```bash
docker compose logs --since 1h
```

---

## Start / stop / restart

### Start everything

```bash
docker compose up -d
```

### Stop everything (data is preserved)

```bash
docker compose down
```

### Restart everything

```bash
docker compose restart
```

### Restart just one service (after editing code)

```bash
docker compose restart backend
```

---

## Update Vass to a new version

When new code is available (either from a Git push or a new file upload):

```bash
cd /opt/vass

# Pull latest code
git pull           # if you cloned from a repo

# Rebuild containers with new code
docker compose up -d --build

# Apply any new database migrations
docker compose exec backend npm run migrate
```

The first command updates code on disk. The second rebuilds the Docker images and replaces the running containers (data is preserved). The third applies any new schema changes.

**Downtime during update: ~10-30 seconds.**

---

## User management

### Create a new user

```bash
docker compose exec backend npm run create-user
```

Interactive prompts for email, name, role, password.

Or non-interactively:

```bash
docker compose exec backend npm run create-user -- \
  --email teammate@hyperstudio.com \
  --name "Teammate Name" \
  --role member
```

You'll still be prompted for the password.

### Reset a user's password

```bash
docker compose exec backend npm run create-user
```

If the email already exists, the script will refuse. For now, the simplest way to reset is via direct DB:

```bash
docker compose exec postgres psql -U vass -d vass
```

Then in the `vass=#` prompt:

```sql
-- Mark old user as deleted (soft delete)
UPDATE users SET deleted_at = NOW() WHERE email = 'their-email@example.com';
\q
```

Then run `create-user` again with the same email. (A proper "reset password" UI is on the roadmap.)

### List all users

```bash
docker compose exec postgres psql -U vass -d vass -c \
  "SELECT email, name, role, last_login_at FROM users WHERE deleted_at IS NULL;"
```

---

## Backups

### Manual backup (run this anytime before big changes)

```bash
mkdir -p /opt/vass/backups
docker compose exec -T postgres pg_dump -U vass vass | gzip > \
  /opt/vass/backups/vass-$(date +%Y%m%d-%H%M%S).sql.gz
```

Output file: `/opt/vass/backups/vass-20260522-143022.sql.gz`

### Set up nightly automatic backups

Create the backup script:

```bash
cat > /opt/vass/scripts/backup.sh << 'EOF'
#!/bin/bash
# Nightly backup — keeps 30 days of dumps
set -e

BACKUP_DIR="/opt/vass/backups"
mkdir -p "$BACKUP_DIR"

cd /opt/vass
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
FILENAME="$BACKUP_DIR/vass-$TIMESTAMP.sql.gz"

docker compose exec -T postgres pg_dump -U vass vass | gzip > "$FILENAME"

# Delete backups older than 30 days
find "$BACKUP_DIR" -name "vass-*.sql.gz" -mtime +30 -delete

echo "[$(date)] Backup complete: $FILENAME"
EOF

chmod +x /opt/vass/scripts/backup.sh
```

Now schedule it to run nightly at 3 AM:

```bash
crontab -e
```

Add this line:

```
0 3 * * * /opt/vass/scripts/backup.sh >> /var/log/vass-backup.log 2>&1
```

Save (`Ctrl+O`, Enter, `Ctrl+X` in nano).

Verify the cron is set:

```bash
crontab -l
```

### Restore from a backup

**Warning**: This deletes all current data and replaces it with the backup.

```bash
# Stop the app (but keep postgres running)
docker compose stop backend frontend

# Restore
gunzip < /opt/vass/backups/vass-20260522-143022.sql.gz | \
  docker compose exec -T postgres psql -U vass vass

# Restart
docker compose start backend frontend
```

---

## Inspecting the database directly

```bash
docker compose exec postgres psql -U vass -d vass
```

Useful queries:

```sql
-- Count of users
SELECT COUNT(*) FROM users WHERE deleted_at IS NULL;

-- Recent logins
SELECT email, last_login_at FROM users
WHERE deleted_at IS NULL ORDER BY last_login_at DESC NULLS LAST LIMIT 10;

-- Last 20 audit log entries
SELECT created_at, action, user_id FROM audit_log
ORDER BY created_at DESC LIMIT 20;

-- Exit
\q
```

---

## Disk usage

### Check how much disk Docker uses

```bash
docker system df
```

### Free up space (removes unused images and stopped containers)

```bash
docker system prune
```

Don't worry, this never touches your data volumes.

### Check database size

```bash
docker compose exec postgres psql -U vass -d vass -c \
  "SELECT pg_size_pretty(pg_database_size('vass'));"
```

---

## Common scenarios

### "I changed `.env` — how do I apply it?"

`.env` is only read when containers start. To apply changes:

```bash
docker compose down
docker compose up -d
```

### "I want to see what Postgres is doing"

```bash
docker compose logs -f postgres
```

### "I want to manually test the backend"

```bash
curl http://localhost:4000/health
```

Expected response:

```json
{"status":"ok","timestamp":"2026-05-22T14:30:22.000Z"}
```

### "The server rebooted — is Vass back up?"

Yes. All four services have `restart: unless-stopped` in `docker-compose.yml`, so Docker brings everything back automatically. You don't need to do anything.

Verify with `docker compose ps`.
