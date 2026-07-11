import { redirect } from 'next/navigation';

export default function TikTokAppSettingsPage() {
  redirect('/settings/connections?tab=tiktok');
}
