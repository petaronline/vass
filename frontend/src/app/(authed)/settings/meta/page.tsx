import { redirect } from 'next/navigation';

// The Meta connection UI lives in Settings → Connections (Meta tab). This
// bare route is kept only so old links still land somewhere sensible.
export default function MetaSettingsPage() {
  redirect('/settings/connections?tab=meta');
}
