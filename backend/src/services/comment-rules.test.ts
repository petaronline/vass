/**
 * Standalone test for the Comment Guard rule engine.
 * Run: npx tsx src/services/comment-rules.test.ts
 */
import assert from 'node:assert';
import { matchComment, normalizeRules, hasAnyRule, DEFAULT_RULES } from './comment-rules';

let passed = 0;
function check(name: string, cond: boolean) {
  assert.ok(cond, `FAILED: ${name}`);
  passed++;
}

const all = { links: true, phone: true, profanity: true, keywords: ['casino', 'free money'] };

// --- links ---
check('http url', matchComment('check https://spam.example/win now', all)?.rule === 'links');
check('www url', matchComment('go to www.spam.co for prizes', all)?.rule === 'links');
check('bare domain', matchComment('visit spammy.xyz today', all)?.rule === 'links');
check('no link clean', matchComment('great ad, love it!', all) === null);
check('email is not flagged as link', matchComment('reach me generally', { links: true }) === null);

// --- phone ---
check('intl phone', matchComment('call +1 (555) 123-4567', { phone: true })?.rule === 'phone');
check('spaced phone', matchComment('ring 0044 7911 123456 now', { phone: true })?.rule === 'phone');
check('short number not phone', matchComment('I rate it 10 out of 10', { phone: true }) === null);

// --- profanity (word-boundary) ---
check('profanity hit', matchComment('this is a scam', { profanity: true })?.rule === 'profanity');
check('profanity substring safe', matchComment('please assist me', { profanity: true }) === null);
check('profanity caps', matchComment('total FRAUD here', { profanity: true })?.rule === 'profanity');

// --- keywords ---
check('keyword hit', matchComment('best casino online', all)?.rule === 'keyword');
check('multiword keyword', matchComment('get free money fast', all)?.rule === 'keyword');
check('keyword substring safe', matchComment('this is a staycation', { keywords: ['casino'] }) === null);
check('keyword case-insensitive', matchComment('CASINO night', all)?.rule === 'keyword');

// --- priority order: links before keyword ---
const both = matchComment('free money at www.x.io', all);
check('links win over keyword', both?.rule === 'links');

// --- empty / whitespace ---
check('empty message', matchComment('', all) === null);
check('whitespace message', matchComment('   ', all) === null);
check('null message', matchComment(null, all) === null);

// --- matched detail is populated ---
check('detail populated', (matchComment('best casino', all)?.detail ?? '') === 'casino');

// --- normalizeRules ---
const norm = normalizeRules({ links: 'yes', keywords: ['A', 'a', ' b ', 123, ''] });
check('normalize coerces truthy', norm.links === true);
check('normalize dedupes+lowercases+trims keywords', JSON.stringify(norm.keywords) === JSON.stringify(['a', 'b']));
check('normalize defaults phone on', norm.phone === true);
check('normalize empty → defaults', JSON.stringify(normalizeRules({})) === JSON.stringify(DEFAULT_RULES));

// --- hasAnyRule ---
check('hasAnyRule true', hasAnyRule({ links: true }) === true);
check('hasAnyRule keywords', hasAnyRule({ keywords: ['x'] }) === true);
check('hasAnyRule all-off false', hasAnyRule({ links: false, phone: false, profanity: false, keywords: [] }) === false);

console.log(`\n✅ All ${passed} comment-rules assertions passed.`);
