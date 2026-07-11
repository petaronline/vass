'use client';

/**
 * Pipeline — unified calendar + list (Patch 4.36).
 *
 * One page, three view modes (List · Week · Month), Sprout-style. Week
 * is the default and starts on Monday.
 *
 * Filter row (always visible above the view):
 *   • Account picker — checklist of all visible accounts; respects the
 *     active brand (from BrandSelector). Always rendered.
 *   • Status picker — Scheduled / Published checkboxes; both ON by default.
 *
 * The merged calendar endpoint serves all three views from one query;
 * the only difference between views is the date window we request and
 * how we lay out the result.
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Calendar as CalendarIcon,
  List,
  CheckCircle2,
  Clock,
  AlertCircle,
  XCircle,
  Plus,
  Facebook,
  Instagram,
  AtSign,
  Music2,
  Linkedin,
  Hash,
  MessageCircle,
  ExternalLink,
  Trash2,
  History,
  CalendarRange,
  Workflow,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  organicPosts,
  organicCalendar,
  organicAccounts,
  uploads,
  OrganicAccount,
  CalendarPost,
  CalendarPostStatus,
  OrganicPlatform,
  ApiError,
} from '@/lib/api';
import { PageHeader, PAGE_TINTS } from '@/components/PageHeader';
import { ComposerModal } from '@/components/studio/ComposerModal';
import {
  getActiveBrandId,
  getActiveScope,
  getActiveAccountIds,
  VASS_ACTIVE_SCOPE_EVENT,
  type ActiveScope,
} from '@/components/BrandSelector';
import { AccountPicker } from '@/components/studio/AccountPicker';
import { DayDrawer } from '@/components/studio/DayDrawer';
import { StatusPicker, type StatusBucket } from '@/components/studio/StatusPicker';
import { WeekView, mondayOf } from '@/components/studio/WeekView';

type ViewMode = 'list' | 'week' | 'month';

const PLATFORM_META: Record<OrganicPlatform, { Icon: typeof Facebook; color: string; label: string }> = {
  facebook_page: { Icon: Facebook,  color: '#1877F2', label: 'FB' },
  instagram:     { Icon: Instagram, color: '#E1306C', label: 'IG' },
  threads:       { Icon: AtSign,    color: '#000000', label: 'TH' },
  tiktok:        { Icon: Music2,   color: '#000000', label: 'TT' },
  linkedin:      { Icon: Linkedin, color: '#0A66C2', label: 'LI' },
};

/** List view chunk size — initial render + each lazy load. */
const LIST_PAGE_SIZE = 10;

export default function OrganicPipelinePage() {
  const router = useRouter();

  // ─── View state ───
  const [view, setView] = useState<ViewMode>('week');
  const [refMonth, setRefMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [refWeekStart, setRefWeekStart] = useState(() => mondayOf(new Date()));

  // ─── Filters ───
  const [activeBrandId, setActiveBrandId] = useState<string | 'all'>('all');
  const [accountFilter, setAccountFilter] = useState<Set<string> | null>(null);
  const [statusFilter, setStatusFilter] = useState<Set<StatusBucket>>(
    () => new Set<StatusBucket>(['scheduled', 'published'])
  );

  // ─── Data ───
  const [accounts, setAccounts] = useState<OrganicAccount[]>([]);
  const [posts, setPosts] = useState<CalendarPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadedOlderOnce, setLoadedOlderOnce] = useState(false);
  // Manual refresh — fires Meta sync for the single selected account.
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFeedback, setRefreshFeedback] = useState<string | null>(null);

  // ─── Drawer state ───
  // Two modes:
  //   • drawerDate set + focusedPost null  → show all posts for the day
  //     (entry point: month-view day cell click, "+N more" overflow)
  //   • focusedPost set                    → show just that one post
  //     (entry point: week-view card click)
  const [drawerDate, setDrawerDate] = useState<Date | null>(null);
  // Patch 4.41.0: editing a scheduled post via the composer.
  const [editingScheduledId, setEditingScheduledId] = useState<string | null>(null);
  const [focusedPost, setFocusedPost] = useState<CalendarPost | null>(null);

  // ─── List view pagination ───
  const [listVisible, setListVisible] = useState(LIST_PAGE_SIZE);

  // ─── Brand-selector wiring ───
  // Track the full scope so we can derive the visible-accounts list.
  // brandAccounts below filters via getActiveAccountIds(scope).
  //
  // Patch 4.40.1: initialize scope SYNCHRONOUSLY from storage (lazy
  // initializer) instead of defaulting to {type:'all'} and reading the
  // real value in an effect. The old default-then-effect pattern left a
  // render window where scope was momentarily 'all'; loadPosts could
  // fire in that window and request accountIds:undefined → the backend
  // returned EVERY brand's posts. That's why a hard reload (different
  // timing) showed the brand but a soft reload showed everything.
  const [scope, setScope] = useState<ActiveScope>(() => getActiveScope());
  // Has the accounts list finished loading at least once? Until it has,
  // a brand scope can't be expanded into account ids, so we must NOT
  // load posts yet (loading with empty ids for a brand scope would wrongly
  // fall back to "all").
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  useEffect(() => {
    setActiveBrandId(getActiveBrandId());
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && typeof detail === 'object' && 'type' in detail) {
        setScope(detail as ActiveScope);
        // getActiveBrandId now does its own lookup against the cached
        // accounts list. Pages that still read activeBrandId as a
        // single value get a sensible answer.
        setActiveBrandId(getActiveBrandId());
        // Reset the per-account filter — scope change probably
        // implies different accounts.
        setAccountFilter(null);
      }
    };
    window.addEventListener(VASS_ACTIVE_SCOPE_EVENT, onChange);
    return () => window.removeEventListener(VASS_ACTIVE_SCOPE_EVENT, onChange);
  }, []);

  // ─── Accounts list ───
  const loadAccounts = useCallback(async () => {
    try {
      const r = await organicAccounts.list();
      setAccounts(r.accounts);
    } catch (err) {
      console.error('[pipeline] failed to load accounts:', err);
    } finally {
      setAccountsLoaded(true);
    }
  }, []);
  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  // Accounts visible to the picker, derived from the multi-scope:
  //   - 'all' → every account
  //   - mixed brands + profiles → union (all-accounts-in-each-brand
  //     plus each picked profile)
  const brandAccounts = useMemo(() => {
    const ids = getActiveAccountIds(accounts);
    if (ids === null) return accounts;
    const set = new Set(ids);
    return accounts.filter((a) => set.has(a.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, scope]);

  const effectiveAccountIds = useMemo(() => {
    const candidate = brandAccounts.map((a) => a.id);
    if (!accountFilter) return candidate;
    return candidate.filter((id) => accountFilter.has(id));
  }, [brandAccounts, accountFilter]);

  // ─── Time window for the API request ───
  // Different views need different window sizes:
  //   • Week: 7 days centered on refWeekStart, with a small buffer
  //   • Month: 90-day window centered on refMonth (covers adjacent
  //     month spillover dates in the grid)
  //   • List: same 90-day window as month; pagination is client-side
  //     within that window.
  const windowFrom = useMemo(() => {
    if (view === 'week') {
      const d = new Date(refWeekStart);
      d.setDate(refWeekStart.getDate() - 1);
      return d.toISOString();
    }
    const d = new Date(refMonth);
    d.setMonth(d.getMonth() - 1);
    return d.toISOString();
  }, [view, refMonth, refWeekStart]);

  const windowTo = useMemo(() => {
    if (view === 'week') {
      const d = new Date(refWeekStart);
      d.setDate(refWeekStart.getDate() + 8);
      return d.toISOString();
    }
    const d = new Date(refMonth);
    d.setMonth(d.getMonth() + 2);
    return d.toISOString();
  }, [view, refMonth, refWeekStart]);

  // ─── Fetch posts ───
  const loadPosts = useCallback(async () => {
    // Empty status filter → nothing to show
    if (statusFilter.size === 0) {
      setPosts([]);
      setLoading(false);
      return;
    }
    // Explicit account filter with NO accounts selected → nothing to show.
    if (accountFilter !== null && accountFilter.size === 0) {
      setPosts([]);
      setLoading(false);
      return;
    }
    // Patch 4.40.1: if a specific (non-'all') scope is active we MUST
    // resolve it to account ids before loading. Until the accounts list
    // has loaded, a brand scope expands to [] — and loading with no ids
    // would fall back to "all brands". So wait for accounts first, and
    // if the scope genuinely resolves to no accounts, show nothing
    // rather than everything.
    if (scope.type !== 'all') {
      if (!accountsLoaded) {
        // Accounts not ready yet — keep showing the loading state and
        // bail; this effect re-runs once accountsLoaded flips.
        setLoading(true);
        return;
      }
      if (effectiveAccountIds.length === 0) {
        setPosts([]);
        setLoading(false);
        return;
      }
    }
    setLoading(true);
    try {
      // Patch 4.37.5: with multi-scope, always send accountIds derived
      // from the scope (or null for 'all'). brandId is no longer used
      // by this page — the scope helper does the expansion.
      //
      // Patch 4.40.1: only send `undefined` (= all) when the scope is
      // genuinely 'all'. For any specific scope we always pass concrete
      // ids (guaranteed non-empty by the guard above), so we never
      // accidentally widen a brand view to every brand.
      const r = await organicCalendar.get({
        from: windowFrom,
        to: windowTo,
        brandId: null,
        accountIds: scope.type === 'all' ? undefined : effectiveAccountIds,
        statuses: Array.from(statusFilter),
      });
      setPosts(r.posts);
      setListVisible(LIST_PAGE_SIZE);
    } catch (err) {
      console.error('[pipeline] failed to load calendar:', err);
    } finally {
      setLoading(false);
    }
  }, [windowFrom, windowTo, effectiveAccountIds, statusFilter, scope, accountsLoaded, accountFilter]);

  useEffect(() => { loadPosts(); }, [loadPosts]);

  // ─── Actions ───
  const handleCancelSchedule = async (postId: string) => {
    if (!confirm('Cancel this scheduled post?')) return;
    try {
      await organicPosts.cancelSchedule(postId);
      loadPosts();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to cancel');
    }
  };

  // Patch 4.41.0: open the composer to edit a scheduled post. Only
  // scheduled Vass posts are editable (others have no editable schedule
  // / aren't ours). On save the composer PATCHes in place + re-queues.
  const handleEditPost = (post: CalendarPost) => {
    if (post.status !== 'scheduled' || post.source !== 'vass') return;
    setEditingScheduledId(post.id);
  };

  // Patch 4.40.0: drag-to-reschedule on the week view. Optimistic —
  // move the card to its new time instantly, then call the API. On
  // failure, reload to snap it back and surface the error.
  const handleReschedule = async (post: CalendarPost, newWhen: Date) => {
    const newIso = newWhen.toISOString();
    const prevTimestamp = post.timestamp;
    if (new Date(prevTimestamp).getTime() === newWhen.getTime()) return; // no-op

    // Optimistic: update this post's timestamp in place.
    setPosts((prev) =>
      prev.map((p) => (p.id === post.id ? { ...p, timestamp: newIso } : p))
    );

    try {
      await organicPosts.reschedule(post.id, newIso);
    } catch (err) {
      // Snap back + tell the user.
      setPosts((prev) =>
        prev.map((p) => (p.id === post.id ? { ...p, timestamp: prevTimestamp } : p))
      );
      alert(err instanceof ApiError ? err.message : 'Failed to reschedule');
    }
  };

  const handleLoadOlder = async () => {
    const targetIds = effectiveAccountIds;
    if (targetIds.length === 0) return;
    setLoadingOlder(true);
    try {
      await organicCalendar.loadOlder({
        accountIds: targetIds,
        untilDate: windowFrom,
      });
      setLoadedOlderOnce(true);
      setTimeout(() => loadPosts(), 5000);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to schedule backfill');
    } finally {
      setLoadingOlder(false);
    }
  };

  // Manual refresh — pull fresh data for the accounts currently in
  // scope. Works whether one account or many are selected: we sync
  // them sequentially (Meta syncs are slow, ~2-10s each) and surface
  // progress. The button is only disabled when nothing is in scope.
  const refreshableAccountIds = effectiveAccountIds;

  const handleRefresh = async () => {
    const ids = refreshableAccountIds;
    if (ids.length === 0) return;
    setRefreshing(true);
    setRefreshFeedback(ids.length > 1 ? `Refreshing 0/${ids.length}…` : null);
    let totalUpserted = 0;
    let failed = 0;
    try {
      for (let i = 0; i < ids.length; i++) {
        if (ids.length > 1) setRefreshFeedback(`Refreshing ${i + 1}/${ids.length}…`);
        try {
          const r = await organicCalendar.refresh({ accountId: ids[i] });
          if (r.error) failed++;
          else totalUpserted += r.upserted;
        } catch {
          failed++;
        }
      }
      await loadPosts();
      const parts: string[] = [`Refreshed — ${totalUpserted} new or updated`];
      if (failed > 0) parts.push(`${failed} failed`);
      setRefreshFeedback(parts.join(', '));
      setTimeout(() => setRefreshFeedback(null), 4000);
    } catch (err) {
      setRefreshFeedback(err instanceof ApiError ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  const closeDrawer = () => {
    setDrawerDate(null);
    setFocusedPost(null);
  };
  const openDayDrawer = (date: Date) => {
    // If the same day is already open in day mode, close it.
    if (
      drawerDate &&
      !focusedPost &&
      drawerDate.getFullYear() === date.getFullYear() &&
      drawerDate.getMonth() === date.getMonth() &&
      drawerDate.getDate() === date.getDate()
    ) {
      closeDrawer();
      return;
    }
    setFocusedPost(null);
    setDrawerDate(date);
  };
  const openPostDrawer = (post: CalendarPost) => {
    // If the same post is already focused, close the drawer.
    if (focusedPost && focusedPost.source === post.source && focusedPost.id === post.id) {
      closeDrawer();
      return;
    }
    setDrawerDate(null);
    setFocusedPost(post);
  };

  // ─── Render ───
  return (
    <div>
      <PageHeader
        icon={Workflow}
        title="Pipeline"
        description="Scheduled + published posts across your connected accounts."
        tint={PAGE_TINTS.pipeline}
        actions={
          <>
            <ViewToggle view={view} setView={setView} />
            <button
              onClick={() => router.push('/organic/studio?compose=1')}
              className="btn-primary"
            >
              <Plus size={14} />
              New post
            </button>
          </>
        }
      />

      {/* Always-visible filter row — account picker + status picker + refresh */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <AccountPicker
          accounts={brandAccounts}
          selected={accountFilter}
          onChange={setAccountFilter}
        />
        <StatusPicker
          selected={statusFilter}
          onChange={setStatusFilter}
        />
        <button
          onClick={handleRefresh}
          disabled={refreshableAccountIds.length === 0 || refreshing}
          title={
            refreshableAccountIds.length === 0
              ? 'No accounts in scope to refresh'
              : refreshableAccountIds.length === 1
              ? 'Pull latest posts from Meta for this account'
              : `Pull latest posts from Meta for ${refreshableAccountIds.length} accounts`
          }
          className="btn-secondary btn-sm"
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        {refreshFeedback && (
          <span className="text-xs text-ink-muted ml-1">{refreshFeedback}</span>
        )}
      </div>

      {loading ? (
        <div className="px-6 py-16 text-center text-sm text-ink-subtle">Loading…</div>
      ) : view === 'list' ? (
        <ListView
          posts={posts}
          visibleCount={listVisible}
          onLoadMore={() => setListVisible((v) => v + LIST_PAGE_SIZE)}
          onCancelSchedule={handleCancelSchedule}
        />
      ) : view === 'week' ? (
        <WeekView
          posts={posts}
          weekStart={refWeekStart}
          setWeekStart={setRefWeekStart}
          onCancelSchedule={handleCancelSchedule}
          onPostClick={openPostDrawer}
          onReschedule={handleReschedule}
          onEditPost={handleEditPost}
        />
      ) : (
        <>
          <MonthView
            posts={posts}
            refMonth={refMonth}
            setRefMonth={setRefMonth}
            onCancelSchedule={handleCancelSchedule}
            onDayClick={openDayDrawer}
          />
          <div className="flex justify-center mt-4">
            <button
              onClick={handleLoadOlder}
              disabled={loadingOlder || effectiveAccountIds.length === 0}
              className="btn-ghost btn-sm"
            >
              {loadingOlder ? (
                <><RefreshCw size={11} className="animate-spin" /> Backfilling…</>
              ) : loadedOlderOnce ? (
                <><History size={11} /> Backfill queued — refresh in a few seconds</>
              ) : (
                <><History size={11} /> Load older history</>
              )}
            </button>
          </div>
        </>
      )}

      {focusedPost && (
        // Single-post mode: drawer shows only the clicked card.
        <DayDrawer
          date={new Date(focusedPost.timestamp)}
          posts={[focusedPost]}
          onClose={closeDrawer}
          onCancelSchedule={(id) => {
            handleCancelSchedule(id);
            closeDrawer();
          }}
        />
      )}
      {!focusedPost && drawerDate && (
        // Day mode: drawer shows every post for the selected day.
        <DayDrawer
          date={drawerDate}
          posts={posts.filter((p) => {
            const d = new Date(p.timestamp);
            return (
              d.getFullYear() === drawerDate.getFullYear() &&
              d.getMonth() === drawerDate.getMonth() &&
              d.getDate() === drawerDate.getDate()
            );
          })}
          onClose={closeDrawer}
          onCancelSchedule={(id) => {
            handleCancelSchedule(id);
            closeDrawer();
          }}
        />
      )}

      {/* Patch 4.41.0: edit a scheduled post in the full composer.
          Saving PATCHes in place + re-queues; reload to reflect changes. */}
      {editingScheduledId && (
        <ComposerModal
          open={!!editingScheduledId}
          scheduledPostId={editingScheduledId}
          onClose={() => setEditingScheduledId(null)}
          onPublished={() => { setEditingScheduledId(null); loadPosts(); }}
        />
      )}
    </div>
  );
}

// ─── View toggle: List · Week · Month ───────────────────────────────

function ViewToggle({ view, setView }: { view: ViewMode; setView: (v: ViewMode) => void }) {
  const Btn = ({ v, label, Icon }: { v: ViewMode; label: string; Icon: typeof List }) => (
    <button
      onClick={() => setView(v)}
      className={[
        'flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors',
        view === v ? 'bg-accent text-white shadow-card' : 'text-ink-muted hover:text-ink',
      ].join(' ')}
    >
      <Icon size={13} /> {label}
    </button>
  );
  return (
    <div className="flex items-center bg-white/72 backdrop-blur-card border border-white/60 rounded-lg p-0.5 shadow-subtle">
      <Btn v="list"  label="List"  Icon={List} />
      <Btn v="week"  label="Week"  Icon={CalendarRange} />
      <Btn v="month" label="Month" Icon={CalendarIcon} />
    </div>
  );
}

// ─── Month view ─────────────────────────────────────────────────────

function buildMonthGrid(refMonth: Date): Array<{ date: Date; inMonth: boolean }> {
  const year = refMonth.getFullYear();
  const month = refMonth.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  // Monday-first grid. JS getDay(): Sun=0, Mon=1, … Sat=6. We want Monday=0.
  const startOffset = (firstOfMonth.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - startOffset);
  const cells: Array<{ date: Date; inMonth: boolean }> = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    cells.push({ date: d, inMonth: d.getMonth() === month });
  }
  return cells;
}

function ymdKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function MonthView({
  posts,
  refMonth,
  setRefMonth,
  onCancelSchedule,
  onDayClick,
}: {
  posts: CalendarPost[];
  refMonth: Date;
  setRefMonth: (d: Date) => void;
  onCancelSchedule: (id: string) => void;
  onDayClick: (d: Date) => void;
}) {
  const grid = useMemo(() => buildMonthGrid(refMonth), [refMonth]);

  const byDay = useMemo(() => {
    const m = new Map<string, CalendarPost[]>();
    for (const p of posts) {
      const key = ymdKey(new Date(p.timestamp));
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(p);
    }
    return m;
  }, [posts]);

  const monthLabel = refMonth.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  const todayKey = ymdKey(new Date());

  const prevMonth = () => setRefMonth(new Date(refMonth.getFullYear(), refMonth.getMonth() - 1, 1));
  const nextMonth = () => setRefMonth(new Date(refMonth.getFullYear(), refMonth.getMonth() + 1, 1));
  const today = () => {
    const d = new Date();
    setRefMonth(new Date(d.getFullYear(), d.getMonth(), 1));
  };

  return (
    <div className="bg-white/72 backdrop-blur-card border border-white/60 rounded-lg shadow-glass overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-line/60">
        <div className="flex items-center gap-1">
          <button onClick={prevMonth} className="p-1.5 rounded hover:bg-surface-hover text-ink-muted hover:text-ink" aria-label="Previous month">
            <ChevronLeft size={16} />
          </button>
          <button onClick={today} className="text-xs font-medium text-ink-muted hover:text-ink px-2 py-1 rounded hover:bg-surface-hover transition-colors">
            Today
          </button>
          <button onClick={nextMonth} className="p-1.5 rounded hover:bg-surface-hover text-ink-muted hover:text-ink" aria-label="Next month">
            <ChevronRight size={16} />
          </button>
        </div>
        <h2 className="h-sub text-ink">{monthLabel}</h2>
        <div className="w-[100px]" />
      </div>

      {/* Monday-first header */}
      <div className="grid grid-cols-7 border-b border-line/50">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="px-2 py-2 text-2xs uppercase tracking-wider font-semibold text-ink-subtle text-center">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 grid-rows-6">
        {grid.map(({ date, inMonth }, i) => {
          const key = ymdKey(date);
          const dayPosts = byDay.get(key) ?? [];
          const isToday = key === todayKey;
          const hasAny = dayPosts.length > 0;
          return (
            <div
              key={i}
              className={[
                'min-h-[100px] border-r border-b border-line/30 px-2 py-1.5 flex flex-col gap-1',
                inMonth ? 'bg-white/40' : 'bg-surface-alt/30',
                isToday ? 'bg-accent-subtle/40' : '',
              ].join(' ')}
            >
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => hasAny && onDayClick(date)}
                disabled={!hasAny}
                className={[
                  'flex items-center justify-between -mx-1 px-1 rounded transition-colors',
                  hasAny ? 'hover:bg-surface-hover cursor-pointer' : 'cursor-default',
                ].join(' ')}
              >
                <span className={[
                  'text-xs',
                  isToday ? 'font-bold text-accent' : inMonth ? 'text-ink' : 'text-ink-subtle',
                ].join(' ')}>
                  {date.getDate()}
                </span>
                {hasAny && (
                  <span className="text-2xs text-ink-subtle">{dayPosts.length}</span>
                )}
              </button>
              <div className="flex flex-col gap-0.5 overflow-hidden">
                {dayPosts.slice(0, 3).map((p) => (
                  <MonthPostCard key={`${p.source}:${p.id}`} post={p} onCancel={onCancelSchedule} />
                ))}
                {dayPosts.length > 3 && (
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => onDayClick(date)}
                    className="text-2xs text-ink-muted font-medium px-1.5 py-0.5 rounded hover:bg-surface-hover hover:text-ink text-left transition-colors"
                  >
                    +{dayPosts.length - 3} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function resolveMediaUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith('vass-upload:')) {
    return uploads.fileUrl(url.slice('vass-upload:'.length));
  }
  return url;
}

function MonthPostCard({ post, onCancel }: { post: CalendarPost; onCancel: (id: string) => void }) {
  const { bg, text, border, Icon, label } = statusVisuals(post.status);
  const timeStr = new Date(post.timestamp).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });

  const onClick = post.status === 'published' && post.permalink
    ? () => window.open(post.permalink!, '_blank', 'noopener,noreferrer')
    : undefined;

  const isPublished = post.status === 'published';
  const cardClass = isPublished
    ? `${bg} ${text}`
    : `bg-white ${border} border ${text}`;

  return (
    <div
      onClick={onClick}
      className={[
        'group rounded px-1.5 py-1 text-2xs leading-tight truncate transition-all',
        cardClass,
        onClick ? 'cursor-pointer hover:opacity-80' : 'cursor-default',
      ].join(' ')}
      title={post.body || '(no text)'}
    >
      <div className="flex items-center gap-1">
        <Icon size={9} className="shrink-0" />
        <span className="font-medium truncate flex-1">{timeStr || label}</span>
        {isPublished && post.permalink && (
          <ExternalLink size={9} className="opacity-50 group-hover:opacity-100 shrink-0" />
        )}
        {post.status === 'scheduled' && post.source === 'vass' && (
          <button
            onClick={(e) => { e.stopPropagation(); onCancel(post.id); }}
            className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-black/10 rounded transition-opacity"
            title="Cancel"
          >
            <Trash2 size={9} />
          </button>
        )}
      </div>
      <div className="truncate text-2xs mt-0.5 opacity-80">
        {post.body ? post.body.slice(0, 30) : <em className="opacity-60">(no text)</em>}
      </div>
    </div>
  );
}

// ─── List view (descending + lazy-load) ─────────────────────────────

function ListView({
  posts,
  visibleCount,
  onLoadMore,
  onCancelSchedule,
}: {
  posts: CalendarPost[];
  visibleCount: number;
  onLoadMore: () => void;
  onCancelSchedule: (id: string) => void;
}) {
  // Single descending list, newest first.
  const sorted = useMemo(
    () => [...posts].sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    [posts]
  );
  const slice = sorted.slice(0, visibleCount);
  const hasMore = sorted.length > visibleCount;

  if (sorted.length === 0) {
    return (
      <div className="bg-white/72 backdrop-blur-card border border-white/60 rounded-lg shadow-glass px-6 py-16 text-center">
        <p className="text-sm text-ink-muted">
          No posts in this window.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white/72 backdrop-blur-card border border-white/60 rounded-lg shadow-glass overflow-hidden">
      <ul className="divide-y divide-line/50">
        {slice.map((p) => (
          <ListRow
            key={`${p.source}:${p.id}`}
            post={p}
            onCancel={p.source === 'vass' ? () => onCancelSchedule(p.id) : undefined}
          />
        ))}
      </ul>
      {hasMore && (
        <div className="px-5 py-4 border-t border-line/60 flex justify-center">
          <button
            onClick={onLoadMore}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-ink-muted hover:text-ink hover:bg-surface-hover transition-colors"
          >
            Load {Math.min(LIST_PAGE_SIZE, sorted.length - visibleCount)} more
          </button>
        </div>
      )}
    </div>
  );
}

function ListRow({ post, onCancel }: { post: CalendarPost; onCancel?: () => void }) {
  const { bg, text, Icon, label } = statusVisuals(post.status);
  const whenStr = new Date(post.timestamp).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const mediaUrl = resolveMediaUrl(post.mediaUrl);

  const rowClick = post.status === 'published' && post.permalink
    ? () => window.open(post.permalink!, '_blank', 'noopener,noreferrer')
    : undefined;

  return (
    <li
      className={[
        'flex items-start gap-4 px-5 py-4 transition-colors',
        rowClick ? 'cursor-pointer hover:bg-white/40' : '',
      ].join(' ')}
      onClick={rowClick}
    >
      {mediaUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={mediaUrl}
          alt=""
          className="shrink-0 mt-0.5 w-12 h-12 rounded object-cover bg-black"
        />
      ) : (
        <div className={['shrink-0 mt-0.5 w-7 h-7 rounded-full flex items-center justify-center', bg].join(' ')}>
          <Icon size={14} className={text} />
        </div>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className={['text-2xs uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded', bg, text].join(' ')}>
            {label}
          </span>
          {post.platforms.length > 0 && (
            <div className="flex items-center gap-1">
              {post.platforms.map((p) => {
                const meta = PLATFORM_META[p];
                if (!meta) return null;
                const Icon = meta.Icon;
                return <Icon key={p} size={11} style={{ color: meta.color }} />;
              })}
            </div>
          )}
          {post.topicTag && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-medium bg-surface-alt text-ink-muted border border-line">
              <Hash size={9} strokeWidth={2.5} />
              {post.topicTag}
            </span>
          )}
          {post.replyChainLength > 0 && (
            <span
              className="inline-flex items-center gap-1 text-2xs text-ink-subtle"
              title={`${post.replyChainLength} repl${post.replyChainLength === 1 ? 'y' : 'ies'} in the chain`}
            >
              <MessageCircle size={10} />
              +{post.replyChainLength}
            </span>
          )}
          {post.permalink && (
            <span className="ml-auto inline-flex items-center gap-1 text-2xs text-ink-subtle">
              <ExternalLink size={9} />
              View
            </span>
          )}
        </div>
        <div className="text-sm text-ink line-clamp-2 leading-snug">
          {post.body || <span className="italic text-ink-subtle">(no text)</span>}
        </div>
        <div className="flex items-center justify-between mt-1.5 text-2xs text-ink-subtle">
          <span>{whenStr}</span>
          {post.status === 'scheduled' && onCancel && (
            <button
              onClick={(e) => { e.stopPropagation(); onCancel(); }}
              className="flex items-center gap-1 text-danger hover:underline"
            >
              <Trash2 size={10} /> Cancel
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

// ─── Shared status visuals ──────────────────────────────────────────

function statusVisuals(status: CalendarPostStatus): {
  bg: string;
  text: string;
  border: string;
  Icon: typeof CheckCircle2;
  label: string;
} {
  switch (status) {
    case 'scheduled':
      return { bg: 'bg-accent-subtle', text: 'text-accent', border: 'border-accent/40', Icon: Clock, label: 'Scheduled' };
    case 'published':
      return { bg: 'bg-success/15', text: 'text-success', border: 'border-success/40', Icon: CheckCircle2, label: 'Published' };
    case 'partial':
      return { bg: 'bg-warning/15', text: 'text-warning', border: 'border-warning/40', Icon: AlertCircle, label: 'Partial' };
    case 'failed':
      return { bg: 'bg-danger/15', text: 'text-danger', border: 'border-danger/40', Icon: XCircle, label: 'Failed' };
    case 'cancelled':
      return { bg: 'bg-surface-hover', text: 'text-ink-subtle', border: 'border-line', Icon: XCircle, label: 'Cancelled' };
    case 'publishing':
      return { bg: 'bg-accent-subtle', text: 'text-accent', border: 'border-accent/40', Icon: RefreshCw, label: 'Publishing' };
    default:
      return { bg: 'bg-surface-hover', text: 'text-ink-subtle', border: 'border-line', Icon: Clock, label: 'Draft' };
  }
}
