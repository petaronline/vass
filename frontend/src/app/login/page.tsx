'use client';

/**
 * Login page.
 *
 * Matches the approved mockup:
 *   - Centered card on light gray background
 *   - "Vass↗" wordmark at top
 *   - Welcome heading + subtitle
 *   - Uppercase labels above each input
 *   - Electric blue primary button
 *   - Pronunciation footer
 */
import { useEffect, useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { auth, branding, ApiError } from '@/lib/api';
import { VassLogo } from '@/components/VassLogo';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Custom workspace logo, if an admin uploaded one. The /branding GET
  // endpoint is intentionally public so the login screen can show it
  // before any user has authenticated.
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    branding
      .get()
      .then((r) => !cancelled && setLogoDataUrl(r.logoDataUrl))
      .catch(() => { /* fall back to default */ });
    return () => { cancelled = true; };
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await auth.login(email, password);
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-surface-alt flex items-center justify-center px-4">
      <div className="w-full max-w-[420px] animate-slide-up">
        <div className="bg-surface rounded-lg px-14 py-12 shadow-lift">
          {/* Logo — custom workspace upload if present, otherwise the
              built-in Vass wordmark. */}
          <div className="mb-10">
            {logoDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoDataUrl}
                alt="Workspace logo"
                className="max-h-[36px] max-w-[180px] object-contain"
              />
            ) : (
              <VassLogo variant="full" height={32} color="#0A0A0A" />
            )}
          </div>

          {/* Heading */}
          <h1 className="font-display text-3xl font-bold tracking-tight text-ink leading-[1.15] mb-2">
            Welcome back.
          </h1>
          <p className="text-sm text-ink-muted mb-8">
            Sign in to launch sharper ad campaigns.
          </p>

          {/* Form */}
          <form onSubmit={handleSubmit} noValidate>
            <div className="mb-[18px]">
              <label htmlFor="email" className="label">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                disabled={submitting}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@hyperstudio.com"
                className="input"
              />
            </div>

            <div className="mb-[18px]">
              <label htmlFor="password" className="label">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                disabled={submitting}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                className="input"
              />
            </div>

            {error && (
              <div
                role="alert"
                className="mb-4 text-sm text-danger bg-red-50 border border-red-100 rounded-sm px-3 py-2"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !email || !password}
              className="btn-primary w-full mt-2"
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          {/* Pronunciation footer */}
          <p className="text-xs text-ink-subtle text-center mt-6 leading-relaxed">
            Vass <span className="text-ink-muted">/vas/</span> — Swedish for <em>sharp</em>.
            <br />
            By{' '}
            <a
              href="https://hyperstudio.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink-muted border-b border-line hover:text-ink hover:border-line-strong transition-colors"
            >
              Hyper Studio
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
