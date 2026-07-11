'use client';

// Threads App section — extracted for the merged Connections page (Patch 4.38.1).
import { HelpTip } from './HelpTip';
import { useEffect, useState, FormEvent, useCallback } from 'react';
import { AtSign, CheckCircle2, AlertTriangle, Save, KeyRound } from 'lucide-react';
import { auth, threadsApp, ApiError, ThreadsAppStatus, CurrentUser } from '@/lib/api';

export function ThreadsAppSection() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [status, setStatus] = useState<ThreadsAppStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showSecretForm, setShowSecretForm] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [me, s] = await Promise.all([auth.me(), threadsApp.get()]);
      setUser(me.user);
      setStatus(s);
      setAppId(s.appId ?? '');
      setRedirectUri(s.redirectUri);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Threads settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      // Only send fields that have a non-empty new value, AND only send
      // the secret when the user has typed one (so saving the App ID
      // alone doesn't blow away the stored secret).
      const payload: { appId?: string; appSecret?: string; redirectUri?: string } = {};
      const trimmedAppId = appId.trim();
      const trimmedRedirect = redirectUri.trim();
      if (trimmedAppId.length > 0) payload.appId = trimmedAppId;
      if (appSecret.trim().length > 0) payload.appSecret = appSecret.trim();
      // Always include redirect URI — empty string clears the override
      // and we fall back to the server-side default.
      payload.redirectUri = trimmedRedirect;
      await threadsApp.save(payload);
      setAppSecret('');
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
    return (
      <div className="text-sm text-ink-muted">Loading…</div>
    );
  }

  const isAdmin = user?.role === 'admin';

  return (
    <div className="space-y-6">
      <header>
        <h2 className="h-section text-ink flex items-center gap-2">
          <AtSign size={18} strokeWidth={2} className="text-ink-subtle" />
          Threads App
          <HelpTip label="How to set up the Threads app">
            Threads uses a <strong>separate Meta app registration</strong> from
            Facebook/Instagram. In the Meta App dashboard, add the
            <strong> Threads API</strong> use case, add the redirect URI below on
            its settings, then paste the App ID + Secret here. Once saved,
            workspace members connect their own profiles via Settings → Social
            profiles.
          </HelpTip>
        </h2>
        <p className="text-sm text-ink-muted mt-1">
          Meta requires a separate app registration for the Threads API. Configure your
          Threads App credentials here. Once set, all workspace members can connect their
          own Threads profiles via Settings → Social profiles.
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
          Saved. Members can now connect Threads.
        </div>
      )}

      {/* Status card */}
      <div className="rounded-lg border border-line bg-surface-alt/60 px-4 py-3">
        <div className="flex items-center gap-2 text-sm">
          {status?.hasCredentials ? (
            <>
              <CheckCircle2 size={14} className="text-green-600" />
              <span className="text-ink">Threads App configured</span>
            </>
          ) : (
            <>
              <AlertTriangle size={14} className="text-amber-600" />
              <span className="text-ink-muted">Not configured</span>
            </>
          )}
        </div>
        {status?.appId && (
          <div className="mt-2 text-xs text-ink-subtle">
            App ID: <span className="font-mono">{status.appId}</span>
            {status.hasSecret && <span className="ml-2">• Secret stored</span>}
          </div>
        )}
      </div>

      {/* Redirect URI display (read-only info) */}
      <div className="rounded-lg border border-line p-4 space-y-2">
        <div className="text-xs font-medium uppercase tracking-wider text-ink-subtle">
          OAuth redirect URI
        </div>
        <p className="text-xs text-ink-muted">
          This URL must be added as an authorized redirect callback in your Threads App settings at{' '}
          <a
            href="https://developers.facebook.com/apps"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            developers.facebook.com
          </a>
          .
        </p>
        <div className="bg-surface-alt border border-line rounded-sm p-3 font-mono text-xs text-ink break-all">
          {status?.redirectUri}
        </div>
      </div>

      {/* Admin form */}
      {!isAdmin ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-ink">
          Only workspace admins can set the Threads App credentials. Ask your admin to configure
          this if you need to connect Threads.
        </div>
      ) : (
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label htmlFor="threads-app-id" className="block text-xs font-medium uppercase tracking-wider text-ink-subtle mb-1">
              App ID
            </label>
            <input
              id="threads-app-id"
              type="text"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              placeholder="e.g. 1234567890123456"
              className="w-full px-3 py-2 border border-line rounded-lg text-sm text-ink bg-white placeholder-ink-subtle focus:outline-none focus:border-accent"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="threads-app-secret" className="block text-xs font-medium uppercase tracking-wider text-ink-subtle">
                App Secret
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
                id="threads-app-secret"
                type="password"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                placeholder="Paste the App Secret from developers.facebook.com"
                autoComplete="off"
                className="w-full px-3 py-2 border border-line rounded-lg text-sm text-ink bg-white placeholder-ink-subtle focus:outline-none focus:border-accent font-mono"
              />
            )}
          </div>

          <div>
            <label htmlFor="threads-redirect" className="block text-xs font-medium uppercase tracking-wider text-ink-subtle mb-1">
              Redirect URI override <span className="text-ink-subtle font-normal lowercase">(optional)</span>
            </label>
            <input
              id="threads-redirect"
              type="url"
              value={redirectUri}
              onChange={(e) => setRedirectUri(e.target.value)}
              placeholder="Leave blank to use the default shown above"
              className="w-full px-3 py-2 border border-line rounded-lg text-sm text-ink bg-white placeholder-ink-subtle focus:outline-none focus:border-accent"
            />
            <p className="text-xs text-ink-subtle mt-1">
              Useful only if you proxy Threads OAuth through a different host. Leave blank to use{' '}
              <span className="font-mono">{status?.redirectUri}</span>.
            </p>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={saving || appId.trim().length === 0}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? (
                <>
                  <KeyRound size={14} className="animate-pulse" /> Saving…
                </>
              ) : (
                <>
                  <Save size={14} /> Save credentials
                </>
              )}
            </button>
            {showSecretForm && (
              <button
                type="button"
                onClick={() => { setShowSecretForm(false); setAppSecret(''); }}
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
