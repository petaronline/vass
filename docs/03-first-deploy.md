# 03 — First deployment

By this point you should have:
- ✅ Docker installed on your server ([01-server-setup.md](01-server-setup.md))
- ✅ Meta credentials ready ([02-meta-setup.md](02-meta-setup.md))

This guide gets Vass running. ~10 minutes.

---

## Step 1 — Get the code on the server

You have two options:

### Option A — Clone from Git (recommended if you've pushed it to a repo)

```bash
cd /opt/vass
git clone <your-repo-url> .
```

### Option B — Upload via SCP from your local machine

From your local computer, in the folder containing the `vass` code:

```bash
scp -r ./vass root@your-server-ip:/opt/
```

Then SSH into the server:

```bash
ssh root@your-server-ip
cd /opt/vass
```

---

## Step 2 — Create the `.env` file

```bash
cp .env.example .env
```

Now edit `.env` with a text editor. `nano` is friendly:

```bash
nano .env
```

Fill in **every** field that's empty. Here's what each one is and how to set it:

```bash
# Application
NODE_ENV=production

# Postgres
POSTGRES_USER=vass
POSTGRES_PASSWORD=<GENERATE A LONG RANDOM STRING — see below>
POSTGRES_DB=vass

# Sessions
SESSION_SECRET=<GENERATE A LONG RANDOM STRING — see below>

# Meta — from docs/02-meta-setup.md
META_APP_ID=<your App ID>
META_APP_SECRET=<your App Secret>
META_SYSTEM_USER_TOKEN=<your System User Token>
META_BUSINESS_ID=<your Business ID>

# URLs — for localhost testing keep as-is. Change to your real domain later.
FRONTEND_URL=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:4000
```

### Generating the random secrets

To generate a strong random string, run this on the server:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

If Node isn't installed on the host, use this Docker one-liner:

```bash
docker run --rm node:20-alpine node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Run it **once for `POSTGRES_PASSWORD`** and **once for `SESSION_SECRET`** — never use the same value for both.

Save `.env` (in nano: `Ctrl+O`, Enter, then `Ctrl+X`).

---

## Step 3 — Lock down `.env` permissions

`.env` contains secrets. Make sure only root can read it:

```bash
chmod 600 .env
```

---

## Step 4 — Start everything

From `/opt/vass`:

```bash
docker compose up -d
```

What this does:
1. Downloads Postgres, Redis, and Node base images (~2-3 min first time)
2. Builds your backend and frontend images (~3-5 min first time)
3. Starts all four containers in the background

When it finishes, check everything is running:

```bash
docker compose ps
```

You should see four containers, all with status `Up`:

```
NAME             STATUS         PORTS
vass-postgres    Up (healthy)   127.0.0.1:5432->5432/tcp
vass-redis       Up (healthy)   127.0.0.1:6379->6379/tcp
vass-backend     Up             127.0.0.1:4000->4000/tcp
vass-frontend    Up             127.0.0.1:3000->3000/tcp
```

If any container says `Restarting` or `Exited`, see [06-troubleshooting.md](06-troubleshooting.md).

---

## Step 5 — Run the database migrations

This creates all the tables (users, sessions, ad_accounts, etc.):

```bash
docker compose exec backend npm run migrate
```

Expected output:

```
[migrate] Running database migrations...
[migrate] 1 pending migration(s):
  → applying 001_initial_schema.sql...
  ✓ 001_initial_schema.sql applied
[migrate] All migrations applied successfully.
```

---

## Step 6 — Create your first admin user

```bash
docker compose exec backend npm run create-user
```

You'll be prompted for:

```
Email: jw@hyperstudio.com
Name: jw
Role (admin/member/viewer) [admin]: admin
Password (min 12 chars): ************
Confirm password: ************

✓ Created user: jw <jw@hyperstudio.com> (admin)
```

**Important**: This is your only way in. Don't lose this password. If you do, see [06-troubleshooting.md](06-troubleshooting.md) for how to reset it from the database.

---

## Step 7 — Verify it works

Vass is now running, but only on `127.0.0.1` — meaning **only the server itself can reach it**, not the public internet. That's correct and intentional.

To test from your local computer, you can either:

### Option A — Set up the Apache proxy now (recommended for production)

Continue to [05-apache-proxy.md](05-apache-proxy.md). This makes Vass reachable at a real domain like `vass.hyperstudio.com`.

### Option B — SSH tunnel for quick testing

From your local computer:

```bash
ssh -L 3000:localhost:3000 root@your-server-ip
```

Leave that terminal open, then in your browser visit:

```
http://localhost:3000
```

You should see the Vass login page. Sign in with the user you just created.

If you can see the dashboard after login → **everything works**. 🎯

---

## What's next

- **Get a real domain working:** [05-apache-proxy.md](05-apache-proxy.md)
- **Day-to-day operations:** [04-day-to-day.md](04-day-to-day.md)
- **Something broken:** [06-troubleshooting.md](06-troubleshooting.md)
