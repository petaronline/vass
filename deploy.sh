#!/usr/bin/env bash
#
# Vass deploy helper — run from your Mac, in the repo root:  ./deploy.sh
#
# It does EVERYTHING that can be done safely from here:
#   1. Builds backend (tsc) + frontend (next build) and ABORTS if either fails
#      — so a broken build can never reach the server (the #1 thing that broke
#      prod before).
#   2. Packages an app-code-only patch zip (backend/ + frontend/).
#   3. Cleans the server staging dir so stale files can't get re-injected.
#   4. Uploads the zip.
#   5. Prints the ONE root command to finish the install (self-heals the
#      port-4040 race automatically).
#
# It deliberately does NOT touch supervise.sh behavior or run anything as root.
# The final install runs migrations via install-patch.sh at deploy time — never
# in the container boot path.
#
set -euo pipefail

# --- config ---
SERVER="petaronline@vass.petaronline.us"
STAGING="/home/petaronline/public_html/vass"
REPO="$(cd "$(dirname "$0")" && pwd)"

# Node lives here on this Mac (installed outside Homebrew).
export PATH="$HOME/.local/node/bin:$PATH"

STAMP="$(date +%Y%m%d-%H%M%S)"
ZIP="vass-patch-${STAMP}.zip"
ZIP_LOCAL="/tmp/${ZIP}"

echo "==> [1/5] Building backend (tsc)…"
( cd "$REPO/backend" && npm run build >/dev/null )
echo "    backend build OK"

echo "==> [2/5] Building frontend (next build)…"
( cd "$REPO/frontend" && npm run build >/dev/null 2>&1 )
echo "    frontend build OK"

echo "==> [3/5] Packaging ${ZIP} (app code only)…"
rm -f "$ZIP_LOCAL"
( cd "$REPO" && zip -rq "$ZIP_LOCAL" backend frontend \
    -x '*/node_modules/*' -x '*/.next/*' -x '*/dist/*' -x '*/.git/*' \
    -x '*.tsbuildinfo' -x '*/.DS_Store' )
echo "    $(du -h "$ZIP_LOCAL" | cut -f1) packaged"

echo "==> [4/5] Cleaning server staging + uploading…"
# Remove previously-extracted trees so install-patch can't re-inject stale files.
ssh -o BatchMode=yes "$SERVER" "rm -rf '$STAGING/backend' '$STAGING/frontend'"
scp -o BatchMode=yes "$ZIP_LOCAL" "$SERVER:$STAGING/"
echo "    uploaded to $STAGING/$ZIP"

echo "==> [5/5] Done. Finish on the server AS ROOT with:"
echo
echo "    /opt/vass/install-patch.sh $STAGING/$ZIP && \\"
echo "      ( sleep 5; ss -tln | grep -q ':4040' || ( cd /opt/vass && docker compose restart backend ) )"
echo
echo "Then verify from anywhere:"
echo "    curl -s -o /dev/null -w '%{http_code}\\n' https://vass.petaronline.us/api/health   # expect 200"
