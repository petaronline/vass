# 05 — Apache reverse proxy on WHM

Vass runs on `127.0.0.1:3000` (frontend) and `127.0.0.1:4000` (backend). To make it reachable at a domain like `vass.hyperstudio.com`, we configure Apache (managed by WHM) to forward requests to those ports.

This is called a **reverse proxy**.

---

## Step 1 — Decide on a domain or subdomain

Pick where Vass will live. Examples:

- `vass.hyperstudio.com` (subdomain — most common)
- `vass.yourcompany.com`
- A standalone domain like `vass.app` if you own one

For this guide, I'll use `vass.hyperstudio.com`. Replace it with yours.

---

## Step 2 — Point the DNS at your server

In your DNS provider (Cloudflare, Namecheap, GoDaddy, etc.), create an `A` record:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | vass | YOUR_SERVER_IP | Auto/300 |

If using Cloudflare, set the proxy to **DNS only** (gray cloud) initially. You can turn on the orange-cloud proxy later once you've confirmed everything works.

Wait 1-5 minutes for DNS to propagate, then verify:

```bash
dig vass.hyperstudio.com +short
```

Should print your server's IP.

---

## Step 3 — Create the subdomain in WHM

1. Log into **WHM**.
2. Search for **Account Functions → Create a New Account** if `hyperstudio.com` isn't already a cPanel account. Otherwise:
3. Log into the cPanel for `hyperstudio.com`.
4. Go to **Domains → Domains**.
5. Click **Create A New Domain**.
6. Domain: `vass.hyperstudio.com`. Uncheck "Share document root."
7. Document root: leave as default (we'll override Apache config in a moment).
8. Click **Submit**.

This makes cPanel aware of the subdomain so WHM/Apache will route requests for it.

---

## Step 4 — Add a custom Apache include for the reverse proxy

WHM regenerates its main Apache config periodically, so we **don't edit Apache's main config directly**. Instead, we use the "Include Editor" which survives WHM regenerations.

1. In **WHM**, search for **Apache Configuration → Include Editor**.
2. Under **Post VirtualHost Include**, select **All Versions** from the dropdown.
3. Click **Update**.
4. Paste this configuration, replacing `vass.hyperstudio.com` with your actual domain:

```apache
<VirtualHost *:80>
    ServerName vass.hyperstudio.com

    # Redirect all HTTP traffic to HTTPS
    RewriteEngine On
    RewriteCond %{HTTPS} !=on
    RewriteRule ^/?(.*) https://%{SERVER_NAME}/$1 [R=301,L]
</VirtualHost>

<VirtualHost *:443>
    ServerName vass.hyperstudio.com

    # SSL config — WHM AutoSSL fills these in automatically (paths may differ)
    SSLEngine on
    SSLCertificateFile      /var/cpanel/ssl/apache_tls/vass.hyperstudio.com/combined
    SSLCertificateKeyFile   /var/cpanel/ssl/apache_tls/vass.hyperstudio.com/combined

    # Proxy /api/* to the backend
    ProxyPreserveHost On
    ProxyRequests Off

    ProxyPass /api/ http://127.0.0.1:4000/
    ProxyPassReverse /api/ http://127.0.0.1:4000/

    # Proxy everything else to the frontend
    ProxyPass / http://127.0.0.1:3000/
    ProxyPassReverse / http://127.0.0.1:3000/

    # Pass real client IP through to Vass
    RequestHeader set X-Forwarded-Proto "https"
    RequestHeader set X-Forwarded-Host "vass.hyperstudio.com"

    # WebSocket upgrade (for Next.js dev tools — harmless in production)
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteCond %{HTTP:Connection} upgrade [NC]
    RewriteRule ^/?(.*) "ws://127.0.0.1:3000/$1" [P,L]
</VirtualHost>
```

5. Click **Update**.
6. WHM will run a syntax check. If it passes, it'll prompt you to **Restart Apache**. Click yes.

---

## Step 5 — Get an SSL certificate (free, automatic)

WHM ships with **AutoSSL** which provisions free Let's Encrypt certificates.

1. In **WHM**, search for **SSL/TLS → Manage AutoSSL**.
2. In the **Manage Users** tab, find the cPanel account that owns `hyperstudio.com`.
3. Click **Check `username`** to trigger AutoSSL for that account.
4. Wait 30-60 seconds. The status column will update.

To verify the certificate is issued:

```bash
curl -I https://vass.hyperstudio.com
```

You should see an `HTTP/2 200` or `HTTP/2 302` response, not a certificate error.

If AutoSSL fails: in WHM go to **SSL/TLS → Install an SSL Certificate** and follow the instructions for Let's Encrypt manual issuance. Most common cause of failure: DNS hasn't fully propagated yet — wait 10 minutes and try again.

---

## Step 6 — Update Vass to know its real URL

Edit `.env`:

```bash
cd /opt/vass
nano .env
```

Change the URL lines:

```bash
FRONTEND_URL=https://vass.hyperstudio.com
NEXT_PUBLIC_API_URL=https://vass.hyperstudio.com
```

`NEXT_PUBLIC_API_URL` is the same as `FRONTEND_URL` because Apache routes `/api/*` to the backend behind the scenes.

Restart so changes take effect:

```bash
docker compose down
docker compose up -d
```

---

## Step 7 — Test from a browser

Visit `https://vass.hyperstudio.com` from your own computer.

You should see:
- A valid (green padlock) SSL certificate
- The Vass login page

Sign in with your admin credentials. You should land on the dashboard.

---

## Troubleshooting

**"502 Bad Gateway"** — Apache can't reach the Node app on 127.0.0.1:3000. Make sure Vass is running:

```bash
docker compose ps
```

If `vass-frontend` isn't `Up`, see [06-troubleshooting.md](06-troubleshooting.md).

**"SSL certificate error"** — AutoSSL hasn't issued the cert yet. Wait 5-10 minutes and retry, or check **WHM → SSL/TLS → Manage AutoSSL → Logs** for the specific error.

**Login works but POST /auth/login returns CORS error** — Your `FRONTEND_URL` in `.env` doesn't match the actual URL you're visiting. They must match exactly, including `https://` vs `http://`.

**WHM regenerated config and the proxy stopped working** — Did you put it in the **Include Editor** as instructed in Step 4? If you edited the main httpd.conf directly, WHM has overwritten it. Use the Include Editor — it survives regenerations.
