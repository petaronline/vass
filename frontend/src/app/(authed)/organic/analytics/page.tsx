'use client';

/**
 * Organic / Analytics (Patch 4.57)
 *
 * Aggregate post-level insights across a brand + account scope for a time
 * window (3 months default, up to 6). On load we live-fetch insights for
 * posts published in the last ~month and serve older posts from stored
 * snapshots; the Refresh button forces a full re-pull.
 *
 * Availability is honest per network: Facebook works today; Instagram and
 * Threads need their accounts reconnected (new insight scopes in 4.57);
 * TikTok and LinkedIn are not yet available (audit / API approval pending).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  RefreshCw,
  Facebook,
  Instagram,
  AtSign,
  Music2,
  Linkedin,
  Eye,
  Users2,
  Heart,
  MessageCircle,
  Share2,
  MousePointerClick,
  Bookmark,
  AlertCircle,
} from 'lucide-react';
import {
  organicAnalytics,
  organicAccounts,
  AnalyticsResponse,
  AnalyticsPost,
  OrganicAccount,
  OrganicPlatform,
} from '@/lib/api';
import {
  getActiveBrandId,
  getActiveScope,
  getActiveAccountIds,
  VASS_ACTIVE_SCOPE_EVENT,
  type ActiveScope,
} from '@/components/BrandSelector';
import { PageHeader, PAGE_TINTS } from '@/components/PageHeader';
import {
  DateRangePicker,
  rangeForPreset,
  type DateRange,
  type PresetId,
} from '@/components/studio/DateRangePicker';

const PLATFORM_META: Record<OrganicPlatform, { Icon: typeof Facebook; color: string; label: string }> = {
  facebook_page: { Icon: Facebook, color: '#1877F2', label: 'Facebook' },
  instagram: { Icon: Instagram, color: '#E4405F', label: 'Instagram' },
  threads: { Icon: AtSign, color: '#000000', label: 'Threads' },
  tiktok: { Icon: Music2, color: '#000000', label: 'TikTok' },
  linkedin: { Icon: Linkedin, color: '#0A66C2', label: 'LinkedIn' },
};

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

type SortKey = 'publishedAt' | 'impressions' | 'engagement' | 'likes' | 'comments' | 'shares';

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [accounts, setAccounts] = useState<OrganicAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<DateRange>(() => rangeForPreset('last7'));
  const [preset, setPreset] = useState<PresetId>('last7');
  const [networkFilter, setNetworkFilter] = useState<OrganicPlatform | 'all'>('all');
  const [scope, setScope] = useState<ActiveScope>(() => getActiveScope());
  const [, setActiveBrandId] = useState<string>('all');
  const [sortKey, setSortKey] = useState<SortKey>('publishedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Brand-selector wiring.
  useEffect(() => {
    setActiveBrandId(getActiveBrandId());
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && typeof detail === 'object' && 'type' in detail) {
        setScope(detail as ActiveScope);
        setActiveBrandId(getActiveBrandId());
      }
    };
    window.addEventListener(VASS_ACTIVE_SCOPE_EVENT, onChange);
    return () => window.removeEventListener(VASS_ACTIVE_SCOPE_EVENT, onChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    organicAccounts
      .list()
      .then((r) => { if (!cancelled) setAccounts(r.accounts); })
      .catch((err) => console.error('[analytics] accounts load failed:', err));
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(
    async (opts?: { refresh?: boolean }) => {
      const brandId = getActiveBrandId();
      const scopeIds = getActiveAccountIds(accounts);
      if (opts?.refresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await organicAnalytics.get({
          brandId: brandId === 'all' ? null : brandId,
          accountIds: scopeIds ?? undefined,
          from: range.from.toISOString(),
          to: range.to.toISOString(),
          platform: networkFilter === 'all' ? null : networkFilter,
          refresh: opts?.refresh,
        });
        setData(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load analytics.');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [accounts, range, networkFilter]
  );

  // Initial + on scope/range/network change (live fetch every load, per spec).
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, range, networkFilter, accounts.length]);

  const sortedPosts = useMemo(() => {
    if (!data) return [];
    const arr = [...data.posts];
    arr.sort((a, b) => {
      let av: number;
      let bv: number;
      if (sortKey === 'publishedAt') {
        av = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
        bv = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      } else {
        av = (a.metrics[sortKey] as number | null) ?? 0;
        bv = (b.metrics[sortKey] as number | null) ?? 0;
      }
      return sortDir === 'desc' ? bv - av : av - bv;
    });
    return arr;
  }, [data, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortKey(key); setSortDir('desc'); }
  };

  // Which platforms are in the user's current scope, for availability notes.
  const scopedPlatforms = useMemo(() => {
    const ids = getActiveAccountIds(accounts);
    const list = ids === null ? accounts : accounts.filter((a) => ids.includes(a.id));
    return Array.from(new Set(list.map((a) => a.platform)));
  }, [accounts]);

  const totals = data?.totals;

  const statTiles = [
    { label: 'Impressions', value: totals?.impressions, Icon: Eye },
    { label: 'Reach', value: totals?.reach, Icon: Users2 },
    { label: 'Engagement', value: totals?.engagement, Icon: Heart },
    { label: 'Likes', value: totals?.likes, Icon: Heart },
    { label: 'Comments', value: totals?.comments, Icon: MessageCircle },
    { label: 'Shares', value: totals?.shares, Icon: Share2 },
    { label: 'Clicks', value: totals?.clicks, Icon: MousePointerClick },
    { label: 'Saves', value: totals?.saves, Icon: Bookmark },
  ];

  return (
    <div>
      <PageHeader
        icon={BarChart3}
        title="Analytics"
        description="Post performance across your connected organic profiles."
        tint={PAGE_TINTS.analytics}
        actions={
          <div className="flex items-center gap-2">
            <DateRangePicker
              value={range}
              preset={preset}
              onChange={(r, p) => { setRange(r); setPreset(p); }}
            />
            <button
              type="button"
              onClick={() => load({ refresh: true })}
              disabled={refreshing || loading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-white/72 backdrop-blur-card border border-white/60 shadow-subtle text-ink hover:bg-white disabled:opacity-50"
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        }
      />

      {/* Network filter — governs the whole page (tiles + chart + table). */}
      {scopedPlatforms.length > 1 && (
        <div className="flex items-center gap-1.5 mb-5 flex-wrap">
          <button
            type="button"
            onClick={() => setNetworkFilter('all')}
            className={[
              'px-3 py-1.5 text-sm rounded-lg border transition-colors',
              networkFilter === 'all'
                ? 'bg-accent text-white border-accent'
                : 'bg-white/72 backdrop-blur-card border-white/60 text-ink-muted hover:text-ink',
            ].join(' ')}
          >
            All networks
          </button>
          {scopedPlatforms.map((p) => {
            const meta = PLATFORM_META[p];
            const Icon = meta?.Icon;
            const activeF = networkFilter === p;
            return (
              <button
                key={p}
                type="button"
                onClick={() => setNetworkFilter(p)}
                className={[
                  'flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border transition-colors',
                  activeF
                    ? 'bg-accent text-white border-accent'
                    : 'bg-white/72 backdrop-blur-card border-white/60 text-ink-muted hover:text-ink',
                ].join(' ')}
              >
                {Icon && <Icon size={14} style={{ color: activeF ? undefined : meta?.color }} />}
                {meta?.label ?? p}
              </button>
            );
          })}
        </div>
      )}

      {/* Availability notices for scoped platforms that aren't pullable. */}
      <AvailabilityNotices availability={data?.availability} scopedPlatforms={scopedPlatforms} />

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-danger mb-6">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-ink-muted py-12 text-center">Loading analytics…</div>
      ) : !data || data.postCount === 0 ? (
        <div className="rounded-lg bg-white/72 backdrop-blur-card border border-white/60 rounded-lg shadow-glass px-6 py-12 text-center">
          <BarChart3 size={28} className="mx-auto text-ink-subtle mb-2" />
          <p className="text-sm text-ink-muted">
            No published posts with analytics in this window. Publish to a connected
            profile, or widen the window.
          </p>
        </div>
      ) : (
        <>
          {/* Stat tiles */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            {statTiles.map((t) => (
              <div
                key={t.label}
                className="bg-white/72 backdrop-blur-card border border-white/60 rounded-lg shadow-glass p-4"
              >
                <div className="flex items-center gap-1.5 text-ink-muted mb-1">
                  <t.Icon size={14} />
                  <span className="text-xs font-medium">{t.label}</span>
                </div>
                <div className="font-display text-2xl font-bold tracking-tight text-ink">
                  {fmt(t.value)}
                </div>
              </div>
            ))}
          </div>

          {/* Engagement-by-post bar chart (lightweight inline SVG) */}
          <EngagementChart posts={sortedPosts} />

          {/* Per-post table */}
          <div className="bg-white/72 backdrop-blur-card border border-white/60 rounded-lg shadow-glass overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-muted">
                    <th className="px-4 py-3 font-medium">Post</th>
                    <Th label="Date" k="publishedAt" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <Th label="Impr." k="impressions" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <Th label="Engmt." k="engagement" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <Th label="Likes" k="likes" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <Th label="Comm." k="comments" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    <Th label="Shares" k="shares" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  </tr>
                </thead>
                <tbody>
                  {sortedPosts.map((p) => {
                    const meta = PLATFORM_META[p.platform];
                    const Icon = meta?.Icon ?? Facebook;
                    return (
                      <tr key={p.targetId} className="border-b border-line/60 last:border-0 hover:bg-black/[0.015]">
                        <td className="px-4 py-3 max-w-xs">
                          <div className="flex items-center gap-2">
                            <Icon size={14} style={{ color: meta?.color }} className="shrink-0" />
                            <span className="truncate text-ink">{p.body || '(no text)'}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-ink-muted whitespace-nowrap">
                          {p.publishedAt ? new Date(p.publishedAt).toLocaleDateString() : '—'}
                        </td>
                        <td className="px-4 py-3 tabular-nums">{fmt(p.metrics.impressions)}</td>
                        <td className="px-4 py-3 tabular-nums">{fmt(p.metrics.engagement)}</td>
                        <td className="px-4 py-3 tabular-nums">{fmt(p.metrics.likes)}</td>
                        <td className="px-4 py-3 tabular-nums">{fmt(p.metrics.comments)}</td>
                        <td className="px-4 py-3 tabular-nums">{fmt(p.metrics.shares)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Th({
  label, k, sortKey, sortDir, onSort,
}: {
  label: string; k: SortKey; sortKey: SortKey; sortDir: 'asc' | 'desc'; onSort: (k: SortKey) => void;
}) {
  const active = sortKey === k;
  return (
    <th
      className="px-4 py-3 font-medium cursor-pointer select-none whitespace-nowrap hover:text-ink"
      onClick={() => onSort(k)}
    >
      {label}
      {active && <span className="ml-1">{sortDir === 'desc' ? '↓' : '↑'}</span>}
    </th>
  );
}

function AvailabilityNotices({
  availability,
  scopedPlatforms,
}: {
  availability?: Record<string, { available: boolean; reason?: string }>;
  scopedPlatforms: OrganicPlatform[];
}) {
  // Build notices: any scoped platform that's known-unavailable, or that the
  // backend reported unavailable.
  const notices: { platform: string; reason: string }[] = [];
  const seen = new Set<string>();

  const addNotice = (platform: string, reason: string) => {
    if (seen.has(platform)) return;
    seen.add(platform);
    notices.push({ platform, reason });
  };

  if (availability) {
    for (const [platform, info] of Object.entries(availability)) {
      if (!info.available && info.reason) addNotice(platform, info.reason);
    }
  }
  // Static guidance for scoped platforms needing reconnect/approval.
  for (const p of scopedPlatforms) {
    if (p === 'instagram' || p === 'threads') {
      addNotice(p, `Reconnect your ${PLATFORM_META[p]?.label} account to grant the new insights permission.`);
    } else if (p === 'tiktok') {
      addNotice(p, 'TikTok analytics require the app to pass content-posting audit.');
    } else if (p === 'linkedin') {
      addNotice(p, 'LinkedIn does not expose analytics for personal profile posts.');
    }
  }

  if (notices.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 mb-6 space-y-1">
      {notices.map((n) => {
        const meta = PLATFORM_META[n.platform as OrganicPlatform];
        return (
          <div key={n.platform} className="flex items-start gap-2 text-sm text-amber-800">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>
              <span className="font-medium">{meta?.label ?? n.platform}:</span> {n.reason}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Lightweight engagement-by-post bar chart — no charting dependency. */
function EngagementChart({ posts }: { posts: AnalyticsPost[] }) {
  const top = posts
    .filter((p) => (p.metrics.engagement ?? 0) > 0)
    .sort((a, b) => (b.metrics.engagement ?? 0) - (a.metrics.engagement ?? 0))
    .slice(0, 12);

  if (top.length === 0) return null;
  const max = Math.max(...top.map((p) => p.metrics.engagement ?? 0), 1);

  return (
    <div className="bg-white/72 backdrop-blur-card border border-white/60 rounded-lg shadow-glass p-5 mb-6">
      <h3 className="text-sm font-semibold text-ink mb-4">Top posts by engagement</h3>
      <div className="space-y-2">
        {top.map((p) => {
          const eng = p.metrics.engagement ?? 0;
          const pct = Math.max((eng / max) * 100, 2);
          const meta = PLATFORM_META[p.platform];
          return (
            <div key={p.targetId} className="flex items-center gap-3">
              <div className="w-40 shrink-0 truncate text-xs text-ink-muted" title={p.body}>
                {p.body || '(no text)'}
              </div>
              <div className="flex-1 h-5 rounded bg-black/5 overflow-hidden">
                <div
                  className="h-full rounded flex items-center justify-end pr-2"
                  style={{ width: `${pct}%`, background: meta?.color ?? '#10b981' }}
                >
                  <span className="text-2xs font-medium text-white">{fmt(eng)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
