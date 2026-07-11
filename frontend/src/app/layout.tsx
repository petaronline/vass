/**
 * Root layout — wraps every page.
 *
 * Fonts: Geist Sans (display + body) + Geist Mono (code-ish bits).
 * Imported as `next/font` packages from `geist` — these inject CSS
 * variables (`--font-geist-sans`, `--font-geist-mono`) which the rest
 * of the app references via Tailwind's `font-sans`, `font-display`,
 * and `font-mono` utilities (see tailwind.config.js).
 *
 * We attach the variable classes on <html> so EVERY descendant —
 * including portal'd elements outside <body> — picks them up.
 */
import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'Vass',
  description: 'Launch ads, sharper. An internal tool by Hyper Studio.',
  icons: {
    icon: '/favicon.svg',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
