/**
 * Session management.
 *
 * Approach:
 *   - On login, we generate a 256-bit random token (the "session id").
 *   - We hash it with SHA-256 and store ONLY the hash in the DB.
 *   - The raw token goes to the user as an httpOnly cookie.
 *   - On every request, we hash the incoming cookie and look it up.
 *   - If we ever leak the DB, attackers can't use the hashes to forge sessions.
 *
 * This is essentially how `connect-pg-simple` works, but written explicitly
 * so we understand exactly what's happening.
 */
import crypto from 'node:crypto';
import { query } from '../db/pool';

const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
}

function generateToken(): string {
  // 32 bytes = 256 bits of entropy, base64url-encoded
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Create a new session for a user. Returns the raw token (to set as a cookie).
 * The raw token is only seen once — after this, we only have the hash.
 */
export async function createSession(
  userId: string,
  ipAddress?: string,
  userAgent?: string
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, tokenHash, expiresAt, ipAddress ?? null, userAgent ?? null]
  );

  return { token, expiresAt };
}

/**
 * Look up the session for a given raw cookie token.
 * Returns null if the token is invalid, expired, or doesn't exist.
 * Also updates last_used_at as a side effect (for activity tracking).
 */
export async function findSession(token: string): Promise<Session | null> {
  if (!token || typeof token !== 'string') return null;

  const tokenHash = hashToken(token);
  const { rows } = await query<{
    id: string;
    user_id: string;
    expires_at: Date;
  }>(
    `SELECT id, user_id, expires_at
     FROM sessions
     WHERE token_hash = $1 AND expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  );

  if (rows.length === 0) return null;

  const row = rows[0];

  // Update last_used_at (don't await — fire and forget for speed)
  query('UPDATE sessions SET last_used_at = NOW() WHERE id = $1', [row.id]).catch(
    (err) => console.error('[session] Failed to update last_used_at:', err)
  );

  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
  };
}

/**
 * Revoke a single session (logout).
 */
export async function revokeSession(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}

/**
 * Revoke all sessions for a user (force logout everywhere).
 * Useful when a user changes their password or we suspect compromise.
 */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

/**
 * Cleanup expired sessions. Called periodically by a cron-like loop.
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const { rowCount } = await query('DELETE FROM sessions WHERE expires_at < NOW()');
  return rowCount;
}
