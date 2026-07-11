/**
 * CLI: manually set instagram_user_id on an ad account.
 *
 * Used when Meta's /instagram_accounts endpoint can't reach the IG account
 * (common for agency-shared accounts).
 *
 * Usage:
 *   docker compose exec backend node dist/scripts/set-instagram.js <account-name-substring> <instagram-user-id>
 *
 * Example:
 *   docker compose exec backend node dist/scripts/set-instagram.js "Stagestep Ads Manager" 17841401234567890
 *
 * Pass "" (empty) for the instagram-user-id to CLEAR it.
 */
import { query, closePool } from '../db/pool';

async function main(): Promise<void> {
  const [nameLike, instagramId] = process.argv.slice(2);
  if (nameLike === undefined || instagramId === undefined) {
    console.error('Usage: node dist/scripts/set-instagram.js <account-name-substring> <instagram-user-id>');
    console.error('Pass "" (empty) for instagram-user-id to clear it.');
    process.exit(2);
  }
  if (instagramId !== '' && !/^\d{6,}$/.test(instagramId)) {
    console.error(`Instagram User ID "${instagramId}" looks wrong — should be all digits, or "" to clear.`);
    process.exit(2);
  }

  const { rows } = await query<{ id: string; name: string; meta_account_id: string; instagram_user_id: string | null }>(
    `SELECT id, name, meta_account_id, instagram_user_id
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
  const newValue = instagramId === '' ? null : instagramId;
  await query(`UPDATE ad_accounts SET instagram_user_id = $1 WHERE id = $2`, [newValue, account.id]);
  if (newValue) {
    console.log(`Set instagram_user_id on "${account.name}" (${account.meta_account_id}) → ${newValue}`);
  } else {
    console.log(`Cleared instagram_user_id on "${account.name}" (${account.meta_account_id})`);
  }
  await closePool();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
