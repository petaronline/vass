'use client';

// TikTok App section — workspace credentials for the TikTok Content
// Posting API (Patch 4.43.0). Mirrors ThreadsAppSection.
import { HelpTip } from './HelpTip';
import { useEffect, useState, FormEvent, useCallback } from 'react';
import { Music2, CheckCircle2, AlertTriangle, Save, KeyRound } from 'lucide-react';
import { auth, tiktokApp, ApiError, TikTokAppStatus, CurrentUser } from '@/lib/api';

export function TikTokAppSection() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [status, setStatus] = useState<TikTokAppStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [clientKey, setClientKey] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showSecretForm, setShowSecretForm] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [me, s] = await Promise.all([auth.me(), tiktokApp.get()]);
      setUser(me.user);
      setStatus(s);
      setClientKey(s.clientKey ?? '');
      setRedirectUri(s.redirectUri);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load TikTok settings');
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
      const payload: { clientKey?: string; clientSecret?: string; redirectUri?: string } = {};
      const trimmedKey = clientKey.trim();
      const trimmedRedirect = redirectUri.trim();
      if (trimmedKey.length > 0) payload.clientKey = trimmedKey;
      if (clientSecret.trim().length > 0) payload.clientSecret = clientSecret.trim();
      payload.redirectUri = trimmedRedirect;
      await tiktokApp.save(payload);
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

  return (
    <div className="space-y-6">
      <header>
        <h2 className="h-section text-ink flex items-center gap-2">
          <Music2 size={18} strokeWidth={2} className="text-ink-subtle" />
          TikTok App
          <HelpTip label="How to set up the TikTok app">
            Create a TikTok developer app with <strong>Login Kit</strong> and the
            <strong> Content Posting API</strong>. Request the scopes
            <em> user.info.basic</em>, <em>video.publish</em>, and
            <em> video.upload</em> — and <em>user.info.profile</em> too if you want
            the creator&apos;s username to show. Add the redirect URI below, verify
            your media domain (URL prefix) in the portal, then paste the Client Key
            + Secret here. Members connect via Settings → Social profiles.
          </HelpTip>
        </h2>
        <p className="text-sm text-ink-muted mt-1">
          TikTok publishing uses your own TikTok developer app (Login Kit + Content Posting
          API). Configure its Client Key + Secret here. Once set, workspace members can connect
          their TikTok accounts via Settings → Social profiles.
        </p>
      </header>

      {/* Audit notice — important expectation-setting */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-ink">
        <div className="flex items-start gap-2">
          <AlertTriangle size={14} className="text-amber-600 mt-0.5 shrink-0" />
          <span>
            Until your TikTok app passes TikTok&apos;s content-posting audit, all posts are
            forced to <strong>private (visible only to you)</strong> by TikTok, regardless of the
            privacy you choose. Submit your app for audit in the TikTok developer portal to
            enable public posting. You also need to add the redirect URI below and verify your
            media domain (URL prefix) in the portal.
          </span>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {saved && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-ink flex items-center gap-2">
          <CheckCircle2 size={14} className="text-green-600" />
          Saved. Members can now connect TikTok.
        </div>
      )}

      {/* Status card */}
      <div className="rounded-lg border border-line bg-surface-alt/60 px-4 py-3">
        <div className="flex items-center gap-2 text-sm">
          {status?.hasCredentials ? (
            <>
              <CheckCircle2 size={14} className="text-green-600" />
              <span className="text-ink">TikTok App configured</span>
            </>
          ) : (
            <>
              <AlertTriangle size={14} className="text-amber-600" />
              <span className="text-ink-muted">Not configured</span>
            </>
          )}
        </div>
        {status?.clientKey && (
          <div className="mt-2 text-xs text-ink-subtle">
            Client Key: <span className="font-mono">{status.clientKey}</span>
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
          Add this exact URL as a redirect URI in your app at{' '}
          <a
            href="https://developers.tiktok.com/apps"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            developers.tiktok.com
          </a>
          .
        </p>
        <div className="bg-surface-alt border border-line rounded-sm p-3 font-mono text-xs text-ink break-all">
          {status?.redirectUri}
        </div>
      </div>

      {!isAdmin ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-ink">
          Only workspace admins can set the TikTok App credentials. Ask your admin to configure
          this if you need to connect TikTok.
        </div>
      ) : (
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label htmlFor="tiktok-client-key" className="block text-xs font-medium uppercase tracking-wider text-ink-subtle mb-1">
              Client Key
            </label>
            <input
              id="tiktok-client-key"
              type="text"
              value={clientKey}
              onChange={(e) => setClientKey(e.target.value)}
              placeholder="e.g. awxyz1234567890"
              className="w-full px-3 py-2 border border-line rounded-lg text-sm text-ink bg-white placeholder-ink-subtle focus:outline-none focus:border-accent font-mono"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="tiktok-client-secret" className="block text-xs font-medium uppercase tracking-wider text-ink-subtle">
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
                id="tiktok-client-secret"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder="Paste the Client Secret from developers.tiktok.com"
                autoComplete="off"
                className="w-full px-3 py-2 border border-line rounded-lg text-sm text-ink bg-white placeholder-ink-subtle focus:outline-none focus:border-accent font-mono"
              />
            )}
          </div>

          <div>
            <label htmlFor="tiktok-redirect" className="block text-xs font-medium uppercase tracking-wider text-ink-subtle mb-1">
              Redirect URI override <span className="text-ink-subtle font-normal lowercase">(optional)</span>
            </label>
            <input
              id="tiktok-redirect"
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
              disabled={saving || clientKey.trim().length === 0}
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
