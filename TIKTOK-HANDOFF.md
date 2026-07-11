# Vass — TikTok Publishing Handoff (resume in new chat)

Last updated: 2026-05-29. Hand this to a new chat to continue.

## Project basics
- Vass = Meta/organic social + ads launcher. Live at https://vass.petaronline.us, code at /opt/vass.
- Stack: Node 20 + TS + Express + Postgres 16 + Redis + BullMQ (backend port 4040); Next.js 15 App Router + Tailwind + Lucide (port 3030). Docker compose, backend container = `vass-backend` (app root `/app`). Apache reverse proxy.
- Install a patch: `/opt/vass/install-patch.sh /home/petaronline/public_html/vass/vass-patch-X.X.X.zip` (self-updates, runs migrations, restarts backend).
- Diagnostics run from inside the container: `docker cp <file> vass-backend:/app/ && docker exec -it vass-backend sh -c 'cd /app && node <file>'`. Watch logs: `docker logs -f vass-backend 2>&1 | grep -iE "tiktok|publish|error"`.

## What TikTok publishing IS (already built + installed)
Patches 4.43.0 and 4.43.1 are written and (should be) installed on live. They deliver the FULL TikTok integration:
- **4.43.0** — OAuth connect/callback + token refresh (24h access / 365d refresh, encrypted), credentials settings page (Settings → Connections → TikTok App), connect button (Settings → Social profiles), the publisher (video + photo carousel via PULL_FROM_URL), per-post settings persisted, creator-info endpoint. Migrations 032 (tiktok platform + refresh token cols) + 033 (per-post tiktok settings cols on organic_posts).
- **4.43.1** — composer integration: TikTok selectable as a target, mandatory creator-info display (name/avatar), privacy dropdown (from creator_info allowed levels), commercial-disclosure toggles (your-brand / branded-content), interaction toggles (comment/duet/stitch). Settings persist + round-trip on edit.

Key backend files: `backend/src/services/tiktok-credentials.ts`, `tiktok-connection.ts`, `tiktok-publisher.ts`; `routes/organic.ts` (tiktok routes ~469-580, creator-info, publishSchema.tiktok, POST insert, PATCH persist, GET /posts/:id exposes tiktok fields); `routes/settings.ts` (/tiktok-app). Frontend: `lib/api.ts` (tiktokApp, getTikTokOAuthUrl, getTikTokCreatorInfo, PublishPostInput.tiktok, OrganicPostDetail.post.tiktok*), `components/settings/TikTokAppSection.tsx`, `components/studio/ComposerModal.tsx` (TikTokOptions component at end of file).

## CURRENT STATUS — where we are right now
1. **OAuth WORKS.** Earlier `client_key` error was a redirect-URI mismatch. Now resolved.
2. **A SANDBOX app is in use** (not production). User couldn't save the PRODUCTION app without a demo video (TikTok gates the Save button on a demo video). Sandbox sidesteps this — sandbox apps save fine, allow up to 10 target users, force all posts SELF_ONLY.
   - User swapped Vass's TikTok Client Key/Secret + redirect to the SANDBOX app's values.
   - `non_sandbox_target` error was fixed by adding the TikTok account as a target user in the sandbox.
3. **Connect succeeds.** Account is linked.
4. **Publish FAILS** with this exact TikTok error (confirmed in backend logs):
   ```
   TikTok API error: Please review our URL ownership verification rules at
   https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide/#pull_from_url
   ```

## THE ACTIVE BLOCKER (do this next)
The publisher uses PULL_FROM_URL — it hands TikTok a Vass media URL (`https://vass.petaronline.us/...`) to fetch the video from. TikTok refuses to pull from any domain not verified as a trusted URL prefix in the developer portal.

**FIX (TikTok portal, NOT a code change):**
- TikTok developer portal → the app → URL properties / URL prefix verification (Content Posting API config / "Domain verification" / "Trusted domains").
- Add + verify `https://vass.petaronline.us/` via the method TikTok offers (DNS TXT record OR a verification file at the domain root).
- After verification, retry the post. It will publish PRIVATELY (SELF_ONLY) in sandbox — that is CORRECT pre-audit, not a failure.

This is the ONLY thing standing between the user and a working end-to-end post. Integration code is confirmed correct (OAuth + composer + publisher all run; only the portal trust setting was missing).

## WHY THIS MATTERS (the goal)
User needs to **record a demo video of the posting flow** to submit for TikTok's Content Posting API audit (required to go from sandbox/private to public posting). The production app's Save is gated on this video. Plan: get a clean post working in sandbox → screen-record the flow → upload as the audit demo video.

**What the demo video must show (one continuous recording):**
1. OAuth: Settings → Social profiles → Connect TikTok → consent screen → back connected.
2. Composer: select the TikTok account → creator name/avatar appears.
3. Privacy dropdown → pick a level.
4. Commercial-content disclosure toggle → your-brand / branded-content sub-toggles.
5. Interaction toggles (comment/duet/stitch).
6. Attach media + Publish (publishes privately pre-audit — fine for the video).

## KNOWN SECONDARY BUG (not blocking, fix later)
When a publish fully fails, patch 4.42.0 routes the post back to Drafts and **wipes the per-target error_message** — so the failure reason vanishes from the UI and DB (the diag query returned `[]` for failed tiktok targets). The error was only recoverable from backend logs. RECOMMENDED follow-up patch: when routing a failed post to draft, preserve the failure reason somewhere user-visible (e.g. keep error_message on the post or surface a "last failed because…" note in Drafts). User was asked and we deferred this until after the post works.

## ROADMAP (after TikTok is done)
TikTok is the current focus. After it: other networks → then the BIG analytics build (post detail page / insights / comments live there) → boosting/unified paid+organic LAST. Dropped permanently (user reasoned against): validation badge, auto-grouping at connect time.

## USER WORKING STYLE (important)
Blunt and fast-moving. Do NOT over-ask, but do NOT assume. When the user gives direction, ACT. Re-read the user's literal words against what's delivered before claiming done — "compiles" ≠ "works." Don't recommend things known to be impossible. The user reasons carefully about product decisions; reflect their reasoning, don't push a build. Patches: flat zip (backend/ + frontend/ at root), DELETE.txt + scripts/install-patch.sh carry-forward + PATCH-X.X.X-INSTALL.md with the install command at top. Compile-test before zipping (backend `npx tsc --noEmit`; frontend `NEXT_PUBLIC_API_URL=http://localhost:4040 npx --no next build`).
