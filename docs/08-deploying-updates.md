# 08 — Deploying updates (the clean way)

There is **no GitHub auto-deploy.** GitHub is source storage. Deploys happen by
uploading a patch to the server and running the installer as root. `deploy.sh`
in the repo root automates everything except the final root command.

## The whole flow

From your Mac, in the repo:

```bash
./deploy.sh
```

That builds + verifies both apps, packages a patch, cleans staging, and uploads
it. It ends by printing one command. SSH to the box (`ssh petaronline@vass.petaronline.us`,
then become root) and paste it:

```bash
/opt/vass/install-patch.sh /home/petaronline/public_html/vass/vass-patch-<stamp>.zip && \
  ( sleep 5; ss -tln | grep -q ':4040' || ( cd /opt/vass && docker compose restart backend ) )
```

Verify:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://vass.petaronline.us/api/health   # 200
```

## Hard-won rules (why prod broke once)

1. **Never put migrations in `supervise.sh` / the container boot path.** A failing
   or hanging migration then crash-loops or silently kills the API. Migrations
   run once, at deploy time, via `install-patch.sh`. Keep `supervise.sh`
   byte-identical to what's in the repo.
2. **A broken build must never reach the server.** `deploy.sh` runs `tsc` and
   `next build` and aborts on failure. Don't skip it.
3. **Clean staging before install.** `install-patch.sh` does `unzip -o` (never
   deletes) then `cp -rf` into `/opt/vass`. Stale files in
   `/home/petaronline/public_html/vass/{backend,frontend}` get re-injected and
   can break the rebuild. `deploy.sh` removes them first.
4. **Watch the port-4040 race.** With `network_mode: host`, a force-recreate can
   briefly collide on 4040 and kill the new API. The install command above
   restarts the backend if 4040 isn't listening after 5s.
5. **Migrations are tracked by filename and must be self-consistent.** Never edit
   an applied migration's effect; add a new numbered file. A new CHECK-constraint
   migration must list the *full union* of every status the code writes (this is
   what bit `027`).
