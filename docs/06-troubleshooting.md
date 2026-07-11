# 06 — Troubleshooting

Common problems and their fixes. If you hit something not listed here, the most useful first step is always `docker compose logs -f` to see what's actually happening.

---

## "A container won't start"

### Diagnose

```bash
docker compose ps
```

Look for any container with status `Restarting`, `Exited`, or `Unhealthy`. Then look at its logs:

```bash
docker compose logs <service-name>     # e.g. backend, frontend, postgres
```

The last 30 lines usually tell you what's wrong.

### Common causes

**`.env` missing or has invalid values:**

The backend uses `zod` to validate env vars at startup. If a required value is missing, you'll see:

```
Invalid environment configuration:
{ SESSION_SECRET: { _errors: ['String must contain at least 32 character(s)'] } }
```

Fix the `.env` file and restart:

```bash
docker compose down
docker compose up -d
```

**Port already in use:**

If something else on the server is using port 3000, 4000, 5432, or 6379:

```
Error: bind: address already in use
```

Find what's using it:

```bash
ss -tlnp | grep ':3000'      # or whatever port
```

You can either stop that process, or change the port mapping in `docker-compose.yml`.

**Database isn't ready when backend tries to start:**

We have a `depends_on: postgres: condition: service_healthy` clause that should prevent this, but if it happens:

```bash
docker compose restart backend
```

---

## "I can't log in"

### Symptom: "Invalid email or password"

You're entering the wrong credentials, **or** the user doesn't exist.

Verify the user exists:

```bash
docker compose exec postgres psql -U vass -d vass -c \
  "SELECT email, name, role FROM users WHERE deleted_at IS NULL;"
```

If the email isn't in the list, create it:

```bash
docker compose exec backend npm run create-user
```

### Symptom: "Session expired" immediately after login

This usually means cookies aren't being sent back. Causes:

1. **You're testing over HTTP in production.** Cookies are set with `secure: true` in production, which means they only work over HTTPS. Either set up Apache SSL ([05-apache-proxy.md](05-apache-proxy.md)) or test with `NODE_ENV=development` temporarily.

2. **Your `FRONTEND_URL` doesn't match the URL you're visiting.** They must match exactly. If you're visiting `https://vass.hyperstudio.com`, that's what `FRONTEND_URL` must be.

3. **Browser is blocking third-party cookies.** Make sure you're visiting the same domain the cookie is set for. In a proper Apache proxy setup this is automatic.

### Symptom: "I forgot the admin password"

Soft-delete the existing user, then create a new one with the same email:

```bash
docker compose exec postgres psql -U vass -d vass
```

```sql
UPDATE users SET deleted_at = NOW() WHERE email = 'your-email@example.com';
\q
```

```bash
docker compose exec backend npm run create-user
```

(A proper "forgot password" flow is on the roadmap.)

---

## "The page is blank / loads forever"

### Diagnose

Open the browser dev tools (F12) → Network tab. Reload the page. Look for:

- **Red rows** (failed requests) → tells you what URL failed
- **Pending requests** → tells you what's hanging

Also check the Console tab for JavaScript errors.

### Common causes

**Backend isn't responding:**

```bash
curl http://localhost:4000/health
```

If you don't get `{"status":"ok"}`, the backend is down. See logs:

```bash
docker compose logs backend
```

**Frontend can't reach the backend:**

The frontend talks to the backend via `/api/*` which the Apache proxy forwards. If you're hitting the frontend directly (skipping Apache), `/api/*` won't work.

For local testing without Apache, set `NEXT_PUBLIC_API_URL=http://localhost:4000` and access through the SSH tunnel as in [03-first-deploy.md](03-first-deploy.md) Step 7 Option B.

---

## "Docker says 'no space left on device'"

You've run out of disk. Free up space:

```bash
docker system prune -a
```

This removes unused images, stopped containers, and the build cache. Your volumes (database, etc.) are untouched.

Check disk space:

```bash
df -h /
```

---

## "Postgres won't start, says permission denied"

Sometimes after a server restore or volume migration, file ownership gets weird:

```bash
docker compose down
docker volume inspect vass_postgres_data
# Note the "Mountpoint" path
chown -R 999:999 <mountpoint-path>
docker compose up -d
```

(999 is the postgres user's UID inside the official Postgres image.)

---

## "I want to start completely fresh (delete all data)"

⚠️ This is destructive. Only do it if you're sure.

```bash
cd /opt/vass
docker compose down -v       # the -v deletes volumes
docker compose up -d
docker compose exec backend npm run migrate
docker compose exec backend npm run create-user
```

---

## "I changed a backend file but my changes aren't showing"

The Docker image was built once. To rebuild with your changes:

```bash
docker compose up -d --build backend
```

For frontend changes:

```bash
docker compose up -d --build frontend
```

For both:

```bash
docker compose up -d --build
```

---

## "Apache says '503 Service Unavailable'"

Apache is reaching out to `127.0.0.1:3000` or `:4000` and getting nothing. Either:

1. Vass isn't running. Check: `docker compose ps`
2. SELinux is blocking Apache from making local connections (on RHEL-family servers).

To fix SELinux:

```bash
setsebool -P httpd_can_network_connect on
```

This persists across reboots.

---

## "Everything looks fine but emails aren't sending"

Vass doesn't currently send any emails. If we add password-reset flows in the future, this section will be relevant. For now, ignore.

---

## "How do I see what someone did?"

The audit log captures every meaningful action:

```bash
docker compose exec postgres psql -U vass -d vass
```

```sql
SELECT
  created_at,
  (SELECT email FROM users WHERE id = a.user_id) AS user,
  action,
  metadata
FROM audit_log a
ORDER BY created_at DESC
LIMIT 50;
\q
```

This shows the last 50 actions across all users.

To filter by user:

```sql
SELECT created_at, action, metadata FROM audit_log
WHERE user_id = (SELECT id FROM users WHERE email = 'someone@example.com')
ORDER BY created_at DESC
LIMIT 50;
```

---

## "I need help with something not on this list"

When asking for help, include:

1. **What you tried**: the exact commands
2. **What you expected** vs **what actually happened**
3. **The logs**: `docker compose logs --tail=100`
4. **Container status**: output of `docker compose ps`

This makes debugging way faster.
