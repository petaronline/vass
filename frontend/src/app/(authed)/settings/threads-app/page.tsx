import { redirect } from 'next/navigation';

export default function ThreadsAppSettingsPage() {
  redirect('/settings/connections?tab=threads');
}
