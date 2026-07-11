/**
 * CLI: manually set the page_id (and optionally picture_url) on an ad account.
 *
 * Used when Meta's /promote_pages endpoint can't reach the Page (common for
 * agency-shared accounts where you advertise on a Page you don't admin).
 *
 * Usage:
 *   docker compose exec backend node dist/scripts/set-page.js <account-name-substring> <page-id>
 *
 * Example:
 *   docker compose exec backend node dist/scripts/set-page.js "Stagestep Ads Manager" 200573290116242
 *
 * The first argument matches ad account names case-insensitively. If multiple
 * match, the script will list them and refuse to proceed.
 */
import { query, closePool } from '../db/pool';

async function main(): Promise<void> {
  const [nameLike, pageId] = process.argv.slice(2);
  if (!nameLike || !pageId) {
    console.error('Usage: node dist/scripts/set-page.js <account-name-substring> <page-id>');
    process.exit(2);
  }
  if (!/^\d{6,}$/.test(pageId)) {
    console.error(`Page ID "${pageId}" looks wrong — should be all digits.`);
    process.exit(2);
  }

  // Find candidates
  const { rows } = await query<{ id: string; name: string; meta_account_id: string; page_id: string | null }>(
    `SELECT id, name, meta_account_id, page_id
     FROM ad_accounts
     WHERE LOWER(name) LIKE LOWER($1)`,
    [`%${nameLike}%`]
  );

  if (rows.length === 0) {
    console.error(`No ad accounts match "${nameLike}".`);
    process.exit(1);
  }
  if (rows.length > 1) {
    console.error(`Multiple accounts match "${nameLike}":`);
    for (const r of rows) console.error(`  - ${r.name}  (${r.meta_account_id})`);
    console.error('Use a more specific substring.');
    process.exit(1);
  }

  const account = rows[0];
  await query(`UPDATE ad_accounts SET page_id = $1 WHERE id = $2`, [pageId, account.id]);
  console.log(`Set page_id on "${account.name}" (${account.meta_account_id}) → ${pageId}`);
  await closePool();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
