'use client';

/**
 * BrandSelector — the canonical multi-select scope picker in the
 * TopBar (Patch 4.37.5 rework).
 *
 * The selector lets the user pick ANY combination of:
 *   - Brands (Groups)
 *   - Individual profiles (connected social accounts)
 *
 * Or "All brands" to clear the selection entirely. Selection is live —
 * click a row to toggle that item in or out of the scope. No Apply
 * button. The trigger label shows a useful summary of what's picked
 * ("All brands" / "Hyper Studio" / "Hyper Studio + 1 more" / "3
 * selected").
 *
 * UI: dropdown with a pinned search input at top, brands as expandable
 * tree nodes with their profiles indented under, then an "Ungrouped"
 * section at the bottom listing every profile not assigned to a brand.
 *
 * Persistence: the scope is JSON-stringified into localStorage under
 * VASS_ACTIVE_SCOPE_KEY. A legacy reader migrates the old
 * `string | 'all'` value into the new shape so existing users keep
 * their selection.
 *
 * Events:
 *   - `vass:active-scope-changed`  detail = ActiveScope (modern)
 *   - `vass:active-brand-changed`  detail = string (legacy, kept for
 *      back-compat — fires the implied brand id, or 'all' for
 *      multi-select)
 *
 * Backwards-compat helpers (exported):
 *   - getActiveBrandId(): single brand id ('all' if none / multi /
 *     ungrouped-profile-only). Used by code that hasn't been ported
 *     to scope-aware reads.
 *   - getActiveAccountIds(): the union of profile-scope item ids and
 *     all-profiles-in-brand-scope-item ids, given an accounts list.
 *     Returns null if the scope is "all".
 */
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import {
  ChevronDown,
  ChevronRight,
  Check,
  Boxes,
  Search,
  Folder,
  Facebook,
  Instagram,
  AtSign,
  X as XIcon,
} from 'lucide-react';
import {
  brands as brandsApi,
  organicAccounts as accountsApi,
  adAccounts as adAccountsApi,
  Brand,
  OrganicAccount,
  OrganicPlatform,
  AdAccount,
  ApiError,
} from '@/lib/api';
import { Megaphone } from 'lucide-react';

// ─── Storage keys & event names ──────────────────────────────────────

export const VASS_ACTIVE_BRAND_KEY = 'vass:active-brand';        // legacy
export const VASS_ACTIVE_SCOPE_KEY = 'vass:active-scope';        // current
export const VASS_ACTIVE_SCOPE_EVENT = 'vass:active-scope-changed';
export const VASS_ACTIVE_BRAND_EVENT = 'vass:active-brand-changed'; // legacy alias

// ─── Scope model ─────────────────────────────────────────────────────

export type ScopeItem =
  | { type: 'brand'; id: string }
  | { type: 'profile'; id: string }
  | { type: 'adaccount'; id: string };

/** ActiveScope is either:
 *  - { type: 'all' } — no filter at all
 *  - { type: 'multi', items: ScopeItem[] } — at least one item selected
 *
 *  The 'multi' wrapper exists so a future "OR" / "AND" toggle could be
 *  added without changing the discriminator. */
export type ActiveScope =
  | { type: 'all' }
  | { type: 'multi'; items: ScopeItem[] };

// ─── Read / write helpers ────────────────────────────────────────────

export function getActiveScope(): ActiveScope {
  if (typeof window === 'undefined') return { type: 'all' };
  // New key first
  const raw = window.localStorage.getItem(VASS_ACTIVE_SCOPE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') {
        const p = parsed as { type?: string; items?: unknown };
        if (p.type === 'all') return { type: 'all' };
        if (p.type === 'multi' && Array.isArray(p.items)) {
          // Validate items
          const items = (p.items as unknown[]).filter((it): it is ScopeItem => {
            if (!it || typeof it !== 'object') return false;
            const x = it as { type?: string; id?: unknown };
            return (
              (x.type === 'brand' || x.type === 'profile') &&
              typeof x.id === 'string' &&
              x.id.length > 0
            );
          });
          return items.length === 0 ? { type: 'all' } : { type: 'multi', items };
        }
        // Migration from the 4.37.4 single-scope shape
        if (p.type === 'brand' && 'brandId' in p && typeof (p as { brandId?: unknown }).brandId === 'string') {
          return { type: 'multi', items: [{ type: 'brand', id: (p as { brandId: string }).brandId }] };
        }
        if (p.type === 'profile' && 'accountId' in p && typeof (p as { accountId?: unknown }).accountId === 'string') {
          return { type: 'multi', items: [{ type: 'profile', id: (p as { accountId: string }).accountId }] };
        }
      }
    } catch {
      // fall through to legacy
    }
  }
  // Legacy: pre-4.37.4 stored a brand id directly
  const legacy = window.localStorage.getItem(VASS_ACTIVE_BRAND_KEY);
  if (legacy && legacy !== 'all') {
    return { type: 'multi', items: [{ type: 'brand', id: legacy }] };
  }
  return { type: 'all' };
}

/** Back-compat: return a single brand id or 'all'.
 *
 *  - 'all' scope → 'all'
 *  - exactly one brand picked → that brand id
 *  - exactly one profile picked (with a brand) → that profile's
 *    parent brand id (looked up from the accounts cache below)
 *  - anything else (multi, ungrouped-profile-only) → 'all'
 *
 *  Pages that only do brand-level filtering can keep calling this. */
export function getActiveBrandId(): string | 'all' {
  const s = getActiveScope();
  if (s.type === 'all') return 'all';
  if (s.items.length !== 1) return 'all';
  const only = s.items[0];
  if (only.type === 'brand') return only.id;
  // profile — look up its parent brand from the cached accounts list
  const acc = accountsCache.find((a) => a.id === only.id);
  return acc?.brandId ?? 'all';
}

/** Cache of accounts populated by the selector on load. Other modules
 *  read it to resolve profile→brand without re-hitting the API. */
let accountsCache: OrganicAccount[] = [];
/** Cache of ad accounts (Patch 4.38.0), same idea. */
let adAccountsCache: AdAccountLite[] = [];

/** Minimal ad-account shape the scope helpers need. */
export interface AdAccountLite {
  id: string;
  brandId: string | null;
}

/** Return the account ids implied by the scope, given the full
 *  accounts list. For brand items, expands to all accounts in that
 *  brand. For profile items, just that id. Returns null when the
 *  scope is "all" (no filter). */
export function getActiveAccountIds(allAccounts?: OrganicAccount[]): string[] | null {
  const list = allAccounts ?? accountsCache;
  const s = getActiveScope();
  if (s.type === 'all') return null;
  const ids = new Set<string>();
  for (const item of s.items) {
    if (item.type === 'profile') {
      ids.add(item.id);
    } else if (item.type === 'brand') {
      for (const a of list) {
        if (a.brandId === item.id) ids.add(a.id);
      }
    }
    // adaccount items contribute no organic profiles
  }
  return Array.from(ids);
}

/** Return the brand ids implied by the scope, given the full accounts
 *  list. Brand items contribute themselves; profile items contribute
 *  their parent brand (if any). Returns null when scope is 'all'. */
export function getActiveBrandIds(allAccounts?: OrganicAccount[]): string[] | null {
  const list = allAccounts ?? accountsCache;
  const s = getActiveScope();
  if (s.type === 'all') return null;
  const ids = new Set<string>();
  for (const item of s.items) {
    if (item.type === 'brand') {
      ids.add(item.id);
    } else if (item.type === 'profile') {
      const acc = list.find((a) => a.id === item.id);
      if (acc?.brandId) ids.add(acc.brandId);
    } else {
      // adaccount → its brand
      const ad = adAccountsCache.find((a) => a.id === item.id);
      if (ad?.brandId) ids.add(ad.brandId);
    }
  }
  return Array.from(ids);
}

/** Return the AD account ids implied by the scope (Patch 4.38.0).
 *  - brand items expand to all ad accounts in that brand
 *  - adaccount items contribute themselves
 *  - profile items contribute nothing (they're organic)
 *  Returns null when scope is 'all' (no filter — paid pages show
 *  everything). */
export function getActiveAdAccountIds(allAdAccounts?: AdAccountLite[]): string[] | null {
  const list = allAdAccounts ?? adAccountsCache;
  const s = getActiveScope();
  if (s.type === 'all') return null;
  const ids = new Set<string>();
  for (const item of s.items) {
    if (item.type === 'adaccount') {
      ids.add(item.id);
    } else if (item.type === 'brand') {
      for (const a of list) {
        if (a.brandId === item.id) ids.add(a.id);
      }
    }
    // profile items contribute no ad accounts
  }
  return Array.from(ids);
}

/** Persist a scope and broadcast it (both new and legacy events). */
export function setActiveScope(scope: ActiveScope) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(VASS_ACTIVE_SCOPE_KEY, JSON.stringify(scope));
  // Keep the legacy key in sync — best-effort approximation
  const legacyVal = (() => {
    if (scope.type === 'all') return 'all';
    if (scope.items.length !== 1) return 'all';
    const only = scope.items[0];
    if (only.type === 'brand') return only.id;
    const acc = accountsCache.find((a) => a.id === only.id);
    return acc?.brandId ?? 'all';
  })();
  window.localStorage.setItem(VASS_ACTIVE_BRAND_KEY, legacyVal);
  // Modern event
  window.dispatchEvent(new CustomEvent(VASS_ACTIVE_SCOPE_EVENT, { detail: scope }));
  // Legacy event — detail still a string
  window.dispatchEvent(new CustomEvent(VASS_ACTIVE_BRAND_EVENT, { detail: legacyVal }));
}

/** Legacy single-set entry point. */
export function setActiveBrandId(id: string | 'all') {
  setActiveScope(
    id === 'all'
      ? { type: 'all' }
      : { type: 'multi', items: [{ type: 'brand', id }] }
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

function platformIcon(platform: OrganicPlatform) {
  switch (platform) {
    case 'facebook_page': return Facebook;
    case 'instagram':     return Instagram;
    case 'threads':       return AtSign;
    default:              return AtSign;
  }
}
function accountDisplayName(a: OrganicAccount): string {
  return a.meta?.name || a.meta?.username || a.externalId;
}
function accountSubLabel(a: OrganicAccount): string {
  switch (a.platform) {
    case 'facebook_page': return 'Facebook page';
    case 'instagram':     return 'Instagram';
    case 'threads':       return 'Threads';
    default:              return a.platform;
  }
}

function isItemSelected(scope: ActiveScope, item: ScopeItem): boolean {
  if (scope.type === 'all') return false;
  return scope.items.some((x) => x.type === item.type && x.id === item.id);
}
function toggleItem(scope: ActiveScope, item: ScopeItem): ActiveScope {
  const current = scope.type === 'all' ? [] : scope.items;
  const idx = current.findIndex((x) => x.type === item.type && x.id === item.id);
  let next: ScopeItem[];
  if (idx >= 0) {
    next = [...current.slice(0, idx), ...current.slice(idx + 1)];
  } else {
    next = [...current, item];
  }
  return next.length === 0 ? { type: 'all' } : { type: 'multi', items: next };
}

// ─── Component ───────────────────────────────────────────────────────

/** A renderable member row in the tree — either an organic profile or
 *  an ad account, normalized to a common shape. */
type MemberRow = {
  kind: 'profile' | 'adaccount';
  id: string;
  name: string;
  sub: string;
  pictureUrl: string | null;
  platform?: OrganicPlatform;
};

export function BrandSelector() {
  const pathname = usePathname();
  // Two contexts: organic (Studio/Pipeline/Drafts/Ideas) and paid
  // (Launch/bulk-launch). The selector renders on both. The dropdown
  // shows organic profiles in organic context, ad accounts in paid
  // context — but the brand selection persists across the boundary.
  const onOrganic = pathname.startsWith('/organic');
  // Paid surfaces that should share the same scope selector. Adding a
  // route here makes the selector appear in the top bar there and the
  // brand/ad-account scope persist into it.
  const onPaid =
    pathname.startsWith('/launch') ||
    pathname.startsWith('/bulk-launch') ||
    pathname.startsWith('/sheets') ||
    pathname.startsWith('/audit') ||
    pathname.startsWith('/dashboard');
  const visible = onOrganic || onPaid;
  const context: 'organic' | 'paid' = onPaid ? 'paid' : 'organic';

  const [brands, setBrands] = useState<Brand[]>([]);
  const [accounts, setAccounts] = useState<OrganicAccount[]>([]);
  const [adAccts, setAdAccts] = useState<AdAccount[]>([]);
  const [scope, setScope] = useState<ActiveScope>({ type: 'all' });
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const wrapRef = useRef<HTMLDivElement>(null);

  // ─── Initial scope + cross-page sync ─────────────────────────────
  useEffect(() => {
    setScope(getActiveScope());
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && typeof detail === 'object' && 'type' in detail) {
        setScope(detail as ActiveScope);
      }
    };
    window.addEventListener(VASS_ACTIVE_SCOPE_EVENT, onChange);
    return () => window.removeEventListener(VASS_ACTIVE_SCOPE_EVENT, onChange);
  }, []);

  // ─── Load brands + both account types ────────────────────────────
  // We load both organic profiles AND ad accounts regardless of
  // context, so the scope helpers (getActiveAccountIds /
  // getActiveAdAccountIds) can resolve across the boundary even when
  // the user navigates paid→organic without re-opening the selector.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    Promise.all([
      brandsApi.list(),
      accountsApi.list(),
      adAccountsApi.list(true), // include disabled so all are groupable
    ])
      .then(([brandsRes, accountsRes, adRes]) => {
        if (cancelled) return;
        setBrands(brandsRes.brands);
        setAccounts(accountsRes.accounts);
        setAdAccts(adRes.accounts);
        accountsCache = accountsRes.accounts;
        adAccountsCache = adRes.accounts.map((a) => ({ id: a.id, brandId: a.brandId }));
      })
      .catch((err) => { if (!(err instanceof ApiError)) console.error(err); });
    return () => { cancelled = true; };
  }, [visible]);

  // ─── Auto-expand brands containing selected members ──────────────
  useEffect(() => {
    if (scope.type === 'multi') {
      const next: Record<string, boolean> = {};
      for (const item of scope.items) {
        if (item.type === 'brand') {
          next[item.id] = true;
        } else if (item.type === 'profile') {
          const acc = accounts.find((a) => a.id === item.id);
          if (acc?.brandId) next[acc.brandId] = true;
        } else {
          const ad = adAccts.find((a) => a.id === item.id);
          if (ad?.brandId) next[ad.brandId] = true;
        }
      }
      setExpanded((prev) => ({ ...prev, ...next }));
    }
  }, [scope, accounts]);

  // ─── Click-outside close ─────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  useEffect(() => { if (!open) setSearch(''); }, [open]);

  if (!visible) return null;

  // ─── Context-aware member resolution ─────────────────────────────
  // A "member" of a brand is an organic profile (organic context) or
  // an ad account (paid context). The tree renders members of the
  // active context only; the brand row itself is always selectable.
  const profilesByBrand = (brandId: string) =>
    accounts.filter((a) => a.brandId === brandId);
  const adAcctsByBrand = (brandId: string) =>
    adAccts.filter((a) => a.brandId === brandId);

  const membersInContextForBrand = (brandId: string): MemberRow[] => {
    if (context === 'paid') {
      return adAcctsByBrand(brandId).map((a) => ({
        kind: 'adaccount' as const,
        id: a.id,
        name: a.name,
        sub: a.metaAccountId,
        pictureUrl: a.pictureUrl,
      }));
    }
    return profilesByBrand(brandId).map((a) => ({
      kind: 'profile' as const,
      id: a.id,
      name: accountDisplayName(a),
      sub: accountSubLabel(a),
      pictureUrl: a.meta?.picture_url ?? null,
      platform: a.platform,
    }));
  };

  const ungroupedMembers = (): MemberRow[] => {
    if (context === 'paid') {
      return adAccts
        .filter((a) => !a.brandId)
        .map((a) => ({
          kind: 'adaccount' as const,
          id: a.id,
          name: a.name,
          sub: a.metaAccountId,
          pictureUrl: a.pictureUrl,
        }));
    }
    return accounts
      .filter((a) => !a.brandId)
      .map((a) => ({
        kind: 'profile' as const,
        id: a.id,
        name: accountDisplayName(a),
        sub: accountSubLabel(a),
        pictureUrl: a.meta?.picture_url ?? null,
        platform: a.platform,
      }));
  };

  // ─── Trigger label ───────────────────────────────────────────────
  const triggerLabel = (() => {
    if (scope.type === 'all') return 'All brands';
    if (scope.items.length === 1) {
      const item = scope.items[0];
      if (item.type === 'brand') {
        const b = brands.find((x) => x.id === item.id);
        return b?.name ?? 'Brand';
      }
      if (item.type === 'profile') {
        const a = accounts.find((x) => x.id === item.id);
        return a ? accountDisplayName(a) : 'Profile';
      }
      const ad = adAccts.find((x) => x.id === item.id);
      return ad ? ad.name : 'Ad account';
    }
    return `${scope.items.length} selected`;
  })();

  const triggerCount = scope.type === 'multi' ? scope.items.length : 0;

  // ─── Filtered tree based on search (context-aware members) ───────
  // Plain computation (not useMemo) — it runs after the early return,
  // and the inputs are cheap. Brands match if their name matches OR
  // any member in the active context matches.
  const q = search.trim().toLowerCase();
  const filteredBrands = brands.filter((b) => {
    if (!q) return true;
    if (b.name.toLowerCase().includes(q)) return true;
    return membersInContextForBrand(b.id).some((m) => m.name.toLowerCase().includes(q));
  });
  const membersForBrandFiltered = (brandId: string, brandName: string): MemberRow[] => {
    const members = membersInContextForBrand(brandId);
    if (!q) return members;
    if (brandName.toLowerCase().includes(q)) return members;
    return members.filter((m) => m.name.toLowerCase().includes(q));
  };
  const filteredUngrouped = ungroupedMembers().filter(
    (m) => !q || m.name.toLowerCase().includes(q)
  );
  const searching = q.length > 0;
  const totalMembersInContext =
    context === 'paid' ? adAccts.length : accounts.length;

  // ─── Selection actions ───────────────────────────────────────────
  const pickAll = () => {
    setActiveScope({ type: 'all' });
  };
  const toggleBrand = (id: string) => {
    setActiveScope(toggleItem(scope, { type: 'brand', id }));
  };
  const toggleMember = (m: MemberRow) => {
    setActiveScope(toggleItem(scope, { type: m.kind, id: m.id }));
  };
  const toggleExpand = (brandId: string) => {
    setExpanded((e) => ({ ...e, [brandId]: !e[brandId] }));
  };
  const clearAll = () => setActiveScope({ type: 'all' });

  const memberIcon = (m: MemberRow) => {
    if (m.kind === 'adaccount') return Megaphone;
    return m.platform ? platformIcon(m.platform) : AtSign;
  };

  // ─── Render ──────────────────────────────────────────────────────
  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 pl-2.5 pr-2 py-1.5 rounded-full bg-white/70 border border-white/60 hover:bg-white transition-colors shadow-subtle"
      >
        {scope.type === 'all' ? (
          <Boxes size={13} className="text-ink-muted" />
        ) : (
          <Folder size={13} className="text-ink-muted" />
        )}
        <span className="text-xs font-medium text-ink max-w-[170px] truncate">
          {triggerLabel}
        </span>
        {triggerCount > 1 && (
          <span className="text-2xs px-1.5 py-0.5 rounded-full bg-accent-subtle text-accent font-semibold">
            {triggerCount}
          </span>
        )}
        <ChevronDown size={13} className="text-ink-subtle" />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-white border border-line rounded-lg shadow-lift z-50 animate-fade-in flex flex-col max-h-[70vh]">
          {/* Pinned search box */}
          <div className="px-2.5 py-2 border-b border-line/70">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-subtle pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={context === 'paid' ? 'Search brands and ad accounts…' : 'Search brands and profiles…'}
                className="w-full pl-7 pr-2.5 py-1.5 rounded-lg border border-line bg-surface-alt/40 text-xs text-ink placeholder:text-ink-subtle focus:outline-none focus:border-accent focus:bg-white"
              />
            </div>
          </div>

          {/* Selection summary bar — only shown when something is picked */}
          {scope.type === 'multi' && scope.items.length > 0 && (
            <div className="px-3 py-1.5 border-b border-line/70 flex items-center justify-between text-xs text-ink-muted">
              <span>{scope.items.length} selected</span>
              <button
                onClick={clearAll}
                className="inline-flex items-center gap-1 text-ink-subtle hover:text-ink transition-colors"
              >
                <XIcon size={11} />
                Clear
              </button>
            </div>
          )}

          {/* Scrollable list */}
          <div className="flex-1 overflow-y-auto py-1">
            {/* "All brands" — selecting this clears the scope */}
            <button
              onClick={pickAll}
              className="flex items-center gap-2.5 w-full text-left px-3 py-2 text-sm hover:bg-surface-hover transition-colors"
            >
              <Boxes size={13} className="text-ink-muted shrink-0" />
              <span className="flex-1 text-ink">All brands</span>
              <span className="text-2xs text-ink-subtle">{totalMembersInContext}</span>
              {scope.type === 'all' && <Check size={13} className="text-accent ml-1" />}
            </button>

            {filteredBrands.length > 0 && <div className="my-1 border-t border-line/60" />}

            {/* Brands (groups) — each row is selectable + expandable */}
            {filteredBrands.map((b) => {
              const members = membersForBrandFiltered(b.id, b.name);
              const isExpanded = searching || expanded[b.id];
              const isBrandActive = isItemSelected(scope, { type: 'brand', id: b.id });
              return (
                <div key={b.id}>
                  <div className="flex items-stretch">
                    {members.length > 0 ? (
                      <button
                        onClick={() => toggleExpand(b.id)}
                        className="px-1.5 flex items-center text-ink-subtle hover:text-ink hover:bg-surface-hover transition-colors"
                        aria-label={isExpanded ? 'Collapse' : 'Expand'}
                      >
                        {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                      </button>
                    ) : (
                      <span className="w-[26px]" />
                    )}
                    <button
                      onClick={() => toggleBrand(b.id)}
                      className="flex-1 flex items-center gap-2.5 text-left pr-3 py-2 text-sm hover:bg-surface-hover transition-colors"
                    >
                      {b.thumbnailUrl ? (
                        <span
                          className="w-4 h-4 rounded-full shrink-0 overflow-hidden"
                          style={{ boxShadow: `0 0 0 1.5px ${b.color}` }}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={b.thumbnailUrl} alt="" className="w-full h-full object-cover" />
                        </span>
                      ) : (
                        <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: b.color }} />
                      )}
                      <span className="flex-1 text-ink truncate">{b.name}</span>
                      <span className="text-2xs text-ink-subtle">{members.length}</span>
                      {isBrandActive && <Check size={13} className="text-accent ml-1" />}
                    </button>
                  </div>
                  {isExpanded && members.map((m) => {
                    const Icon = memberIcon(m);
                    const isMemberActive = isItemSelected(scope, { type: m.kind, id: m.id });
                    return (
                      <button
                        key={m.id}
                        onClick={() => toggleMember(m)}
                        className="flex items-center gap-2.5 w-full text-left pl-10 pr-3 py-1.5 text-xs hover:bg-surface-hover transition-colors"
                      >
                        {m.pictureUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={m.pictureUrl}
                            alt=""
                            className="w-4 h-4 rounded-full shrink-0 object-cover"
                          />
                        ) : (
                          <Icon size={11} className="text-ink-subtle shrink-0" />
                        )}
                        <span className="flex-1 text-ink truncate">{m.name}</span>
                        <span className="text-2xs text-ink-subtle">{m.sub}</span>
                        {isMemberActive && <Check size={12} className="text-accent ml-1" />}
                      </button>
                    );
                  })}
                </div>
              );
            })}

            {/* Ungrouped */}
            {filteredUngrouped.length > 0 && (
              <>
                <div className="my-1 border-t border-line/60" />
                <div className="px-3 pt-1.5 pb-1 text-2xs uppercase tracking-wider font-semibold text-ink-subtle">
                  Ungrouped
                </div>
                {filteredUngrouped.map((m) => {
                  const Icon = memberIcon(m);
                  const isMemberActive = isItemSelected(scope, { type: m.kind, id: m.id });
                  return (
                    <button
                      key={m.id}
                      onClick={() => toggleMember(m)}
                      className="flex items-center gap-2.5 w-full text-left px-3 py-1.5 text-xs hover:bg-surface-hover transition-colors"
                    >
                      {m.pictureUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={m.pictureUrl}
                          alt=""
                          className="w-4 h-4 rounded-full shrink-0 object-cover"
                        />
                      ) : (
                        <Icon size={11} className="text-ink-subtle shrink-0" />
                      )}
                      <span className="flex-1 text-ink truncate">{m.name}</span>
                      <span className="text-2xs text-ink-subtle">{m.sub}</span>
                      {isMemberActive && <Check size={12} className="text-accent ml-1" />}
                    </button>
                  );
                })}
              </>
            )}

            {filteredBrands.length === 0 && filteredUngrouped.length === 0 && (
              <div className="px-3 py-4 text-xs text-ink-subtle text-center">
                {searching ? 'No matches.' : (
                  <>
                    {context === 'paid'
                      ? 'No ad accounts yet. Sync them in Settings → Ad accounts.'
                      : (
                        <>
                          No brands or profiles yet. Connect one in{' '}
                          <a href="/settings/social-profiles" className="text-accent hover:underline">
                            Settings → Social profiles
                          </a>.
                        </>
                      )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
