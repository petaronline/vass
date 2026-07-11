/**
 * Migration runner.
 *
 * Reads all .sql files in this directory (alphabetical order), tracks which
 * have been applied in a `migrations` table, runs new ones.
 *
 * Idempotent: safe to run on every deploy.
 *
 * Usage:
 *   npm run migrate
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from './pool';

// When compiled, __dirname is /app/dist/db, but SQL files live at /app/src/db.
// We try both — works in dev (tsx, __dirname = src/db) and prod (compiled, __dirname = dist/db).
const CANDIDATE_DIRS = [
  __dirname,
  path.resolve(__dirname, '../../src/db'),
];

async function findMigrationsDir(): Promise<string> {
  for (const dir of CANDIDATE_DIRS) {
    try {
      const entries = await fs.readdir(dir);
      if (entries.some((f) => f.endsWith('.sql'))) {
        return dir;
      }
    } catch {
      // Try the next one
    }
  }
  throw new Error(
    `No migrations directory found. Tried: ${CANDIDATE_DIRS.join(', ')}`
  );
}

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id          SERIAL PRIMARY KEY,
      filename    TEXT NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const { rows } = await pool.query<{ filename: string }>(
    'SELECT filename FROM migrations'
  );
  return new Set(rows.map((r) => r.filename));
}

async function getPendingMigrationFiles(dir: string, applied: Set<string>): Promise<string[]> {
  const entries = await fs.readdir(dir);
  return entries
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => !applied.has(f));
}

async function applyMigration(dir: string, filename: string): Promise<void> {
  const filepath = path.join(dir, filename);
  const sql = await fs.readFile(filepath, 'utf-8');

  console.log(`  → applying ${filename}...`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO migrations (filename) VALUES ($1)', [filename]);
    await client.query('COMMIT');
    console.log(`  ✓ ${filename} applied`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`  ✗ ${filename} failed`);
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  console.log('[migrate] Running database migrations...');

  const dir = await findMigrationsDir();
  console.log(`[migrate] Using migrations directory: ${dir}`);

  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();
  const pending = await getPendingMigrationFiles(dir, applied);

  if (pending.length === 0) {
    console.log('[migrate] No pending migrations. Database is up to date.');
    await pool.end();
    return;
  }

  console.log(`[migrate] ${pending.length} pending migration(s):`);
  for (const file of pending) {
    await applyMigration(dir, file);
  }

  console.log('[migrate] All migrations applied successfully.');
  await pool.end();
}

main().catch((err) => {
  console.error('[migrate] Migration failed:', err);
  process.exit(1);
});
