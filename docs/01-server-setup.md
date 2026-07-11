# 01 — Server setup

This is a **one-time** setup. You only need to do this when you first prepare the server.

## Requirements

- Your WHM/cPanel server with **root SSH access**
- A Linux distribution Docker supports: AlmaLinux, CloudLinux, CentOS, Rocky, or Ubuntu
- At least **2GB of RAM free** (4GB recommended)
- At least **10GB of disk space free**

## Step 1 — SSH into your server

From your local computer:

```bash
ssh root@your-server-ip
```

(Or whatever username has sudo privileges. Replace `your-server-ip` with the real IP or hostname.)

## Step 2 — Install Docker

Docker provides a universal install script that works on all major distros:

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh
```

This takes 2–3 minutes. When it finishes, verify:

```bash
docker --version
docker compose version
```

You should see something like:

```
Docker version 27.x.x, build xxxxx
Docker Compose version v2.x.x
```

If `docker compose version` says "unknown command", install the compose plugin manually:

```bash
# For AlmaLinux / RHEL / CentOS / Rocky
yum install -y docker-compose-plugin

# For Ubuntu / Debian
apt install -y docker-compose-plugin
```

## Step 3 — Start Docker and enable on boot

```bash
systemctl enable --now docker
```

This makes Docker start automatically every time the server reboots, so Vass comes back up on its own.

## Step 4 — Verify Docker is running

```bash
docker run --rm hello-world
```

You should see a "Hello from Docker!" message. If yes, Docker is working.

## Step 5 — (WHM-specific) Confirm Docker doesn't conflict with WHM

WHM manages Apache, MySQL, and email on standard ports (80, 443, 3306, 25). Vass only uses ports **3000** (frontend), **4000** (backend), **5432** (Postgres), and **6379** (Redis), and all four are bound to `127.0.0.1` (localhost only).

This means:
- WHM keeps full control of public web traffic on 80/443
- Vass is invisible from the internet until we point Apache at it (see [05-apache-proxy.md](05-apache-proxy.md))
- No port conflicts with anything WHM does

You **don't** need to disable any WHM services. They coexist cleanly.

## Step 6 — Create a folder for Vass

```bash
mkdir -p /opt/vass
cd /opt/vass
```

You can put Vass anywhere, but `/opt/vass` is conventional for self-hosted apps and won't conflict with cPanel user accounts.

## Done

Server is ready. Next: [02-meta-setup.md](02-meta-setup.md) to get your Meta credentials.

---

## Reference: useful Docker commands you'll learn

| What you want | Command |
|---|---|
| See running containers | `docker ps` |
| See all containers | `docker ps -a` |
| See logs of a container | `docker logs <container-name>` |
| Get into a container's shell | `docker exec -it <container-name> sh` |
| See disk used by Docker | `docker system df` |
| Free up space | `docker system prune` |
