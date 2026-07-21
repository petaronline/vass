'use client';

/**
 * Comment Guard page.
 *
 * Meta has no API to disable comments on ads, so this feature does the next
 * best thing the API allows: it watches the ads in a campaign's ad sets (on
 * the Pages you choose to administer) and auto-hides comments matching your
 * rules — links, phone numbers, profanity, or custom keywords.
 *
 * Flow:
 *   1. Pick account → campaign → ad sets, choose which connected Pages to
 *      administer, set rules + sweep interval → "Start guarding"
 *   2. Backend scans the scope into monitored posts, then a background sweep
 *      hides matching comments every N minutes
 *   3. This page lists your guards; selecting one shows live counts, the
 *      monitored ads, and a log of hidden comments (each can be un-hidden)
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  MessageSquareOff,
  AlertCircle,
  Loader2,
  Link2,
  Phone,
  Ban,
  Tag,
  Play,
  Pause,
  RefreshCw,
  Trash2,
  Eye,
  X,
} from 'lucide-react';
import {
  adAccounts,
  metaExplore,
  commentGuards,
  COMMENT_GUARD_INTERVALS,
  AdAccount,
  MetaCampaign,
  MetaAdSet,
  ConnectedPage,
  CommentGuard,
  CommentGuardTarget,
  CommentGuardAction,
  CommentRules,
} from '@/lib/api';
import {
  getActiveAdAccountIds,
  VASS_ACTIVE_SCOPE_EVENT,
} from '@/components/BrandSelector';
import { PageHeader } from '@/components/PageHeader';
import { Toggle } from '@/components/Toggle';

const TINT = { bg: 'rgba(125, 211, 252, 0.16)', fg: '#0369A1' };

const DEFAULT_RULES: CommentRules = {
  links: true,
  phone: true,
  profanity: true,
  keywords: [],
};

const RULE_META: Record<
  'links' | 'phone' | 'profanity' | 'keyword',
  { label: string; icon: typeof Link2 }
> = {
  links: { label: 'Links', icon: Link2 },
  phone: { label: 'Phone numbers', icon: Phone },
  profanity: { label: 'Profanity', icon: Ban },
  keyword: { label: 'Keyword', icon: Tag },
};

export default function CommentGuardPage() {
  // ----- Scope picker state -----
  const [accountsList, setAccountsList] = useState<AdAccount[]>([]);
  const [adAccountId, setAdAccountId] = useState('');
  const [campaigns, setCampaigns] = useState<MetaCampaign[]>([]);
  const [metaCampaignId, setMetaCampaignId] = useState('');
  const [adSetsList, setAdSetsList] = useState<MetaAdSet[]>([]);
  const [selectedAdSetIds, setSelectedAdSetIds] = useState<string[]>([]);
  const [activeOnly, setActiveOnly] = useState(true);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [loadingAdSets, setLoadingAdSets] = useState(false);

  // ----- Pages + rules + interval -----
  const [pages, setPages] = useState<ConnectedPage[]>([]);
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);
  const [rules, setRules] = useState<CommentRules>(DEFAULT_RULES);
  const [keywordInput, setKeywordInput] = useState('');
  const [interval, setIntervalMin] = useState<number>(5);

  // ----- Guards -----
  const [guardsList, setGuardsList] = useState<CommentGuard[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [guard, setGuard] = useState<CommentGuard | null>(null);
  const [targets, setTargets] = useState<CommentGuardTarget[]>([]);
  const [actions, setActions] = useState<CommentGuardAction[]>([]);

  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ----- Initial loads -----
  useEffect(() => {
    adAccounts
      .list()
      .then((r) => setAccountsList(r.accounts.filter((a) => a.isEnabled)))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load accounts'));
    commentGuards
      .listPages()
      .then((r) => setPages(r.pages))
      .catch(() => {/* pages picker just stays empty */});
    refreshGuards();
  }, []);

  const refreshGuards = useCallback(() => {
    commentGuards
      .list()
      .then((r) => setGuardsList(r.guards))
      .catch(() => {/* non-fatal */});
  }, []);

  // ----- Scope → account pre-fill -----
  useEffect(() => {
    if (accountsList.length === 0) return;
    const apply = () => {
      const ids = getActiveAdAccountIds(
        accountsList.map((a) => ({ id: a.id, brandId: a.brandId }))
      );
      if (ids && ids.length > 0) {
        setAdAccountId((cur) => (cur && ids.includes(cur) ? cur : ids[0]));
      }
    };
    apply();
    const onChange = () => apply();
    window.addEventListener(VASS_ACTIVE_SCOPE_EVENT, onChange);
    return () => window.removeEventListener(VASS_ACTIVE_SCOPE_EVENT, onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsList]);

  useEffect(() => {
    if (!adAccountId) {
      setCampaigns([]);
      setMetaCampaignId('');
      return;
    }
    setLoadingCampaigns(true);
    setCampaigns([]);
    metaExplore
      .listCampaigns(adAccountId, activeOnly)
      .then((r) => setCampaigns(r.campaigns))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load campaigns'))
      .finally(() => setLoadingCampaigns(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adAccountId, activeOnly]);

  useEffect(() => {
    if (!metaCampaignId) {
      setAdSetsList([]);
      setSelectedAdSetIds([]);
      return;
    }
    setLoadingAdSets(true);
    setAdSetsList([]);
    metaExplore
      .listAdSets(metaCampaignId, activeOnly)
      .then((r) => setAdSetsList(r.adSets))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load ad sets'))
      .finally(() => setLoadingAdSets(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaCampaignId, activeOnly]);

  // ----- Poll the selected guard -----
  const loadGuard = useCallback((id: string) => {
    commentGuards
      .get(id)
      .then((r) => {
        setGuard(r.guard);
        setTargets(r.targets);
        setActions(r.actions);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load guard'));
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setGuard(null);
      setTargets([]);
      setActions([]);
      return;
    }
    loadGuard(selectedId);
    const t = setInterval(() => loadGuard(selectedId), 5000);
    return () => clearInterval(t);
  }, [selectedId, loadGuard]);

  // ----- Derived -----
  const campaignName = useMemo(
    () => campaigns.find((c) => c.id === metaCampaignId)?.name,
    [campaigns, metaCampaignId]
  );
  const anyRuleOn = !!(
    rules.links || rules.phone || rules.profanity || (rules.keywords && rules.keywords.length)
  );
  const canCreate =
    !!adAccountId &&
    !!metaCampaignId &&
    selectedAdSetIds.length > 0 &&
    selectedPageIds.length > 0 &&
    anyRuleOn &&
    !creating;

  // ----- Handlers -----
  const toggleAdSet = (id: string) =>
    setSelectedAdSetIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    );
  const togglePage = (pageId: string) =>
    setSelectedPageIds((cur) =>
      cur.includes(pageId) ? cur.filter((x) => x !== pageId) : [...cur, pageId]
    );
  const addKeyword = () => {
    const k = keywordInput.trim().toLowerCase();
    if (!k) return;
    setRules((r) => ({
      ...r,
      keywords: Array.from(new Set([...(r.keywords ?? []), k])).slice(0, 200),
    }));
    setKeywordInput('');
  };
  const removeKeyword = (k: string) =>
    setRules((r) => ({ ...r, keywords: (r.keywords ?? []).filter((x) => x !== k) }));

  const startGuarding = async () => {
    setCreating(true);
    setError(null);
    try {
      const { guardId } = await commentGuards.create({
        adAccountId,
        metaCampaignId,
        metaCampaignName: campaignName,
        targetAdSetIds: selectedAdSetIds,
        targetPageIds: selectedPageIds,
        activeOnly,
        rules,
        sweepIntervalMinutes: interval,
      });
      refreshGuards();
      setSelectedId(guardId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start guard');
    } finally {
      setCreating(false);
    }
  };

  const patchGuard = async (patch: Parameters<typeof commentGuards.update>[1]) => {
    if (!guard) return;
    setBusy(true);
    try {
      const r = await commentGuards.update(guard.id, patch);
      setGuard(r.guard);
      refreshGuards();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update guard');
    } finally {
      setBusy(false);
    }
  };

  const sweepNow = async () => {
    if (!guard) return;
    setBusy(true);
    try {
      await commentGuards.sweep(guard.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sweep');
    } finally {
      setBusy(false);
    }
  };

  const removeGuard = async () => {
    if (!guard) return;
    if (!window.confirm('Delete this guard? Comments already hidden stay hidden.')) return;
    setBusy(true);
    try {
      await commentGuards.remove(guard.id);
      setSelectedId(null);
      refreshGuards();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete guard');
    } finally {
      setBusy(false);
    }
  };

  const unhide = async (actionId: string) => {
    if (!guard) return;
    try {
      await commentGuards.unhide(guard.id, actionId);
      loadGuard(guard.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unhide comment');
    }
  };

  const unconnectedTargets = targets.filter((t) => !t.pageConnected).length;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <PageHeader
        icon={MessageSquareOff}
        title="Comment Guard"
        description="Auto-hide unwanted comments on your ads — links, phone numbers, profanity, or keywords."
        tint={TINT}
        activeOnly={activeOnly}
        onActiveOnlyChange={setActiveOnly}
      />

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
          <button className="ml-auto text-red-400 hover:text-red-600" onClick={() => setError(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-6">
        {/* ---------- Left: create + guard list ---------- */}
        <div className="space-y-6">
          {/* Create card */}
          <section className="rounded-xl border border-black/10 bg-white p-4">
            <h2 className="text-sm font-semibold text-ink">New guard</h2>

            <label className="mt-3 block text-xs font-medium text-ink-muted">Ad account</label>
            <select
              className="mt-1 w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm"
              value={adAccountId}
              onChange={(e) => setAdAccountId(e.target.value)}
            >
              <option value="">Select…</option>
              {accountsList.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>

            <label className="mt-3 block text-xs font-medium text-ink-muted">Campaign</label>
            <select
              className="mt-1 w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm"
              value={metaCampaignId}
              onChange={(e) => setMetaCampaignId(e.target.value)}
              disabled={!adAccountId || loadingCampaigns}
            >
              <option value="">{loadingCampaigns ? 'Loading…' : 'Select…'}</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>

            <div className="mt-3 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-muted">Ad sets</span>
              {adSetsList.length > 0 && (
                <button
                  className="text-xs text-sky-700 hover:underline"
                  onClick={() =>
                    setSelectedAdSetIds(
                      selectedAdSetIds.length === adSetsList.length
                        ? []
                        : adSetsList.map((s) => s.id)
                    )
                  }
                >
                  {selectedAdSetIds.length === adSetsList.length ? 'Clear' : 'Select all'}
                </button>
              )}
            </div>
            <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-black/10 p-1">
              {loadingAdSets ? (
                <div className="flex items-center gap-2 px-2 py-2 text-xs text-ink-muted">
                  <Loader2 size={12} className="animate-spin" /> Loading ad sets…
                </div>
              ) : adSetsList.length === 0 ? (
                <div className="px-2 py-2 text-xs text-ink-muted">Pick a campaign first.</div>
              ) : (
                adSetsList.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-black/5">
                    <input
                      type="checkbox"
                      checked={selectedAdSetIds.includes(s.id)}
                      onChange={() => toggleAdSet(s.id)}
                    />
                    <span className="truncate">{s.name}</span>
                  </label>
                ))
              )}
            </div>

            {/* Pages to administer */}
            <label className="mt-3 block text-xs font-medium text-ink-muted">
              Pages to administer
            </label>
            <div className="mt-1 max-h-32 overflow-y-auto rounded-lg border border-black/10 p-1">
              {pages.length === 0 ? (
                <div className="px-2 py-2 text-xs text-ink-muted">
                  No connected Pages. Connect a Facebook Page under Organic to enable hiding.
                </div>
              ) : (
                pages.map((p) => (
                  <label key={p.pageId} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-black/5">
                    <input
                      type="checkbox"
                      checked={selectedPageIds.includes(p.pageId)}
                      onChange={() => togglePage(p.pageId)}
                    />
                    <span className="truncate">{p.name ?? p.pageId}</span>
                  </label>
                ))
              )}
            </div>

            {/* Rules */}
            <div className="mt-4 space-y-2">
              <span className="text-xs font-medium text-ink-muted">Hide comments containing</span>
              {(['links', 'phone', 'profanity'] as const).map((key) => {
                const M = RULE_META[key];
                return (
                  <div key={key} className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-sm">
                      <M.icon size={14} className="text-ink-muted" /> {M.label}
                    </span>
                    <Toggle
                      size="sm"
                      checked={!!rules[key]}
                      onChange={(v) => setRules((r) => ({ ...r, [key]: v }))}
                    />
                  </div>
                );
              })}
              {/* Keywords */}
              <div className="flex flex-wrap gap-1.5">
                {(rules.keywords ?? []).map((k) => (
                  <span key={k} className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-xs text-sky-700">
                    {k}
                    <button onClick={() => removeKeyword(k)}><X size={11} /></button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  className="flex-1 rounded-lg border border-black/10 px-2 py-1.5 text-sm"
                  placeholder="Add keyword…"
                  value={keywordInput}
                  onChange={(e) => setKeywordInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(); } }}
                />
                <button className="rounded-lg border border-black/10 px-3 text-sm hover:bg-black/5" onClick={addKeyword}>
                  Add
                </button>
              </div>
            </div>

            {/* Interval */}
            <label className="mt-4 block text-xs font-medium text-ink-muted">Check every</label>
            <select
              className="mt-1 w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm"
              value={interval}
              onChange={(e) => setIntervalMin(Number(e.target.value))}
            >
              {COMMENT_GUARD_INTERVALS.map((m) => (
                <option key={m} value={m}>{m} minutes</option>
              ))}
            </select>

            <button
              className="mt-4 w-full rounded-lg bg-sky-600 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-40"
              disabled={!canCreate}
              onClick={startGuarding}
            >
              {creating ? 'Starting…' : 'Start guarding'}
            </button>
          </section>

          {/* Existing guards */}
          <section className="rounded-xl border border-black/10 bg-white p-4">
            <h2 className="text-sm font-semibold text-ink">Your guards</h2>
            <div className="mt-2 space-y-1">
              {guardsList.length === 0 && (
                <div className="px-1 py-2 text-xs text-ink-muted">None yet.</div>
              )}
              {guardsList.map((g) => (
                <button
                  key={g.id}
                  className={`flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-sm hover:bg-black/5 ${
                    selectedId === g.id ? 'bg-sky-50 ring-1 ring-sky-200' : ''
                  }`}
                  onClick={() => setSelectedId(g.id)}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {g.metaCampaignName ?? g.metaCampaignId}
                    </span>
                    <span className="text-xs text-ink-muted">
                      {g.commentsHidden} hidden · every {g.sweepIntervalMinutes}m
                    </span>
                  </span>
                  <StatusPill status={g.status} />
                </button>
              ))}
            </div>
          </section>
        </div>

        {/* ---------- Right: selected guard ---------- */}
        <div>
          {!guard ? (
            <div className="flex h-full min-h-[300px] items-center justify-center rounded-xl border border-dashed border-black/15 text-sm text-ink-muted">
              Select a guard, or create one to start hiding comments.
            </div>
          ) : (
            <div className="space-y-4">
              {/* Header + controls */}
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-black/10 bg-white p-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-base font-semibold text-ink">
                      {guard.metaCampaignName ?? guard.metaCampaignId}
                    </h2>
                    <StatusPill status={guard.status} />
                  </div>
                  <div className="mt-0.5 text-xs text-ink-muted">
                    {guard.targetsTotal} ads monitored · {guard.commentsHidden} comments hidden ·
                    checks every {guard.sweepIntervalMinutes}m
                    {guard.lastSweptAt && ` · last swept ${timeAgo(guard.lastSweptAt)}`}
                  </div>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <select
                    className="rounded-lg border border-black/10 px-2 py-1 text-xs"
                    value={guard.sweepIntervalMinutes}
                    disabled={busy}
                    onChange={(e) => patchGuard({ sweepIntervalMinutes: Number(e.target.value) })}
                  >
                    {COMMENT_GUARD_INTERVALS.map((m) => (
                      <option key={m} value={m}>{m}m</option>
                    ))}
                  </select>
                  {guard.status === 'active' ? (
                    <IconBtn onClick={() => patchGuard({ status: 'paused' })} disabled={busy} title="Pause">
                      <Pause size={14} /> Pause
                    </IconBtn>
                  ) : (
                    <IconBtn
                      onClick={() => patchGuard({ status: 'active' })}
                      disabled={busy || guard.status === 'scanning'}
                      title="Resume"
                    >
                      <Play size={14} /> Resume
                    </IconBtn>
                  )}
                  <IconBtn onClick={sweepNow} disabled={busy || guard.status !== 'active'} title="Sweep now">
                    <RefreshCw size={14} /> Sweep now
                  </IconBtn>
                  <IconBtn onClick={removeGuard} disabled={busy} title="Delete" danger>
                    <Trash2 size={14} />
                  </IconBtn>
                </div>
              </div>

              {guard.status === 'scanning' && (
                <div className="flex items-center gap-2 rounded-lg bg-sky-50 px-4 py-2 text-sm text-sky-700">
                  <Loader2 size={14} className="animate-spin" /> Scanning ads in this scope…
                </div>
              )}
              {guard.status === 'failed' && guard.errorMessage && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
                  Scan failed: {guard.errorMessage}
                </div>
              )}
              {unconnectedTargets > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
                  {unconnectedTargets} monitored ad(s) run on a Page that isn’t connected — their
                  comments can’t be hidden. Connect the Page under Organic to enable.
                </div>
              )}

              {/* Hidden comments log */}
              <section className="rounded-xl border border-black/10 bg-white">
                <div className="border-b border-black/5 px-4 py-2.5 text-sm font-semibold text-ink">
                  Hidden comments
                </div>
                {actions.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-ink-muted">
                    Nothing hidden yet.
                  </div>
                ) : (
                  <ul className="divide-y divide-black/5">
                    {actions.map((a) => {
                      const M = RULE_META[a.matchedRule] ?? RULE_META.keyword;
                      return (
                        <li key={a.id} className="flex items-start gap-3 px-4 py-3">
                          <M.icon size={14} className="mt-0.5 shrink-0 text-ink-muted" />
                          <div className="min-w-0 flex-1">
                            <div className="text-sm text-ink">
                              <span className={a.unhiddenAt ? 'line-through text-ink-muted' : ''}>
                                {a.commentMessage || <em className="text-ink-muted">(no text)</em>}
                              </span>
                            </div>
                            <div className="mt-0.5 text-xs text-ink-muted">
                              {a.authorName ?? 'Unknown'} · matched {M.label.toLowerCase()}
                              {a.matchedDetail ? ` “${a.matchedDetail}”` : ''} · {timeAgo(a.hiddenAt)}
                            </div>
                          </div>
                          {a.permalinkUrl && (
                            <a
                              href={a.permalinkUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-ink-muted hover:text-ink"
                              title="View on Facebook"
                            >
                              <Eye size={14} />
                            </a>
                          )}
                          {a.unhiddenAt ? (
                            <span className="text-xs text-ink-muted">unhidden</span>
                          ) : (
                            <button
                              className="rounded-md border border-black/10 px-2 py-1 text-xs hover:bg-black/5"
                              onClick={() => unhide(a.id)}
                            >
                              Unhide
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              {/* Monitored ads */}
              <section className="rounded-xl border border-black/10 bg-white">
                <div className="border-b border-black/5 px-4 py-2.5 text-sm font-semibold text-ink">
                  Monitored ads ({targets.length})
                </div>
                <div className="max-h-72 overflow-y-auto">
                  <table className="w-full text-sm">
                    <tbody>
                      {targets.map((t) => (
                        <tr key={t.id} className="border-b border-black/5 last:border-0">
                          <td className="px-4 py-2">
                            <div className="truncate font-medium">{t.metaAdName ?? t.metaAdId}</div>
                            {t.lastError && (
                              <div className="text-xs text-red-600">{t.lastError}</div>
                            )}
                          </td>
                          <td className="px-2 py-2 text-right text-xs text-ink-muted whitespace-nowrap">
                            {t.commentsHidden} hidden
                          </td>
                          <td className="px-4 py-2 text-right">
                            {t.pageConnected ? (
                              <span className="text-xs text-emerald-600">connected</span>
                            ) : (
                              <span className="text-xs text-amber-600">no Page</span>
                            )}
                          </td>
                        </tr>
                      ))}
                      {targets.length === 0 && (
                        <tr>
                          <td className="px-4 py-6 text-center text-sm text-ink-muted" colSpan={3}>
                            {guard.status === 'scanning' ? 'Resolving ads…' : 'No ads in scope.'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- small presentational helpers ----------

function StatusPill({ status }: { status: CommentGuard['status'] }) {
  const map: Record<string, string> = {
    active: 'bg-emerald-50 text-emerald-700',
    scanning: 'bg-sky-50 text-sky-700',
    paused: 'bg-slate-100 text-slate-600',
    pending: 'bg-slate-100 text-slate-600',
    failed: 'bg-red-50 text-red-700',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${map[status] ?? map.pending}`}>
      {status}
    </span>
  );
}

function IconBtn({
  children,
  onClick,
  disabled,
  title,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${
        danger
          ? 'border-red-200 text-red-600 hover:bg-red-50'
          : 'border-black/10 text-ink hover:bg-black/5'
      }`}
    >
      {children}
    </button>
  );
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
