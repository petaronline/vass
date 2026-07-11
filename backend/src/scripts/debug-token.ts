/**
 * Diagnostic CLI: dump Meta's view of a connected account's tokens.
 *
 * Run inside the backend container:
 *   docker compose exec -T backend node /app/dist/scripts/debug-token.js
 *
 * Lists all connected accounts, then calls Meta's /debug_token for
 * each, showing the actual scope list Meta sees on the token (the
 * authoritative answer — not what we *think* we requested).
 *
 * No HTTP route, no cookie, no curl from outside. Pure server-side.
 */

import { query } from '../db/pool';
import { decryptSecret } from '../utils/crypto';
import { getAppCredentials } from '../services/meta-connection';
import crypto from 'crypto';

function appSecretProof(token: string, appSecret: string): string {
  return crypto.createHmac('sha256', appSecret).update(token).digest('hex');
}

/**
 * Try /pages/search with several parameter combinations, and report
 * exactly what Meta says for each. This will tell us whether it's the
 * scope, the proof, or the endpoint shape that Meta is rejecting.
 */
async function probePagesSearch(userToken: string, appSecret: string) {
  console.log(`\n──── Probing /pages/search with multiple shapes ────`);

  const proof = appSecretProof(userToken, appSecret);

  const variants: Array<{ name: string; url: string }> = [
    {
      name: 'A. Plain: token only (no proof)',
      url: `https://graph.facebook.com/v25.0/pages/search?q=Belgrade&fields=id,name,location&access_token=${encodeURIComponent(userToken)}`,
    },
    {
      name: 'B. With appsecret_proof',
      url: `https://graph.facebook.com/v25.0/pages/search?q=Belgrade&fields=id,name,location&access_token=${encodeURIComponent(userToken)}&appsecret_proof=${proof}`,
    },
    {
      name: 'C. Without "fields"',
      url: `https://graph.facebook.com/v25.0/pages/search?q=Belgrade&access_token=${encodeURIComponent(userToken)}&appsecret_proof=${proof}`,
    },
    {
      name: 'D. v19 (older API)',
      url: `https://graph.facebook.com/v19.0/pages/search?q=Belgrade&fields=id,name,location&access_token=${encodeURIComponent(userToken)}&appsecret_proof=${proof}`,
    },
    {
      name: 'E. /me/accounts (proves token can read pages)',
      url: `https://graph.facebook.com/v25.0/me/accounts?fields=id,name&access_token=${encodeURIComponent(userToken)}&appsecret_proof=${proof}`,
    },
    {
      name: 'F. /search?q=...&type=place (deprecated but try)',
      url: `https://graph.facebook.com/v25.0/search?q=Belgrade&type=place&access_token=${encodeURIComponent(userToken)}&appsecret_proof=${proof}`,
    },
  ];

  for (const v of variants) {
    const r = await fetch(v.url);
    const status = r.status;
    let body: any;
    try {
      body = await r.json();
    } catch {
      body = await r.text();
    }
    const summary = body?.error
      ? `ERROR ${body.error.code}/${body.error.error_subcode ?? '-'}: ${body.error.message}`
      : Array.isArray(body?.data)
        ? `OK — ${body.data.length} results`
        : `OK — ${JSON.stringify(body).slice(0, 100)}`;
    console.log(`  ${v.name}`);
    console.log(`    HTTP ${status}  →  ${summary}`);
  }
}

async function inspect(appAccessToken: string, token: string, label: string) {
  const url = `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(appAccessToken)}`;
  const r = await fetch(url);
  const j = (await r.json()) as {
    data?: {
      app_id?: string;
      type?: string;
      application?: string;
      data_access_expires_at?: number;
      expires_at?: number;
      is_valid?: boolean;
      issued_at?: number;
      scopes?: string[];
      user_id?: string;
      granular_scopes?: Array<{ scope: string; target_ids?: string[] }>;
    };
    error?: { message?: string; code?: number };
  };
  console.log(`\n────────────────────── ${label} ──────────────────────`);
  console.log(`HTTP ${r.status}`);
  if (j.error) {
    console.log(`ERROR: ${JSON.stringify(j.error, null, 2)}`);
    return;
  }
  if (!j.data) {
    console.log('No data returned');
    return;
  }
  console.log(`Type:           ${j.data.type ?? '?'}`);
  console.log(`App:            ${j.data.application ?? '?'} (${j.data.app_id ?? '?'})`);
  console.log(`User ID:        ${j.data.user_id ?? '?'}`);
  console.log(`Valid:          ${j.data.is_valid}`);
  console.log(`Issued:         ${j.data.issued_at ? new Date(j.data.issued_at * 1000).toISOString() : 'n/a'}`);
  console.log(`Expires:        ${j.data.expires_at ? new Date(j.data.expires_at * 1000).toISOString() : 'never'}`);
  console.log(`Data expires:   ${j.data.data_access_expires_at ? new Date(j.data.data_access_expires_at * 1000).toISOString() : 'n/a'}`);
  console.log(`\nScopes (${j.data.scopes?.length ?? 0}):`);
  for (const s of j.data.scopes ?? []) {
    const isKeyScope = ['pages_read_engagement', 'pages_manage_posts', 'pages_manage_engagement',
                        'pages_show_list', 'instagram_basic', 'instagram_content_publish',
                        'instagram_manage_comments', 'business_management', 'ads_management', 'ads_read'].includes(s);
    console.log(`  ${isKeyScope ? '★' : ' '} ${s}`);
  }
  if (j.data.granular_scopes && j.data.granular_scopes.length > 0) {
    console.log(`\nGranular scopes:`);
    for (const g of j.data.granular_scopes) {
      console.log(`  ${g.scope}${g.target_ids ? ` (${g.target_ids.length} targets)` : ''}`);
    }
  }
}

async function main() {
  const creds = await getAppCredentials();
  if (!creds) {
    console.error('No Meta App credentials configured. Set them in Settings → Meta first.');
    process.exit(1);
  }

  const appAccessToken = `${creds.appId}|${creds.appSecret}`;
  console.log(`Using app: ${creds.appId}`);

  const { rows } = await query<{
    id: string;
    platform: string;
    external_id: string;
    name: string | null;
    access_token_encrypted: string;
    parent_user_token_encrypted: string | null;
    scopes: string[] | null;
    user_id: string;
  }>(`
    SELECT a.id, a.platform, a.external_id,
           a.meta->>'name' AS name,
           a.access_token_encrypted,
           a.parent_user_token_encrypted,
           a.scopes,
           a.user_id
      FROM organic_connected_accounts a
     WHERE a.disconnected_at IS NULL
     ORDER BY a.created_at DESC
  `);

  if (rows.length === 0) {
    console.log('No connected accounts found.');
    return;
  }

  console.log(`\nFound ${rows.length} connected account(s). Inspecting first 2 only.\n`);

  const probedTokens = new Set<string>();

  for (const row of rows.slice(0, 2)) {
    console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
    console.log(`║ ${row.platform.padEnd(15)} ${(row.name ?? '(no name)').padEnd(46)} ║`);
    console.log(`║ id=${row.id}                              ║`);
    console.log(`║ external_id=${row.external_id.padEnd(40)}          ║`);
    console.log(`║ Vass-recorded scopes (${(row.scopes ?? []).length}):                                       ║`);
    for (const s of row.scopes ?? []) {
      console.log(`║   ${s.padEnd(64)}║`);
    }
    console.log(`╚══════════════════════════════════════════════════════════════════╝`);

    try {
      const accessToken = decryptSecret(row.access_token_encrypted);
      await inspect(appAccessToken, accessToken, 'Account/Page token');
    } catch (e) {
      console.log(`  Could not decrypt account token: ${e}`);
    }

    if (row.parent_user_token_encrypted) {
      try {
        const parent = decryptSecret(row.parent_user_token_encrypted);
        await inspect(appAccessToken, parent, 'Parent USER token (used for /pages/search)');

        // Only probe once per unique parent token (typically all
        // accounts share one parent user).
        if (!probedTokens.has(parent)) {
          probedTokens.add(parent);
          await probePagesSearch(parent, creds.appSecret);
        }
      } catch (e) {
        console.log(`  Could not decrypt parent token: ${e}`);
      }
    } else {
      console.log(`\nNo parent user token stored for this account.`);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
