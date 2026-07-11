/**
 * LinkedIn app credentials — TWO apps.
 *
 * LinkedIn's Community Management API (company-page posting) must be the
 * ONLY product on its app for legal/security reasons, so it cannot share
 * an app with "Share on LinkedIn" / "Sign In". We therefore support two
 * separate developer apps, each with its own Client ID/Secret/redirect:
 *
 *   - kind 'profile' → keys linkedin.*      → Share on LinkedIn + Sign In
 *                      scopes: openid profile w_member_social
 *                      → personal-profile posting
 *   - kind 'org'     → keys linkedin_org.*  → Community Management API
 *                      scopes: w_organization_social r_organization_social
 *                      → company-page posting
 *
 * Stored as workspace-wide rows in app_settings, same crypto as the rest.
 */

import { query } from '../db/pool';
import { decryptSecret, encryptSecret } from '../utils/crypto';
import { env } from '../utils/env';

export type LinkedInAppKind = 'profile' | 'org';

/** app_settings key prefix + default callback path per app kind. */
function appKeys(kind: LinkedInAppKind): {
  idKey: string;
  secretKey: string;
  redirectKey: string;
  defaultCallback: string;
} {
  if (kind === 'org') {
    return {
      idKey: 'linkedin_org.client_id',
      secretKey: 'linkedin_org.client_secret',
      redirectKey: 'linkedin_org.redirect_uri',
      defaultCallback: `${env.FRONTEND_URL}/api/organic/linkedin-org/callback`,
    };
  }
  return {
    idKey: 'linkedin.client_id',
    secretKey: 'linkedin.client_secret',
    redirectKey: 'linkedin.redirect_uri',
    defaultCallback: `${env.FRONTEND_URL}/api/organic/linkedin/callback`,
  };
}

async function getKeyValue(key: string): Promise<string | null> {
  const { rows } = await query<{ value: string | null }>(
    `SELECT value FROM app_settings WHERE key = $1 LIMIT 1`,
    [key]
  );
  return rows[0]?.value ?? null;
}

async function getKeyEncrypted(key: string): Promise<string | null> {
  const { rows } = await query<{ encrypted_value: string | null }>(
    `SELECT encrypted_value FROM app_settings WHERE key = $1 LIMIT 1`,
    [key]
  );
  const enc = rows[0]?.encrypted_value;
  if (!enc) return null;
  try {
    return decryptSecret(enc);
  } catch (e) {
    console.error('[linkedin-credentials] Could not decrypt secret for', key, e);
    return null;
  }
}

export interface LinkedInAppCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Returns null when any required value is missing for the given app. */
export async function getLinkedInAppCredentials(
  kind: LinkedInAppKind = 'profile'
): Promise<LinkedInAppCredentials | null> {
  const k = appKeys(kind);
  const [clientId, clientSecret, redirectOverride] = await Promise.all([
    getKeyValue(k.idKey),
    getKeyEncrypted(k.secretKey),
    getKeyValue(k.redirectKey),
  ]);
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: redirectOverride || k.defaultCallback,
  };
}

/** Whether the given LinkedIn app is configured. */
export async function isLinkedInConfigured(
  kind: LinkedInAppKind = 'profile'
): Promise<boolean> {
  return (await getLinkedInAppCredentials(kind)) !== null;
}

/** Non-secret view of a LinkedIn app config for the settings UI. */
export async function getDisplayableLinkedInConfig(
  kind: LinkedInAppKind = 'profile'
): Promise<{
  clientId: string | null;
  hasSecret: boolean;
  redirectUri: string;
}> {
  const k = appKeys(kind);
  const [clientId, secret, redirectOverride] = await Promise.all([
    getKeyValue(k.idKey),
    getKeyEncrypted(k.secretKey),
    getKeyValue(k.redirectKey),
  ]);
  return {
    clientId,
    hasSecret: !!secret,
    redirectUri: redirectOverride || k.defaultCallback,
  };
}

/** Persist LinkedIn app credentials for the given app (admin only). Only
 *  provided fields are written, so saving the id alone won't wipe the secret. */
export async function saveLinkedInCredentials(
  adminUserId: string,
  input: { clientId?: string; clientSecret?: string; redirectUri?: string },
  kind: LinkedInAppKind = 'profile'
): Promise<void> {
  const k = appKeys(kind);
  if (input.clientId !== undefined) {
    await query(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [k.idKey, input.clientId.trim() || null, adminUserId]
    );
  }
  if (input.clientSecret !== undefined) {
    const enc = input.clientSecret.trim().length > 0
      ? encryptSecret(input.clientSecret.trim())
      : null;
    await query(
      `INSERT INTO app_settings (key, encrypted_value, updated_by, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE
         SET encrypted_value = EXCLUDED.encrypted_value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [k.secretKey, enc, adminUserId]
    );
  }
  if (input.redirectUri !== undefined) {
    await query(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [k.redirectKey, input.redirectUri.trim() || null, adminUserId]
    );
  }
}
