/**
 * Postgres connection pool.
 *
 * pg.Pool manages a set of connections automatically — opens new ones when
 * needed, reuses idle ones, closes them after a timeout. You never want to
 * open a new connection per request.
 */
import { Pool, PoolClient } from 'pg';
import { env } from '../utils/env';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,                      // up to 20 concurrent connections
  idleTimeoutMillis: 30_000,    // close idle connections after 30s
  connectionTimeoutMillis: 5_000, // give up acquiring a connection after 5s
});

// Surface unexpected pool errors instead of silently dying
pool.on('error', (err) => {
  console.error('[db] Unexpected pool error', err);
});

/**
 * Run a query with parameter binding (safe from SQL injection).
 *
 * Usage:
 *   const { rows } = await query<User>('SELECT * FROM users WHERE id = $1', [userId]);
 */
export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;

  if (duration > 500) {
    console.warn(`[db] Slow query (${duration}ms): ${text.slice(0, 120)}`);
  }

  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
}

/**
 * Run a series of statements in a transaction.
 * If the callback throws, everything rolls back.
 *
 * Usage:
 *   await transaction(async (client) => {
 *     await client.query('INSERT INTO users ...');
 *     await client.query('INSERT INTO audit_log ...');
 *   });
 */
export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Gracefully close all connections — called on app shutdown.
 */
export async function closePool(): Promise<void> {
  await pool.end();
}
