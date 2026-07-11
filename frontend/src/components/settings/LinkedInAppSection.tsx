'use client';

// LinkedIn App section — workspace credentials for the LinkedIn Posts
// API (Patch 4.45.0). Parametrized by app kind (Patch 4.46.0):
//   - 'profile' → Share on LinkedIn + Sign In (personal profile posting)
//   - 'org'     → Community Management API (company-page posting)
// LinkedIn requires these on SEPARATE developer apps, so each gets its
// own credentials block.
import { useEffect, useState, FormEvent, useCallback } from 'react';
import { Linkedin, CheckCircle2, AlertTriangle, Save, KeyRound } from 'lucide-react';
import { HelpTip } from './HelpTip';
import {
  auth,
  linkedinApp,
  linkedinOrgApp,
  ApiError,
  LinkedInAppStatus,
  CurrentUser,
} from '@/lib/api';

interface Props {
  /** Which LinkedIn app this section configures. Defaults to 'profile'. */
  kind?: 'profile' | 'org';
}

export function LinkedInAppSection({ kind = 'profile' }: Props) {
  const isOrg = kind === 'org';
  const appApi = isOrg ? linkedinOrgApp : linkedinApp;
  const heading = isOrg ? 'LinkedIn — Company Pages' : 'LinkedIn — Profiles';

  const [user, setUser] = useState<CurrentUser | null>(null);
  const [status, setStatus] = useState<LinkedInAppStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showSecretForm, setShowSecretForm] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [me, s] = await Promise.all([auth.me(), appApi.get()]);
      setUser(me.user);
      setStatus(s);
      setClientId(s.clientId ?? '');
      setRedirectUri(s.redirectUri);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load LinkedIn settings');
    } finally {
      setLoading(false);
    }
  }, [appApi]);

  useEffect(() => { reload(); }, [reload]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const payload: { clientId?: string; clientSecret?: string; redirectUri?: string } = {};
      const trimmedId = clientId.trim();
      const trimmedRedirect = redirectUri.trim();
      if (trimmedId.length > 0) payload.clientId = trimmedId;
      if (clientSecret.trim().length > 0) payload.clientSecret = clientSecret.trim();
      payload.redirectUri = trimmedRedirect;
      await appApi.save(payload);
      setClientSecret('');
      setShowSecretForm(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save credentials');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="text-sm text-ink-muted">Loading…</div>;
  }

  const isAdmin = user?.role === 'admin';
  const idPrefix = isOrg ? 'linkedin-org' : 'linkedin';

  return (
    <div className="space-y-6">
      <header>
        <h2 className="h-section text-ink flex items-center gap-2">
          <Linkedin size={18} strokeWidth={2} className="text-ink-subtle" />
          {heading}
          <HelpTip label="How to set up this LinkedIn app">
            {isOrg ? (
              <>
                <strong>Company pages</strong> need a <strong>separate</strong> LinkedIn app whose
                <em> only</em> product is the Community Management API (LinkedIn requires it be the
                sole product). Create that app, request only Community Management API, add the
                redirect URI below on its Auth tab, and submit — LinkedIn reviews access manually
                (typically 1–4 weeks). Connecting pages won&apos;t work until it&apos;s approved.
                Then paste its Client ID + Secret here.
              </>
            ) : (
              <>
                <strong>Personal profiles</strong> use a LinkedIn app with the
                &quot;Share on LinkedIn&quot; + &quot;Sign In with LinkedIn&quot; products. Request
                both on the app&apos;s Products tab, add the redirect URI below on its Auth tab,
                then paste the Client ID + Secret here. Members connect via Settings → Social
                profiles.
              </>
            )}
          </HelpTip>
        </h2>
        <p className="text-sm text-ink-muted mt-1">
          {isOrg
            ? 'Separate app for company-page posting (Community Management API).'
            : 'App for personal-profile posting (Share on LinkedIn).'}
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {saved && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-ink flex items-center gap-2">
          <CheckCircle2 size={14} className="text-green-600" />
          Saved. Members can now connect LinkedIn.
        </div>
      )}

      {/* Status card */}
      <div className="rounded-lg border border-line bg-surface-alt/60 px-4 py-3">
        <div className="flex items-center gap-2 text-sm">
          {status?.hasCredentials ? (
            <>
              <CheckCircle2 size={14} className="text-green-600" />
              <span className="text-ink">LinkedIn App configured</span>
            </>
          ) : (
            <>
              <AlertTriangle size={14} className="text-amber-600" />
              <span className="text-ink-muted">Not configured</span>
            </>
          )}
        </div>
        {status?.clientId && (
          <div className="mt-2 text-xs text-ink-subtle">
            Client ID: <span className="font-mono">{status.clientId}</span>
            {status.hasSecret && <span className="ml-2">• Secret stored</span>}
          </div>
        )}
      </div>

      {/* Redirect URI */}
      <div className="rounded-lg border border-line p-4 space-y-2">
        <div className="text-xs font-medium uppercase tracking-wider text-ink-subtle">
          OAuth redirect URI
        </div>
        <p className="text-xs text-ink-muted">
          Add this exact URL as an authorized redirect URL on the Auth tab of your app at{' '}
          <a
            href="https://www.linkedin.com/developers/apps"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            linkedin.com/developers/apps
          </a>
          .
        </p>
        <div className="bg-surface-alt border border-line rounded-sm p-3 font-mono text-xs text-ink break-all">
          {status?.redirectUri}
        </div>
      </div>

      {!isAdmin ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-ink">
          Only workspace admins can set the LinkedIn App credentials. Ask your admin to configure
          this if you need to connect LinkedIn.
        </div>
      ) : (
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label htmlFor={`${idPrefix}-client-id`} className="block text-xs font-medium uppercase tracking-wider text-ink-subtle mb-1">
              Client ID
            </label>
            <input
              id={`${idPrefix}-client-id`}
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="e.g. 86xxxxxxxxxxxx"
              className="w-full px-3 py-2 border border-line rounded-lg text-sm text-ink bg-white placeholder-ink-subtle focus:outline-none focus:border-accent font-mono"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor={`${idPrefix}-client-secret`} className="block text-xs font-medium uppercase tracking-wider text-ink-subtle">
                Client Secret
              </label>
              {status?.hasSecret && !showSecretForm && (
                <button
                  type="button"
                  onClick={() => setShowSecretForm(true)}
                  className="text-xs text-accent hover:underline"
                >
                  Replace secret
                </button>
              )}
            </div>
            {status?.hasSecret && !showSecretForm ? (
              <div className="px-3 py-2 border border-line rounded-lg text-sm text-ink-subtle bg-surface-alt/40">
                ●●●●●●●● (stored)
              </div>
            ) : (
              <input
                id={`${idPrefix}-client-secret`}
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder="Paste the Client Secret from your LinkedIn app"
                autoComplete="off"
                className="w-full px-3 py-2 border border-line rounded-lg text-sm text-ink bg-white placeholder-ink-subtle focus:outline-none focus:border-accent font-mono"
              />
            )}
          </div>

          <div>
            <label htmlFor={`${idPrefix}-redirect`} className="block text-xs font-medium uppercase tracking-wider text-ink-subtle mb-1">
              Redirect URI override <span className="text-ink-subtle font-normal lowercase">(optional)</span>
            </label>
            <input
              id={`${idPrefix}-redirect`}
              type="url"
              value={redirectUri}
              onChange={(e) => setRedirectUri(e.target.value)}
              placeholder="Leave blank to use the default shown above"
              className="w-full px-3 py-2 border border-line rounded-lg text-sm text-ink bg-white placeholder-ink-subtle focus:outline-none focus:border-accent"
            />
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={saving || clientId.trim().length === 0}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? (
                <><KeyRound size={14} className="animate-pulse" /> Saving…</>
              ) : (
                <><Save size={14} /> Save credentials</>
              )}
            </button>
            {showSecretForm && (
              <button
                type="button"
                onClick={() => { setShowSecretForm(false); setClientSecret(''); }}
                className="text-sm text-ink-muted hover:text-ink"
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
