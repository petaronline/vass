/**
 * Legacy redirect — /history was the Phase 0 placeholder name.
 * Phase 3 renamed it to /launches. We keep this around so old bookmarks
 * still work.
 */
import { redirect } from 'next/navigation';

export default function HistoryRedirect() {
  redirect('/launches');
}
