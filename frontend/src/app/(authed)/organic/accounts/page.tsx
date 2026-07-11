'use client';

/**
 * Organic / Connected Accounts
 *
 * Lets each Vass user connect their Facebook Pages, Instagram Business
 * accounts, and (eventually) Threads. Each platform section shows:
 *   - Connected accounts with avatar, name/handle, follower count
 *   - A connect button that kicks off the Meta OAuth flow
 *   - Per-account disconnect button
 *
 * OAuth flow:
 *   1. User clicks "Connect Facebook Pages"
 *   2. Frontend fetches /api/organic/accounts/oauth-url?platform=facebook_page
 *   3. Redirects to Facebook
 *   4. Meta redirects back to /api/organic/accounts/callback
 *   5. Backend stores page tokens, redirects to /organic?oauth_status=success&tab=accounts
 *   6. This page detects the query params and shows a toast
 *
 * Threads: shown as "coming soon" — real OAuth in patch 4.25.
 */

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  PlugZap,
  RefreshCw,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Users,
  ExternalLink,
  Facebook,
  Instagram,
  MessageCircle,
} from 'lucide-react';
import { PageHeader, PAGE_TINTS } from '@/components/PageHeader';
import { organicAccounts, OrganicAccount, OrganicPlatform, ApiError } from '@/lib/api';

// ─── Platform config ─────────────────────────────────────────────────────────

interface PlatformConfig {
  id: OrganicPlatform;
  label: string;
  description: string;
  icon: typeof Facebook;
  iconColor: string;
  connectLabel: string;
  comingSoon?: boolean;
  note?: string;
}

const PLATFORMS: PlatformConfig[] = [
  {
    id: 'facebook_page',
    label: 'Facebook Pages',
    description: 'Publish posts, images, and videos to your Facebook Pages.',
    icon: Facebook,
    iconColor: '#1877F2',
    connectLabel: 'Connect Facebook Pages',
    note: 'Each Page you manage becomes a separate connected account.',
  },
  {
    id: 'instagram',
    label: 'Instagram',
    description: 'Publish to Instagram feed, Reels, and Stories (coming in 4.24).',
    icon: Instagram,
    iconColor: '#E1306C',
    connectLabel: 'Connect Instagram',
    note: 'Requires an Instagram Business or Creator account linked to a Facebook Page.',
  },
  {
    id: 'threads',
    label: 'Threads',
    description: 'Publish text and media posts to Threads.',
    icon: MessageCircle,
    iconColor: '#000000',
    connectLabel: 'Connect Threads',
    comingSoon: true,
    note: 'Threads uses a separate OAuth flow. Coming in patch 4.25.',
  },
];

// ─── Toast ────────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  type: 'success' | 'error';
  message: string;
}

let toastCounter = 0;

// ─── Main component ───────────────────────────────────────────────────────────

export default function OrganicAccountsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [accounts, setAccounts] = useState<OrganicAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState<OrganicPlatform | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((type: Toast['type'], message: string) => {
    const id = ++toastCounter;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const { accounts: data } = await organicAccounts.list();
      setAccounts(data);
    } catch (err) {
      addToast('error', err instanceof ApiError ? err.message : 'Failed to load accounts');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  // On mount: load accounts + handle OAuth callback params
  useEffect(() => {
    loadAccounts();

    const status = searchParams.get('oauth_status');
    const message = searchParams.get('oauth_message');
    if (status === 'success' && message) {
      addToast('success', message);
      // Clean the URL
      router.replace('/organic/accounts', { scroll: false });
    } else if (status === 'error' && message) {
      addToast('error', message);
      router.replace('/organic/accounts', { scroll: false });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnect = async (platform: OrganicPlatform) => {
    setConnecting(platform);
    try {
      const { url } = await organicAccounts.getOAuthUrl(platform);
      window.location.href = url;
    } catch (err) {
      addToast('error', err instanceof ApiError ? err.message : 'Failed to start OAuth');
      setConnecting(null);
    }
  };

  const handleDisconnect = async (account: OrganicAccount) => {
    const name =
      account.meta.name ?? account.meta.username ?? account.externalId;
    if (!confirm(`Disconnect "${name}"? You can reconnect any time.`)) return;
    setDisconnecting(account.id);
    try {
      await organicAccounts.disconnect(account.id);
      setAccounts((prev) => prev.filter((a) => a.id !== account.id));
      addToast('success', `Disconnected "${name}"`);
    } catch (err) {
      addToast('error', err instanceof ApiError ? err.message : 'Failed to disconnect');
    } finally {
      setDisconnecting(null);
    }
  };

  const accountsByPlatform = (platform: OrganicPlatform) =>
    accounts.filter((a) => a.platform === platform);

  return (
    <div className="relative">
      {/* Toasts */}
      <div className="fixed top-5 right-5 z-50 flex flex-col gap-2 w-80">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={[
              'flex items-start gap-3 px-4 py-3 rounded-lg shadow-lift border text-sm animate-slide-up',
              t.type === 'success'
                ? 'bg-white border-success/30 text-ink'
                : 'bg-white border-danger/30 text-ink',
            ].join(' ')}
          >
            {t.type === 'success' ? (
              <CheckCircle2 size={16} className="text-success shrink-0 mt-0.5" />
            ) : (
              <AlertCircle size={16} className="text-danger shrink-0 mt-0.5" />
            )}
            <span>{t.message}</span>
          </div>
        ))}
      </div>

      {/* Header row */}
      <div className="flex items-center justify-between mb-6">
        <PageHeader
          icon={Users}
          title="Connected accounts"
          description="Each Vass user connects their own accounts. You only see yours."
          tint={PAGE_TINTS.accounts}
        />
        <button
          onClick={() => { setLoading(true); loadAccounts(); }}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-ink-muted hover:text-ink rounded-lg hover:bg-white/55 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Platform sections */}
      <div className="space-y-5">
        {PLATFORMS.map((platform) => {
          const connected = accountsByPlatform(platform.id);
          const Icon = platform.icon;
          const isConnecting = connecting === platform.id;

          return (
            <div
              key={platform.id}
              className="bg-white/72 backdrop-blur-card border border-white/60 rounded-lg shadow-glass overflow-hidden"
            >
              {/* Platform header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-line/60">
                <div className="flex items-center gap-3">
                  <div
                    className="w-9 h-9 rounded-lg flex items-center justify-center"
                    style={{ backgroundColor: `${platform.iconColor}18` }}
                  >
                    <Icon size={18} style={{ color: platform.iconColor }} strokeWidth={2} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-ink">{platform.label}</span>
                      {platform.comingSoon && (
                        <span className="px-1.5 py-0.5 text-2xs font-semibold rounded-full bg-surface-hover text-ink-muted">
                          Coming soon
                        </span>
                      )}
                      {connected.length > 0 && (
                        <span className="px-1.5 py-0.5 text-2xs font-semibold rounded-full bg-accent-subtle text-accent">
                          {connected.length} connected
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-ink-muted mt-0.5">{platform.description}</p>
                  </div>
                </div>

                {!platform.comingSoon && (
                  <button
                    onClick={() => handleConnect(platform.id)}
                    disabled={isConnecting || !!connecting}
                    className="flex items-center gap-2 px-3.5 py-1.5 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0 ml-4"
                  >
                    {isConnecting ? (
                      <>
                        <RefreshCw size={13} className="animate-spin" />
                        Connecting…
                      </>
                    ) : (
                      <>
                        <PlugZap size={13} />
                        {connected.length > 0 ? 'Add more pages' : platform.connectLabel}
                      </>
                    )}
                  </button>
                )}
              </div>

              {/* Connected accounts list */}
              {connected.length > 0 ? (
                <ul className="divide-y divide-line/50">
                  {connected.map((account) => (
                    <AccountRow
                      key={account.id}
                      account={account}
                      onDisconnect={handleDisconnect}
                      isDisconnecting={disconnecting === account.id}
                    />
                  ))}
                </ul>
              ) : (
                <div className="px-6 py-5 flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-surface-hover flex items-center justify-center shrink-0">
                    <Users size={14} className="text-ink-subtle" />
                  </div>
                  <div>
                    <p className="text-sm text-ink-muted">
                      {platform.comingSoon
                        ? 'OAuth flow for Threads launches in patch 4.25.'
                        : 'No accounts connected yet.'}
                    </p>
                    {platform.note && (
                      <p className="text-xs text-ink-subtle mt-0.5">{platform.note}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Permissions note */}
      <div className="mt-6 flex items-start gap-3 px-4 py-3 rounded-lg bg-white/40 border border-white/60 text-sm text-ink-muted">
        <AlertCircle size={15} className="shrink-0 mt-0.5 text-ink-subtle" />
        <p>
          Connecting accounts uses the same Meta App as your ads. For production use (outside of
          Developer/Tester roles), Meta requires App Review for{' '}
          <code className="text-xs font-mono bg-surface-hover px-1 py-0.5 rounded">pages_manage_posts</code>{' '}
          and{' '}
          <code className="text-xs font-mono bg-surface-hover px-1 py-0.5 rounded">instagram_content_publish</code>.{' '}
          <a
            href="https://developers.facebook.com/docs/app-review"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline inline-flex items-center gap-1"
          >
            Learn more <ExternalLink size={11} />
          </a>
        </p>
      </div>
    </div>
  );
}

// ─── Account row ──────────────────────────────────────────────────────────────

function AccountRow({
  account,
  onDisconnect,
  isDisconnecting,
}: {
  account: OrganicAccount;
  onDisconnect: (a: OrganicAccount) => void;
  isDisconnecting: boolean;
}) {
  const displayName = account.meta.name ?? account.meta.username ?? account.externalId;
  const handle = account.meta.username ? `@${account.meta.username}` : null;
  const pictureUrl = account.meta.picture_url;
  const followersCount = account.meta.followers_count;
  const linkedPage = account.meta.linked_page_name;

  const isExpired =
    account.tokenExpiresAt ? new Date(account.tokenExpiresAt) < new Date() : false;

  return (
    <li className="flex items-center gap-4 px-6 py-3.5">
      {/* Avatar */}
      <div className="w-9 h-9 rounded-full overflow-hidden shrink-0 bg-surface-hover flex items-center justify-center">
        {pictureUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={pictureUrl} alt={displayName ?? ''} className="w-full h-full object-cover" />
        ) : (
          <span className="text-sm font-semibold text-ink-muted">
            {(displayName ?? '?').charAt(0).toUpperCase()}
          </span>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink truncate">{displayName}</span>
          {isExpired && (
            <span className="px-1.5 py-0.5 text-2xs font-semibold rounded-full bg-warning/15 text-warning">
              Token expired
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5">
          {handle && (
            <span className="text-xs text-ink-muted">{handle}</span>
          )}
          {followersCount != null && (
            <span className="text-xs text-ink-subtle">
              {formatCount(followersCount)} followers
            </span>
          )}
          {linkedPage && account.platform === 'instagram' && (
            <span className="text-xs text-ink-subtle truncate">
              via {linkedPage}
            </span>
          )}
        </div>
      </div>

      {/* Disconnect */}
      <button
        onClick={() => onDisconnect(account)}
        disabled={isDisconnecting}
        title="Disconnect"
        className="p-1.5 rounded-lg text-ink-subtle hover:text-danger hover:bg-danger/8 transition-colors disabled:opacity-40"
      >
        {isDisconnecting ? (
          <RefreshCw size={14} className="animate-spin" />
        ) : (
          <Trash2 size={14} />
        )}
      </button>
    </li>
  );
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
