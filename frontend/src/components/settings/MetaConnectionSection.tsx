'use client';

// Meta connection section — extracted from the settings page so it
// can be composed into the merged Connections page (Patch 4.38.1).
import { useEffect, useState, FormEvent, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  CheckCircle2, AlertTriangle, ExternalLink, Unplug, Save, KeyRound,
} from 'lucide-react';
import { auth, metaSettings, ApiError, MetaSettings, CurrentUser } from '@/lib/api';

export function MetaConnectionSection() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const oauthStatus = searchParams.get('status');
  const oauthMessage = searchParams.get('message');

  const [user, setUser] = useState<CurrentUser | null>(null);
  const [data, setData] = useState<MetaSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  /** Lets an admin force the credentials form open even when creds are
      already configured (e.g. to rotate the secret). */
  const [showCredsForm, setShowCredsForm] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [me, status] = await Promise.all([auth.me(), metaSettings.get()]);
      setUser(me.user);
      setData(status);
      setAppId(status.appId ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Meta settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Clear OAuth status param from URL after showing the result
  useEffect(() => {
    if (oauthStatus) {
      const t = setTimeout(() => {
        router.replace('/settings/meta');
      }, 6000);
      return () => clearTimeout(t);
    }
  }, [oauthStatus, router]);

  async function handleSaveCredentials(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await metaSettings.saveCredentials(appId.trim(), appSecret.trim());
      setAppSecret('');
      setShowCredsForm(false);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save credentials');
    } finally {
      setSaving(false);
    }
  }

  async function handleConnect() {
    setError(null);
    setConnecting(true);
    try {
      const { url } = await metaSettings.getOAuthUrl();
      window.location.href = url; // full-page redirect to Facebook
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start OAuth');
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm('Disconnect your Facebook account from Vass? You will need to reconnect to launch ads.')) {
      return;
    }
    setError(null);
    try {
      await metaSettings.disconnect();
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to disconnect');
    }
  }

  if (loading) {
    return <SettingsCard><div className="text-sm text-ink-muted">Loading…</div></SettingsCard>;
  }

  const isAdmin = user?.role === 'admin';
  const hasWorkspaceCreds = !!data?.hasCredentials;

  return (
    <div className="space-y-6">
      {/* OAuth result banner */}
      {oauthStatus === 'success' && (
        <Banner kind="success">
          <CheckCircle2 size={16} />
          <span>{oauthMessage ?? 'Connected successfully.'}</span>
        </Banner>
      )}
      {oauthStatus === 'error' && (
        <Banner kind="error">
          <AlertTriangle size={16} />
          <span>OAuth failed: {oauthMessage ?? 'Unknown error'}</span>
        </Banner>
      )}

      {/* ============================================================
          Workspace App credentials section
          - Admin sees form (if not configured OR reconfigure clicked)
          - Admin sees a "configured ✓" summary otherwise
          - Member sees a read-only status with a hint
          ============================================================ */}
      <SettingsCard>
        <div className="flex items-start justify-between mb-1">
          <div>
            <h2 className="h-section text-ink">Workspace Meta App</h2>
            <p className="text-sm text-ink-muted mt-1">
              The Meta App every user in this workspace OAuths against. Configured once by an admin.
              Test users do <strong>not</strong> need to create their own Meta App.
            </p>
          </div>
        </div>

        {/* --- Admin paths --- */}
        {isAdmin && (hasWorkspaceCreds && !showCredsForm) && (
          <div className="mt-5 flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-alt/60 px-4 py-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 size={16} className="text-success" />
              <div className="text-sm text-ink">
                Configured · App ID <span className="font-mono text-ink-muted">{data?.appId}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowCredsForm(true)}
              className="btn-ghost text-xs"
            >
              <KeyRound size={12} />
              Reconfigure
            </button>
          </div>
        )}

        {isAdmin && (!hasWorkspaceCreds || showCredsForm) && (
          <form onSubmit={handleSaveCredentials} className="space-y-4 mt-5">
            <p className="text-sm text-ink-muted">
              Get these from{' '}
              <a
                href="https://developers.facebook.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:text-accent-hover underline"
              >
                developers.facebook.com
              </a>
              {' '}→ your app → Settings → Basic.
            </p>

            <div>
              <label htmlFor="appId" className="label">App ID</label>
              <input
                id="appId"
                type="text"
                required
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder="e.g. 1234567890123456"
                className="input input-mono"
                disabled={saving}
              />
            </div>

            <div>
              <label htmlFor="appSecret" className="label">
                App Secret
                {hasWorkspaceCreds && (
                  <span className="ml-2 text-ink-subtle normal-case tracking-normal">
                    (leave blank to keep existing)
                  </span>
                )}
              </label>
              <input
                id="appSecret"
                type="password"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                placeholder={hasWorkspaceCreds ? '••••••••••••••••' : 'Your App Secret'}
                className="input input-mono"
                disabled={saving}
                autoComplete="new-password"
              />
            </div>

            {error && <ErrorRow message={error} />}

            <div className="flex gap-2">
              <button
                type="submit"
                className="btn-primary"
                disabled={saving || !appId.trim() || (!hasWorkspaceCreds && !appSecret.trim())}
              >
                <Save size={14} />
                {saving ? 'Saving…' : 'Save credentials'}
              </button>
              {hasWorkspaceCreds && (
                <button
                  type="button"
                  onClick={() => { setShowCredsForm(false); setAppSecret(''); }}
                  className="btn-secondary"
                  disabled={saving}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}

        {/* --- Member paths --- */}
        {!isAdmin && hasWorkspaceCreds && (
          <div className="mt-5 flex items-center gap-2 rounded-lg border border-line bg-surface-alt/60 px-4 py-3 text-sm">
            <CheckCircle2 size={16} className="text-success" />
            <span className="text-ink">Configured by your workspace admin.</span>
          </div>
        )}

        {!isAdmin && !hasWorkspaceCreds && (
          <div className="mt-5 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
            <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" />
            <span className="text-ink">
              The Meta App for this workspace hasn't been set up yet. Ask an admin to configure it
              in <strong>Settings → Meta</strong>.
            </span>
          </div>
        )}
      </SettingsCard>

      {/* ============================================================
          Personal Facebook connection — every user, including admin
          ============================================================ */}
      <SettingsCard>
        <div className="mb-1">
          <h2 className="h-section text-ink">Your Facebook connection</h2>
          <p className="text-sm text-ink-muted mt-1">
            {hasWorkspaceCreds
              ? 'Sign in with your own Facebook account. Only you see your pages and ad accounts — other workspace users see only theirs.'
              : 'Ask an admin to configure the workspace Meta App first.'}
          </p>
        </div>

        {data?.connected ? (
          <div className="space-y-4 mt-5">
            <ConnectedBadge userName={data.connectedUserName ?? 'Unknown'} />
            {data.tokenExpiresAt && (
              <p className="text-xs text-ink-subtle">
                Token expires {new Date(data.tokenExpiresAt).toLocaleString()}.
              </p>
            )}
            <div className="flex gap-2">
              <button onClick={handleConnect} className="btn-secondary" disabled={connecting}>
                <ExternalLink size={14} />
                {connecting ? 'Redirecting…' : 'Reconnect'}
              </button>
              <button onClick={handleDisconnect} className="btn-secondary text-danger hover:!text-danger">
                <Unplug size={14} />
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-5">
            <NotConnectedBadge />
            <div className="mt-4">
              <button
                onClick={handleConnect}
                className="btn-primary"
                disabled={!hasWorkspaceCreds || connecting}
              >
                <ExternalLink size={14} />
                {connecting ? 'Redirecting…' : 'Connect Facebook'}
              </button>
              {!hasWorkspaceCreds && (
                <p className="text-xs text-ink-subtle mt-2">
                  {isAdmin
                    ? 'Save workspace App credentials above first.'
                    : 'Waiting for an admin to configure the workspace Meta App.'}
                </p>
              )}
            </div>
          </div>
        )}
      </SettingsCard>

      {/* ============================================================
          One-time setup help (admin only — members don't manage this)
          ============================================================ */}
      {isAdmin && (
        <SettingsCard>
          <h2 className="h-sub text-ink mb-3">
            One-time Meta App setup
          </h2>
          <p className="text-sm text-ink-muted mb-4">
            In your Meta App dashboard, add this URL as an authorized OAuth redirect URI so
            Facebook will send users back here after authentication:
          </p>
          <div className="bg-surface-alt border border-line rounded-sm p-3 font-mono text-xs text-ink break-all">
            {typeof window !== 'undefined' ? window.location.origin : ''}/api/settings/meta/callback
          </div>
          <p className="text-xs text-ink-subtle mt-3">
            Add it under <strong>Facebook Login for Business</strong> → <strong>Settings</strong> →{' '}
            <strong>Valid OAuth Redirect URIs</strong>. To add test users without going through
            App Review, add their Facebook accounts as <strong>Developers</strong> or <strong>Testers</strong> on
            your Meta App.
          </p>
        </SettingsCard>
      )}
    </div>
  );
}

// ---- Local components ----

function SettingsCard({ children }: { children: React.ReactNode }) {
  return <div className="card">{children}</div>;
}

function ConnectedBadge({ userName }: { userName: string }) {
  return (
    <div className="inline-flex items-center gap-2 bg-green-50 border border-green-200 rounded-sm px-3 py-2 text-sm">
      <CheckCircle2 size={16} className="text-success" />
      <span className="text-ink">
        Connected as <strong>{userName}</strong>
      </span>
    </div>
  );
}

function NotConnectedBadge() {
  return (
    <div className="inline-flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-sm px-3 py-2 text-sm">
      <AlertTriangle size={16} className="text-warning" />
      <span className="text-ink">Not connected</span>
    </div>
  );
}

function ErrorRow({ message }: { message: string }) {
  return (
    <div className="bg-red-50 border border-red-100 rounded-sm px-3 py-2 text-sm text-danger">
      {message}
    </div>
  );
}

function Banner({
  kind,
  children,
}: {
  kind: 'success' | 'error';
  children: React.ReactNode;
}) {
  const cls =
    kind === 'success'
      ? 'bg-green-50 border-green-200 text-ink'
      : 'bg-red-50 border-red-200 text-ink';
  return (
    <div
      className={`flex items-center gap-2 border rounded-lg px-4 py-3 text-sm animate-fade-in ${cls}`}
    >
      {children}
    </div>
  );
}
