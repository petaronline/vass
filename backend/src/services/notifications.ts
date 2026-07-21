/**
 * Notifications service — powers the top-bar bell.
 *
 * Writers call `notify()` from wherever an interesting event happens (launch
 * finished, Comment Guard hid comments, a token is expiring, a sync failed).
 *
 * IMPORTANT for callers: `notify()` NEVER throws. A notification is a
 * side-effect of real work — it must not be able to fail a launch, a sweep, or
 * a sync. Errors are logged and swallowed.
 *
 * Pass a `dedupeKey` for anything recurring so the bell doesn't get spammed;
 * a repeat insert with the same (user, key) is silently dropped.
 */
import { query } from '../db/pool';
import type { PoolClient } from 'pg';

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';

export interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  link: string | null;
  metadata: Record<string, unknown>;
  dedupe_key: string | null;
  read_at: Date | null;
  created_at: Date;
  [k: string]: unknown;
}

export interface NotifyInput {
  userId: string;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  severity?: NotificationSeverity;
  metadata?: Record<string, unknown>;
  /** Stable key to collapse repeats (e.g. "launch:<batchId>"). */
  dedupeKey?: string | null;
  /** Run on an existing transaction client instead of the pool. */
  client?: PoolClient;
}

/** Record a notification. Never throws. */
export async function notify(input: NotifyInput): Promise<void> {
  const sql = `
    INSERT INTO notifications (
      user_id, type, severity, title, body, link, metadata, dedupe_key
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT DO NOTHING`;
  const params = [
    input.userId,
    input.type,
    input.severity ?? 'info',
    input.title,
    input.body ?? null,
    input.link ?? null,
    JSON.stringify(input.metadata ?? {}),
    input.dedupeKey ?? null,
  ];
  try {
    if (input.client) {
      await input.client.query(sql, params);
    } else {
      await query(sql, params);
    }
  } catch (err) {
    // Swallow — a failed notification must never break the caller's work.
    console.warn(
      `[notifications] failed to record ${input.type}:`,
      err instanceof Error ? err.message : err
    );
  }
}

export async function listForUser(
  userId: string,
  limit = 30
): Promise<NotificationRow[]> {
  const { rows } = await query<NotificationRow>(
    `SELECT * FROM notifications
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

export async function unreadCount(userId: string): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM notifications
      WHERE user_id = $1 AND read_at IS NULL`,
    [userId]
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}

/** Mark specific ids read, or all of the user's notifications when ids omitted. */
export async function markRead(userId: string, ids?: string[]): Promise<number> {
  if (ids && ids.length > 0) {
    const { rowCount } = await query(
      `UPDATE notifications SET read_at = NOW()
        WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL`,
      [userId, ids]
    );
    return rowCount ?? 0;
  }
  const { rowCount } = await query(
    `UPDATE notifications SET read_at = NOW()
      WHERE user_id = $1 AND read_at IS NULL`,
    [userId]
  );
  return rowCount ?? 0;
}

export async function clearAll(userId: string): Promise<number> {
  const { rowCount } = await query(`DELETE FROM notifications WHERE user_id = $1`, [
    userId,
  ]);
  return rowCount ?? 0;
}
