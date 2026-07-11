/**
 * Root route. Server-side, we check if the session cookie is valid by
 * pinging the backend. If yes → /dashboard. If no → /login.
 *
 * This avoids any flash of the wrong page on first load.
 */
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

export default async function RootPage() {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get('vass_session');

  if (!sessionCookie) {
    redirect('/login');
  }

  // Validate the session against the backend
  try {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://backend:4000';
    const res = await fetch(`${apiUrl}/auth/me`, {
      headers: {
        Cookie: `vass_session=${sessionCookie.value}`,
      },
      cache: 'no-store',
    });

    if (res.ok) {
      redirect('/dashboard');
    } else {
      redirect('/login');
    }
  } catch {
    redirect('/login');
  }
}
