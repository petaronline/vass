/**
 * User service — anything that touches the `users` table.
 *
 * Passwords are hashed with bcrypt (cost factor 12 — good balance of security
 * and CPU on a modern server). We never log, return, or otherwise expose
 * password_hash from this module.
 */
import bcrypt from 'bcryptjs';
import { query } from '../db/pool';

const BCRYPT_COST = 12;

export type UserRole = 'admin' | 'member' | 'viewer';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  avatarUrl: string | null;
  /**
   * Optional: a Spotify track or playlist URL the user has set as their
   * current "launch jam". Rendered on the dashboard via Spotify's public
   * embed iframe. Lightweight vibe feature — no OAuth.
   */
  spotifyTrackUrl: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

// Internal type that includes the hash — never returned from public functions
interface UserWithHash extends User {
  passwordHash: string;
}

function rowToUser(row: any): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    avatarUrl: row.avatar_url,
    spotifyTrackUrl: row.spotify_track_url ?? null,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const { rows } = await query<any>(
    `SELECT id, email, name, role, avatar_url, spotify_track_url, last_login_at, created_at
     FROM users
     WHERE email = $1 AND deleted_at IS NULL
     LIMIT 1`,
    [email]
  );
  return rows[0] ? rowToUser(rows[0]) : null;
}

export async function findUserById(id: string): Promise<User | null> {
  const { rows } = await query<any>(
    `SELECT id, email, name, role, avatar_url, spotify_track_url, last_login_at, created_at
     FROM users
     WHERE id = $1 AND deleted_at IS NULL
     LIMIT 1`,
    [id]
  );
  return rows[0] ? rowToUser(rows[0]) : null;
}

/**
 * Verify an email + password combination.
 * Returns the user on success, null on failure.
 *
 * Important: we run bcrypt.compare even when the user doesn't exist, to
 * prevent timing attacks (an attacker could otherwise tell which emails
 * are registered by measuring response time).
 */
export async function verifyCredentials(
  email: string,
  password: string
): Promise<User | null> {
  const { rows } = await query<any>(
    `SELECT id, email, name, role, avatar_url, spotify_track_url, last_login_at, created_at, password_hash
     FROM users
     WHERE email = $1 AND deleted_at IS NULL
     LIMIT 1`,
    [email]
  );

  // Run bcrypt even for missing users (timing-attack mitigation)
  const fakeHash =
    '$2b$12$0123456789012345678901uABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg';
  const hash = rows[0]?.password_hash ?? fakeHash;
  const isMatch = await bcrypt.compare(password, hash);

  if (rows.length === 0 || !isMatch) return null;

  // Update last_login_at
  await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [rows[0].id]);

  return rowToUser(rows[0]);
}

export async function createUser(input: {
  email: string;
  name: string;
  password: string;
  role?: UserRole;
}): Promise<User> {
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);

  const { rows } = await query<any>(
    `INSERT INTO users (email, name, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, name, role, avatar_url, spotify_track_url, last_login_at, created_at`,
    [input.email.toLowerCase(), input.name, passwordHash, input.role ?? 'member']
  );

  return rowToUser(rows[0]);
}

export async function updatePassword(userId: string, newPassword: string): Promise<void> {
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
}

/**
 * Update the user's Spotify track / playlist URL. Pass null to clear it.
 * Stored verbatim — the frontend embeds whatever URL the user pastes.
 */
export async function updateSpotifyTrackUrl(
  userId: string,
  url: string | null
): Promise<void> {
  await query(
    `UPDATE users SET spotify_track_url = $1, updated_at = NOW() WHERE id = $2`,
    [url, userId]
  );
}

/**
 * List every non-deleted user, newest first. Used by the admin Team page.
 */
export async function listUsers(): Promise<User[]> {
  const { rows } = await query<any>(
    `SELECT id, email, name, role, avatar_url, spotify_track_url,
            last_login_at, created_at
       FROM users
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC`
  );
  return rows.map(rowToUser);
}

/**
 * Soft-delete a user. We don't hard-delete because users own
 * launch_batches, audit_runs, uploads, etc. and we want history to
 * remain intact. The user can no longer log in (sessions stale + email
 * effectively freed for re-use since the index is partial on deleted_at).
 */
export async function softDeleteUser(userId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE users
        SET deleted_at = NOW(),
            updated_at = NOW(),
            -- Null the password so any stolen session can't trivially
            -- be rotated back via password reset. Email keeps for
            -- audit-log readability.
            password_hash = ''
      WHERE id = $1 AND deleted_at IS NULL`,
    [userId]
  );
  // Also blow away any active sessions so they get logged out immediately.
  await query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  return (rowCount ?? 0) > 0;
}

/**
 * Change a user's role. No-op if the user is already at that role.
 */
export async function updateUserRole(
  userId: string,
  role: UserRole
): Promise<User | null> {
  const { rows } = await query<any>(
    `UPDATE users
        SET role = $2, updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, email, name, role, avatar_url, spotify_track_url,
                last_login_at, created_at`,
    [userId, role]
  );
  return rows[0] ? rowToUser(rows[0]) : null;
}

/**
 * Count remaining (non-deleted) admins. Used as a guard before allowing
 * the last admin to be deleted or demoted to a non-admin role — which
 * would lock the workspace's admin functions (App credentials, etc.).
 */
export async function countAdmins(): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count
       FROM users
      WHERE role = 'admin' AND deleted_at IS NULL`
  );
  return Number(rows[0].count);
}
