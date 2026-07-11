/**
 * Authenticated layout — wraps every page that requires a logged-in user.
 *
 * Server-side: validate the session cookie against the backend. If invalid,
 * redirect to /login. If valid, render the sidebar + top bar + page content.
 *
 * This is a Next.js layout, so it applies to every child route automatically.
 */
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { AppBackdrop } from '@/components/AppBackdrop';
import { CurrentUser } from '@/lib/api';

async function getCurrentUser(): Promise<CurrentUser | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get('vass_session');
  if (!sessionCookie) return null;

  try {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://backend:4000';
    const res = await fetch(`${apiUrl}/auth/me`, {
      headers: { Cookie: `vass_session=${sessionCookie.value}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.user;
  } catch {
    return null;
  }
}

export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  return (
    // The authed shell. The base colour is a near-white (#FBFAF8) so the
    // backdrop (`<AppBackdrop />`) can paint its soft tints + dot grid on
    // top via fixed layers. Sidebar, top bar, and main content all use
    // `relative z-10` to stack above those fixed backdrop layers.
    <div className="relative min-h-screen flex bg-[#FBFAF8]">
      <AppBackdrop />
      <Sidebar user={user} />
      <div className="flex-1 flex flex-col min-w-0 relative">
        <TopBar user={user} />
        <main className="flex-1 px-8 py-8">{children}</main>
      </div>
    </div>
  );
}
