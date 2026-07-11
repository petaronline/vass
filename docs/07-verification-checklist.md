# 07 — Phase 0 verification checklist

After deploying Vass for the first time, run through this checklist to confirm everything works. Each item is a small, concrete test. If any of them fail, jump to [06-troubleshooting.md](06-troubleshooting.md).

---

## ✅ Test 1 — All containers are healthy

```bash
docker compose ps
```

**Pass criteria:** Four containers, all `Up`. Postgres and Redis say `Up (healthy)`.

```
NAME             STATUS         PORTS
vass-postgres    Up (healthy)   127.0.0.1:5432->5432/tcp
vass-redis       Up (healthy)   127.0.0.1:6379->6379/tcp
vass-backend     Up             127.0.0.1:4000->4000/tcp
vass-frontend    Up             127.0.0.1:3000->3000/tcp
```

---

## ✅ Test 2 — Backend health check

```bash
curl http://localhost:4000/health
```

**Pass criteria:** Returns valid JSON.

```json
{"status":"ok","timestamp":"2026-05-22T14:30:22.123Z"}
```

---

## ✅ Test 3 — Frontend serves the login page

```bash
curl -I http://localhost:3000/login
```

**Pass criteria:** Returns `HTTP/1.1 200 OK`.

---

## ✅ Test 4 — Login flow works

Visit the site in your browser. Sign in with your admin credentials.

**Pass criteria:**
1. You see the Vass login page (electric blue accent, Satoshi wordmark)
2. After entering valid credentials, you land on the dashboard
3. Your name appears in the top-right user menu
4. The greeting says "Good morning/afternoon/evening, [your first name]"

---

## ✅ Test 5 — Session persists across reloads

After logging in, refresh the browser tab.

**Pass criteria:** You stay logged in. You do NOT get bounced to the login page.

---

## ✅ Test 6 — Logout works

Click your avatar in the top-right, then **Sign out**.

**Pass criteria:**
1. You're redirected to the login page
2. Visiting `/dashboard` directly bounces you back to login (no leaked access)

---

## ✅ Test 7 — Data persists across container restarts

This is the critical one — proves your data is safely on disk.

```bash
# Stop everything
docker compose down

# Bring it back up
docker compose up -d

# Wait a few seconds for things to start
sleep 5
```

Now log in again with the same credentials.

**Pass criteria:** Your user account still exists. You can sign in. The dashboard loads.

If this fails, your Docker volume isn't persisting — see [06-troubleshooting.md](06-troubleshooting.md).

---

## ✅ Test 8 — Auto-recovery on server reboot

If you can afford a few minutes of downtime, reboot the server:

```bash
reboot
```

Wait ~2 minutes, then SSH back in and check:

```bash
cd /opt/vass
docker compose ps
```

**Pass criteria:** All four containers are `Up` again **without you doing anything**. (This is the `restart: unless-stopped` clause working.)

---

## ✅ Test 9 — Audit log captures activity

```bash
docker compose exec postgres psql -U vass -d vass -c \
  "SELECT created_at, action FROM audit_log ORDER BY created_at DESC LIMIT 5;"
```

**Pass criteria:** You see entries like:

```
        created_at         |      action
---------------------------+--------------------
 2026-05-22 14:31:02+00    | user.logout
 2026-05-22 14:30:15+00    | user.login.success
 2026-05-22 14:30:10+00    | user.login.failure
```

The `user.login.failure` confirms timing-attack-safe auth: every login attempt — successful or not — is logged.

---

## ✅ Test 10 — Wrong password fails cleanly

Log out, then try to log in with the wrong password.

**Pass criteria:**
1. Inline error: "Invalid email or password"
2. NO information about whether the email exists (same message either way)
3. You're not crashed out, you can try again

---

## ✅ Test 11 — Wrong email fails cleanly

Log out, try to log in with an email that doesn't exist.

**Pass criteria:** Same error message as Test 10 (`"Invalid email or password"`). Vass deliberately won't tell you which one was wrong — this prevents attackers from learning which emails are registered.

---

## ✅ Test 12 — Creating a second user works

```bash
docker compose exec backend npm run create-user -- \
  --email test@hyperstudio.com \
  --name "Test User" \
  --role member
```

(Enter a password when prompted.)

Log out of admin, log in as `test@hyperstudio.com`.

**Pass criteria:**
1. Login works with the new user
2. The "Team" link in the sidebar does NOT show (members can't see it — admin-only)
3. The user menu shows role: `member`

Log back in as admin afterward. Confirm "Team" is visible again.

---

## ✅ Test 13 — Backup works

```bash
mkdir -p /opt/vass/backups
docker compose exec -T postgres pg_dump -U vass vass | gzip > \
  /opt/vass/backups/vass-test-$(date +%Y%m%d-%H%M%S).sql.gz

ls -lh /opt/vass/backups/
```

**Pass criteria:** You see a `.sql.gz` file, larger than 0 bytes (typically 5-20KB on a fresh install).

---

## ✅ Test 14 — Restore works (do this in a non-production deployment)

⚠️ **Only run this if you have a non-production environment or don't mind losing your test data.**

```bash
# Delete the test user (so we have something to restore)
docker compose exec postgres psql -U vass -d vass -c \
  "DELETE FROM users WHERE email = 'test@hyperstudio.com';"

# Restore from the backup you made in Test 13
gunzip -c /opt/vass/backups/vass-test-*.sql.gz | \
  docker compose exec -T postgres psql -U vass vass

# Verify the test user is back
docker compose exec postgres psql -U vass -d vass -c \
  "SELECT email FROM users WHERE email = 'test@hyperstudio.com';"
```

**Pass criteria:** The test user appears in the SELECT output, confirming the backup restored cleanly.

---

## ✅ Test 15 — HTTPS works (if you've done Apache proxy)

If you've completed [05-apache-proxy.md](05-apache-proxy.md):

Visit `https://vass.hyperstudio.com` in a browser.

**Pass criteria:**
1. Green padlock (valid SSL certificate)
2. HTTP redirects to HTTPS automatically
3. Login works over HTTPS
4. Session cookies persist

---

## If all 15 pass

🎯 **Phase 0 is fully verified.** You have:

- ✅ A working internal tool with login/logout
- ✅ Persistent data that survives restarts
- ✅ Auto-recovery on server reboot
- ✅ Secure password handling
- ✅ Session management with proper cookie security
- ✅ Audit logging of all meaningful actions
- ✅ Role-based access (admin vs member)
- ✅ Backup and restore capability
- ✅ A public HTTPS URL (if Apache proxy is set up)

**You're ready for Phase 1**, which is the Meta API smoke test — connecting Vass to your Meta account and listing your ad accounts. That's the first real ad-related feature.

---

## If something failed

Run through the relevant section of [06-troubleshooting.md](06-troubleshooting.md). The most useful first step is always:

```bash
docker compose logs --tail=100
```

If you're stuck, share that output and the specific test that failed.
