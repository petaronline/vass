'use client';

/**
 * Settings → Social Profiles
 *
 * Two-column layout:
 *
 *   ┌─────────────────┬──────────────────────────────────────┐
 *   │ Groupings       │ Selected brand: header + actions     │
 *   │   • Unassigned  │ ─────────────────────────────────    │
 *   │   • Brand A     │ Network: [All ▼]                     │
 *   │   • Brand B     │ ─────────────────────────────────    │
 *   │   + New brand   │ [Account card 1]                     │
 *   │ ─────────────── │ [Account card 2]                     │
 *   │ Connect profile │ [Account card 3]                     │
 *   │   • FB Pages    │                                      │
 *   │   • Instagram   │                                      │
 *   └─────────────────┴──────────────────────────────────────┘
 *
 * Drag accounts between brand rows on the left to reassign. Native
 * HTML5 drag-and-drop. Brands are per-user.
 *
 * Connect Profile block sits in the left rail as its own section, below
 * Groupings — keeps the right side focused on what's in the selected
 * brand. Future networks (Threads, TikTok, LinkedIn, YouTube) get added
 * here as patches land.
 */

import { useEffect, useState, useCallback, useRef, DragEvent } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  Plus,
  Trash2,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Edit2,
  X,
  Check,
  Inbox,
  Facebook,
  Instagram,
  AtSign,
  Music2,
  Linkedin,
  GripVertical,
  ExternalLink,
  ChevronDown,
  Search,
} from 'lucide-react';
import {
  organicAccounts,
  brands as brandsApi,
  brandHashtags as brandHashtagsApi,
  OrganicAccount,
  OrganicPlatform,
  Brand,
  ApiError,
} from '@/lib/api';

// ─── Platform config ─────────────────────────────────────────────────────────

interface PlatformConfig {
  id: OrganicPlatform;
  label: string;
  icon: typeof Facebook;
  iconColor: string;
  connectLabel: string;
}

/** Only platforms that actually work today. Add to this list as new
 *  patches add OAuth flows (TikTok next). Threads landed in 4.34. */
const SUPPORTED_PLATFORMS: PlatformConfig[] = [
  { id: 'facebook_page', label: 'Facebook Pages', icon: Facebook,  iconColor: '#1877F2', connectLabel: 'Connect Facebook Pages' },
  { id: 'instagram',     label: 'Instagram',      icon: Instagram, iconColor: '#E1306C', connectLabel: 'Connect Instagram' },
  { id: 'threads',       label: 'Threads',        icon: AtSign,    iconColor: '#000000', connectLabel: 'Connect Threads' },
  { id: 'tiktok',        label: 'TikTok',         icon: Music2,    iconColor: '#000000', connectLabel: 'Connect TikTok' },
  { id: 'linkedin',      label: 'LinkedIn (Profile)', icon: Linkedin,  iconColor: '#0A66C2', connectLabel: 'Connect LinkedIn Profile' },
];

const PLATFORM_BY_ID: Record<OrganicPlatform, PlatformConfig | undefined> = {
  facebook_page: SUPPORTED_PLATFORMS[0],
  instagram:     SUPPORTED_PLATFORMS[1],
  threads:       SUPPORTED_PLATFORMS[2],
  tiktok:        SUPPORTED_PLATFORMS[3],
  linkedin:      SUPPORTED_PLATFORMS[4],
};

// ─── Brand color palette ─────────────────────────────────────────────────────

const BRAND_COLORS = [
  '#6366F1', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444',
  '#EC4899', '#8B5CF6', '#14B8A6', '#F97316', '#64748B',
];

// ─── Toast ────────────────────────────────────────────────────────────────────

interface Toast { id: number; type: 'success' | 'error'; message: string; }
let toastCounter = 0;

const UNASSIGNED_ID = '__unassigned__';

// ─── Network filter ──────────────────────────────────────────────────────────

type NetworkFilter = 'all' | OrganicPlatform;

// ═══════════════════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════════════════

export default function SocialProfilesPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [accounts, setAccounts] = useState<OrganicAccount[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedBrandId, setSelectedBrandId] = useState<string>(UNASSIGNED_ID);
  const [networkFilter, setNetworkFilter] = useState<NetworkFilter>('all');
  const [networkMenuOpen, setNetworkMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const [connecting, setConnecting] = useState<OrganicPlatform | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  const [creatingBrand, setCreatingBrand] = useState(false);
  const [newBrandName, setNewBrandName] = useState('');
  const [newBrandColor, setNewBrandColor] = useState(BRAND_COLORS[0]);
  const [editingBrandId, setEditingBrandId] = useState<string | null>(null);
  const [editingBrandName, setEditingBrandName] = useState('');
  const [dragOverBrandId, setDragOverBrandId] = useState<string | null>(null);

  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((type: Toast['type'], message: string) => {
    const id = ++toastCounter;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [accountsResp, brandsResp] = await Promise.all([
        organicAccounts.list(),
        brandsApi.list(),
      ]);
      setAccounts(accountsResp.accounts);
      setBrands(brandsResp.brands);
    } catch (err) {
      addToast('error', err instanceof ApiError ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    loadAll();
    const status = searchParams.get('oauth_status');
    const message = searchParams.get('oauth_message');
    if (status === 'success' && message) {
      addToast('success', message);
      router.replace('/settings/social-profiles', { scroll: false });
    } else if (status === 'error' && message) {
      addToast('error', message);
      router.replace('/settings/social-profiles', { scroll: false });
    }

    // Threads OAuth uses different query params because its callback
    // ends up coming back via a different route. Same UX, different
    // wire format.
    const threadsConnected = searchParams.get('threads_connected');
    const threadsError = searchParams.get('threads_oauth_error');
    if (threadsConnected) {
      addToast('success', 'Threads account connected');
      router.replace('/settings/social-profiles', { scroll: false });
    } else if (threadsError) {
      addToast('error', `Threads OAuth failed: ${threadsError}`);
      router.replace('/settings/social-profiles', { scroll: false });
    }

    const tiktokConnected = searchParams.get('tiktok_connected');
    const tiktokError = searchParams.get('tiktok_oauth_error');
    if (tiktokConnected) {
      addToast('success', 'TikTok account connected');
      router.replace('/settings/social-profiles', { scroll: false });
    } else if (tiktokError) {
      addToast('error', `TikTok OAuth failed: ${tiktokError}`);
      router.replace('/settings/social-profiles', { scroll: false });
    }

    const linkedinConnected = searchParams.get('linkedin_connected');
    const linkedinError = searchParams.get('linkedin_oauth_error');
    if (linkedinConnected) {
      addToast('success', 'LinkedIn connected — profile and any admined pages added');
      router.replace('/settings/social-profiles', { scroll: false });
    } else if (linkedinError) {
      addToast('error', `LinkedIn OAuth failed: ${linkedinError}`);
      router.replace('/settings/social-profiles', { scroll: false });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Connect / disconnect ──────────────────────────────────────────────────

  // `target` is usually a platform id, plus the pseudo-target
  // 'linkedin_org' for the separate company-pages app (Community
  // Management). Both produce 'linkedin' accounts but use different
  // OAuth apps/endpoints.
  const handleConnect = async (target: OrganicPlatform | 'linkedin_org') => {
    setConnecting(target === 'linkedin_org' ? 'linkedin' : target);
    try {
      // Threads has its own OAuth endpoint (separate Meta App, separate
      // host at threads.net). FB Pages and Instagram share the workspace
      // Meta App's OAuth.
      const { url } =
        target === 'threads'
          ? await organicAccounts.getThreadsOAuthUrl()
          : target === 'tiktok'
          ? await organicAccounts.getTikTokOAuthUrl()
          : target === 'linkedin'
          ? await organicAccounts.getLinkedInOAuthUrl()
          : target === 'linkedin_org'
          ? await organicAccounts.getLinkedInOrgOAuthUrl()
          : await organicAccounts.getOAuthUrl(target);
      window.location.href = url;
    } catch (err) {
      addToast('error', err instanceof ApiError ? err.message : 'Failed to start OAuth');
      setConnecting(null);
    }
  };

  const handleDisconnect = async (account: OrganicAccount) => {
    const name = account.meta.name ?? account.meta.username ?? account.externalId;
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

  // ─── Brands CRUD ───────────────────────────────────────────────────────────

  const handleCreateBrand = async () => {
    const trimmed = newBrandName.trim();
    if (!trimmed) return;
    try {
      const { brand } = await brandsApi.create({ name: trimmed, color: newBrandColor });
      setBrands((prev) => [...prev, brand]);
      setNewBrandName('');
      setNewBrandColor(BRAND_COLORS[0]);
      setCreatingBrand(false);
      setSelectedBrandId(brand.id);
      addToast('success', `Created brand "${brand.name}"`);
    } catch (err) {
      addToast('error', err instanceof ApiError ? err.message : 'Failed to create brand');
    }
  };

  const handleStartEditBrand = (brand: Brand) => {
    setEditingBrandId(brand.id);
    setEditingBrandName(brand.name);
  };

  const handleSaveEditBrand = async (brand: Brand) => {
    const trimmed = editingBrandName.trim();
    if (!trimmed || trimmed === brand.name) {
      setEditingBrandId(null);
      return;
    }
    try {
      const { brand: updated } = await brandsApi.update(brand.id, { name: trimmed });
      setBrands((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
      setEditingBrandId(null);
    } catch (err) {
      addToast('error', err instanceof ApiError ? err.message : 'Failed to rename');
    }
  };

  const handleUpdateBrandColor = async (brand: Brand, color: string) => {
    try {
      const { brand: updated } = await brandsApi.update(brand.id, { color });
      setBrands((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
    } catch (err) {
      addToast('error', err instanceof ApiError ? err.message : 'Failed to update color');
    }
  };

  const handleDeleteBrand = async (brand: Brand) => {
    const inBrand = accounts.filter((a) => a.brandId === brand.id).length;
    const message = inBrand
      ? `Delete brand "${brand.name}"? ${inBrand} account${inBrand === 1 ? '' : 's'} will move to Unassigned.`
      : `Delete brand "${brand.name}"?`;
    if (!confirm(message)) return;
    try {
      await brandsApi.delete(brand.id);
      setBrands((prev) => prev.filter((b) => b.id !== brand.id));
      setAccounts((prev) =>
        prev.map((a) => (a.brandId === brand.id ? { ...a, brandId: null } : a))
      );
      if (selectedBrandId === brand.id) setSelectedBrandId(UNASSIGNED_ID);
      addToast('success', `Deleted brand "${brand.name}"`);
    } catch (err) {
      addToast('error', err instanceof ApiError ? err.message : 'Failed to delete');
    }
  };

  // ─── Drag and drop ─────────────────────────────────────────────────────────

  const handleDragStart = (e: DragEvent<HTMLLIElement>, accountId: string) => {
    e.dataTransfer.setData('text/vass-account', accountId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOverBrand = (e: DragEvent<HTMLLIElement>, brandId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverBrandId(brandId);
  };

  const handleDragLeaveBrand = () => setDragOverBrandId(null);

  const handleDropOnBrand = async (e: DragEvent<HTMLLIElement>, targetBrandId: string) => {
    e.preventDefault();
    setDragOverBrandId(null);
    const accountId = e.dataTransfer.getData('text/vass-account');
    if (!accountId) return;

    const account = accounts.find((a) => a.id === accountId);
    if (!account) return;

    const newBrandId = targetBrandId === UNASSIGNED_ID ? null : targetBrandId;
    if (account.brandId === newBrandId) return;

    setAccounts((prev) =>
      prev.map((a) => (a.id === accountId ? { ...a, brandId: newBrandId } : a))
    );
    try {
      await brandsApi.assignAccount(accountId, newBrandId);
    } catch (err) {
      setAccounts((prev) =>
        prev.map((a) => (a.id === accountId ? { ...a, brandId: account.brandId } : a))
      );
      addToast('error', err instanceof ApiError ? err.message : 'Failed to move account');
    }
  };

  // ─── Derived ───────────────────────────────────────────────────────────────
  // Patch 4.38.3: this page is now a flat list of ALL connected
  // profiles. Brand grouping moved entirely to Settings → Brands, so
  // assigned profiles no longer disappear here — you can always see
  // everything that's connected. Only network + search narrow the list.

  const visibleAccounts = accounts
    .filter((a) => networkFilter === 'all' || a.platform === networkFilter)
    .filter((a) => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase().trim();
      const name = (a.meta.name ?? '').toLowerCase();
      const username = (a.meta.username ?? '').toLowerCase();
      return name.includes(q) || username.includes(q);
    });

  const totalAccounts = accounts.length;
  // ─── Render ────────────────────────────────────────────────────────────────

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

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="h-section text-ink">Social profiles</h2>
          <p className="text-sm text-ink-muted mt-0.5">
            Connect your social accounts and organize them into brands.
          </p>
        </div>
        <button
          onClick={() => { setLoading(true); loadAll(); }}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-ink-muted hover:text-ink rounded-lg hover:bg-white/55 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">
        {/* ═══ Left rail — Connect a profile only ══════════════════════════ */}
        <aside className="space-y-5 self-start">
          <div className="bg-white/72 backdrop-blur-card border border-white/60 rounded-lg shadow-glass p-3">
            <div className="px-2 py-1.5 text-2xs uppercase tracking-wider font-semibold text-ink-subtle">
              Connect a profile
            </div>
            <ul className="space-y-0.5">
              {SUPPORTED_PLATFORMS.map((platform) => {
                const Icon = platform.icon;
                const isConnecting = connecting === platform.id;
                return (
                  <li key={platform.id}>
                    <button
                      onClick={() => handleConnect(platform.id)}
                      disabled={isConnecting || !!connecting}
                      className="flex items-center gap-3 w-full px-2.5 py-2 rounded-lg text-sm font-medium text-ink hover:bg-white/55 transition-colors disabled:opacity-50"
                    >
                      <div
                        className="w-6 h-6 rounded flex items-center justify-center shrink-0"
                        style={{ backgroundColor: `${platform.iconColor}18` }}
                      >
                        {isConnecting ? (
                          <RefreshCw size={12} className="animate-spin" style={{ color: platform.iconColor }} />
                        ) : (
                          <Icon size={12} style={{ color: platform.iconColor }} strokeWidth={2.2} />
                        )}
                      </div>
                      <span className="flex-1 text-left">{platform.label}</span>
                      <Plus size={13} className="text-ink-subtle" />
                    </button>
                  </li>
                );
              })}
              {/* LinkedIn Company Pages — separate Community Management
                  app, so it's its own connect action (not in
                  SUPPORTED_PLATFORMS, which is keyed by platform id). */}
              <li key="linkedin_org">
                <button
                  onClick={() => handleConnect('linkedin_org')}
                  disabled={!!connecting}
                  className="flex items-center gap-3 w-full px-2.5 py-2 rounded-lg text-sm font-medium text-ink hover:bg-white/55 transition-colors disabled:opacity-50"
                >
                  <div
                    className="w-6 h-6 rounded flex items-center justify-center shrink-0"
                    style={{ backgroundColor: '#0A66C218' }}
                  >
                    {connecting === 'linkedin' ? (
                      <RefreshCw size={12} className="animate-spin" style={{ color: '#0A66C2' }} />
                    ) : (
                      <Linkedin size={12} style={{ color: '#0A66C2' }} strokeWidth={2.2} />
                    )}
                  </div>
                  <span className="flex-1 text-left">LinkedIn (Pages)</span>
                  <Plus size={13} className="text-ink-subtle" />
                </button>
              </li>
            </ul>
            <p className="px-2.5 pt-2 text-2xs text-ink-subtle leading-relaxed">
              More networks (Threads, TikTok, LinkedIn) coming soon.
            </p>
          </div>

          {/* Grouping hint — points to the Brands page */}
          <div className="px-3 py-2.5 rounded-lg bg-white/40 border border-white/60 text-2xs text-ink-muted leading-relaxed">
            Organize these profiles into brands in{' '}
            <a href="/settings/brands" className="text-accent hover:underline">Settings → Brands</a>.
          </div>
        </aside>

        {/* ═══ Right pane — flat list of all profiles ══════════════════════ */}
        <div>
          <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div>
                <div className="text-sm font-semibold text-ink">All profiles</div>
                <div className="text-xs text-ink-subtle">
                  Every connected social profile.
                </div>
              </div>
            </div>

            {/* Network filter dropdown */}
            <NetworkFilterDropdown
              value={networkFilter}
              onChange={setNetworkFilter}
              open={networkMenuOpen}
              setOpen={setNetworkMenuOpen}
              total={totalAccounts}
              filtered={visibleAccounts.length}
            />
          </div>

          {/* Search bar */}
          {totalAccounts > 0 && (
            <div className="relative mb-3">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle pointer-events-none"
              />
              <input
                type="search"
                placeholder="Search by name or @handle…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm bg-white/70 border border-white/60 rounded-lg placeholder:text-ink-subtle focus:bg-white focus:border-accent focus:ring-2 focus:ring-accent/15 focus:outline-none transition-colors"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-ink-subtle hover:text-ink"
                  aria-label="Clear search"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          )}

          {/* Accounts list */}
          {visibleAccounts.length > 0 ? (
            <ul className="space-y-2">
              {visibleAccounts.map((account) => (
                <AccountCard
                  key={account.id}
                  account={account}
                  onDisconnect={handleDisconnect}
                  isDisconnecting={disconnecting === account.id}
                  onDragStart={handleDragStart}
                />
              ))}
            </ul>
          ) : (
            <div className="border border-dashed border-line rounded-lg px-6 py-12 text-center bg-white/30">
              <p className="text-sm text-ink-muted">
                {searchQuery.trim()
                  ? `No matches for "${searchQuery}".`
                  : totalAccounts === 0
                  ? 'No profiles connected yet. Use the Connect a profile section on the left.'
                  : `No ${networkLabel(networkFilter)} profiles. Try a different network filter.`}
              </p>
            </div>
          )}

          {/* Permissions note (at the very bottom) */}
          <div className="mt-6 flex items-start gap-3 px-4 py-3 rounded-lg bg-white/40 border border-white/60 text-xs text-ink-muted">
            <AlertCircle size={14} className="shrink-0 mt-0.5 text-ink-subtle" />
            <p>
              These connections use your workspace Meta App. For production use beyond
              Developer/Tester roles, Meta requires App Review for{' '}
              <code className="text-2xs font-mono bg-surface-hover px-1 py-0.5 rounded">pages_manage_posts</code>{' '}
              and{' '}
              <code className="text-2xs font-mono bg-surface-hover px-1 py-0.5 rounded">instagram_content_publish</code>.{' '}
              <a
                href="https://developers.facebook.com/docs/app-review"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline inline-flex items-center gap-1"
              >
                Learn more <ExternalLink size={10} />
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Brand row in left list ──────────────────────────────────────────────────

function BrandRow({
  isActive,
  isDragOver,
  color,
  icon,
  thumbnailUrl,
  label,
  count,
  onClick,
  onDragOver,
  onDragLeave,
  onDrop,
  onEdit,
  onDelete,
}: {
  isActive: boolean;
  isDragOver: boolean;
  color: string;
  icon?: React.ReactNode;
  /** Profile picture of the first profile in the brand. Falls back to the
      color dot when unset (brand has no profiles yet). */
  thumbnailUrl?: string | null;
  label: string;
  count: number;
  onClick: () => void;
  onDragOver: (e: DragEvent<HTMLLIElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent<HTMLLIElement>) => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <li
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={[
        'group flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors',
        isActive ? 'bg-accent-subtle text-accent' : 'text-ink hover:bg-white/60',
        isDragOver ? 'ring-2 ring-accent/50 bg-accent-subtle' : '',
      ].join(' ')}
      onClick={onClick}
    >
      {icon ? (
        <span className="shrink-0 text-ink-muted">{icon}</span>
      ) : thumbnailUrl ? (
        // First-profile thumbnail with a brand-colored ring so the brand
        // color still reads at a glance.
        <div
          className="w-5 h-5 rounded-full shrink-0 overflow-hidden ring-2"
          style={{ boxShadow: `0 0 0 2px ${color}` }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={thumbnailUrl} alt="" className="w-full h-full object-cover" />
        </div>
      ) : (
        <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: color }} />
      )}
      <span className="flex-1 text-sm font-medium truncate">{label}</span>
      <span className={[
        'text-2xs font-semibold px-1.5 rounded-full',
        isActive ? 'bg-accent/15' : 'bg-surface-hover text-ink-subtle',
      ].join(' ')}>
        {count}
      </span>
      {onEdit && onDelete && (
        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5">
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="p-1 text-ink-subtle hover:text-ink rounded"
            title="Rename"
          >
            <Edit2 size={11} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="p-1 text-ink-subtle hover:text-danger rounded"
            title="Delete"
          >
            <Trash2 size={11} />
          </button>
        </div>
      )}
    </li>
  );
}

// ─── Network filter dropdown ─────────────────────────────────────────────────

function NetworkFilterDropdown({
  value,
  onChange,
  open,
  setOpen,
  total,
  filtered,
}: {
  value: NetworkFilter;
  onChange: (v: NetworkFilter) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
  total: number;
  filtered: number;
}) {
  const label = networkLabel(value);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="btn-secondary btn-sm"
      >
        <span className="text-ink-muted text-xs">Network:</span>
        <span className="font-medium text-ink">{label}</span>
        <span className="text-xs text-ink-subtle">
          {value === 'all' ? `(${total})` : `(${filtered}/${total})`}
        </span>
        <ChevronDown size={13} className="text-ink-subtle" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 z-20 w-44 bg-white border border-line rounded-lg shadow-lift py-1 animate-fade-in">
            <FilterItem label="All networks" active={value === 'all'} onClick={() => { onChange('all'); setOpen(false); }} />
            {SUPPORTED_PLATFORMS.map((p) => (
              <FilterItem
                key={p.id}
                label={p.label}
                color={p.iconColor}
                active={value === p.id}
                onClick={() => { onChange(p.id); setOpen(false); }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function FilterItem({
  label,
  color,
  active,
  onClick,
}: {
  label: string;
  color?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2.5 w-full text-left px-3 py-2 text-sm hover:bg-surface-hover transition-colors"
    >
      {color ? (
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
      ) : (
        <span className="w-2.5 h-2.5 rounded-full bg-ink-subtle shrink-0" />
      )}
      <span className="flex-1 text-ink">{label}</span>
      {active && <Check size={12} className="text-accent" />}
    </button>
  );
}

function networkLabel(v: NetworkFilter): string {
  if (v === 'all') return 'All';
  return PLATFORM_BY_ID[v]?.label ?? v;
}

// ─── Account card ────────────────────────────────────────────────────────────

function AccountCard({
  account,
  onDisconnect,
  isDisconnecting,
  onDragStart,
}: {
  account: OrganicAccount;
  onDisconnect: (a: OrganicAccount) => void;
  isDisconnecting: boolean;
  onDragStart: (e: DragEvent<HTMLLIElement>, accountId: string) => void;
}) {
  const platform = PLATFORM_BY_ID[account.platform];
  const PlatformIcon = platform?.icon ?? Facebook;
  const displayName = account.meta.name ?? account.meta.username ?? account.externalId;
  const handle = account.meta.username ? `@${account.meta.username}` : null;
  const pictureUrl = account.meta.picture_url;
  const followersCount = account.meta.followers_count;
  const linkedPage = account.meta.linked_page_name;

  const isExpired = account.tokenExpiresAt
    ? new Date(account.tokenExpiresAt) < new Date()
    : false;

  return (
    <li
      draggable
      onDragStart={(e) => onDragStart(e, account.id)}
      className="flex items-center gap-3 px-4 py-3 bg-white/70 backdrop-blur-card border border-white/60 rounded-lg shadow-subtle hover:shadow-card transition-shadow cursor-grab active:cursor-grabbing"
    >
      <GripVertical size={14} className="text-ink-subtle shrink-0" />

      <div className="relative shrink-0">
        <div className="w-10 h-10 rounded-full overflow-hidden bg-surface-hover flex items-center justify-center">
          {pictureUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={pictureUrl} alt={displayName ?? ''} className="w-full h-full object-cover" />
          ) : (
            <span className="text-sm font-semibold text-ink-muted">
              {(displayName ?? '?').charAt(0).toUpperCase()}
            </span>
          )}
        </div>
        <div className="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-white flex items-center justify-center border border-white">
          <PlatformIcon size={11} style={{ color: platform?.iconColor }} strokeWidth={2.5} />
        </div>
      </div>

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
          {handle && <span className="text-xs text-ink-muted">{handle}</span>}
          {followersCount != null && (
            <span className="text-xs text-ink-subtle">
              {formatCount(followersCount)} followers
            </span>
          )}
          {linkedPage && account.platform === 'instagram' && (
            <span className="text-xs text-ink-subtle truncate">via {linkedPage}</span>
          )}
        </div>
      </div>

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

// ─── Inline color picker for brand header ────────────────────────────────────

function ColorPicker({ current, onChange }: { current: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="p-1 text-ink-subtle hover:text-ink rounded"
        title="Change color"
      >
        <Edit2 size={11} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 z-20 p-2 bg-white border border-line rounded-lg shadow-lift flex gap-1.5 w-max">
            {BRAND_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => { onChange(c); setOpen(false); }}
                className={[
                  'w-5 h-5 rounded-full border-2 transition-transform',
                  current === c ? 'border-ink scale-110' : 'border-transparent hover:scale-105',
                ].join(' ')}
                style={{ backgroundColor: c }}
                title={c}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── Brand hashtags inline section ──────────────────────────────────────────

/**
 * Inline brand hashtag editor — renders in the right pane under the
 * profile list when a real brand (not Unassigned) is selected.
 *
 * UX notes:
 *   - Up to 10 tags allowed; the first 3 are framed as "recommended."
 *     A subtle hint reminds users to keep it tight.
 *   - Chip input: type → Enter/comma/space to add. Backspace on empty
 *     input deletes the last chip.
 *   - Tags stored without the leading '#', lowercased, invalid chars
 *     stripped at the boundary (backend re-normalizes for safety).
 *   - We auto-save on chip add/remove with a 400ms debounce so users
 *     don't need a save button. Toasts surface success / error.
 */
function BrandHashtagsSection({
  brand,
  onToast,
}: {
  brand: Brand;
  onToast: (type: Toast['type'], message: string) => void;
}) {
  const MAX_TAGS = 10;
  const RECOMMENDED = 3;

  const [tags, setTags] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);

  // Debounced save — fired by a ref-stored timeout so rapid edits
  // collapse to one network call. We don't show a save button.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Compare baseline so we don't burn an API call on first hydration.
  const baselineRef = useRef<string>('');

  // Load on mount / when brand id changes
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    brandHashtagsApi
      .list(brand.id)
      .then((r) => {
        if (cancelled) return;
        const loaded = r.hashtags.map((h) => h.tag);
        setTags(loaded);
        baselineRef.current = loaded.join(',');
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        onToast('error', err instanceof ApiError ? err.message : 'Failed to load hashtags');
        setLoaded(true);
      });
    return () => { cancelled = true; };
    // Reload when brand changes
  }, [brand.id, onToast]);

  // Schedule debounced save whenever tags change after initial load
  useEffect(() => {
    if (!loaded) return;
    const current = tags.join(',');
    if (current === baselineRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await brandHashtagsApi.replace(brand.id, tags);
        baselineRef.current = tags.join(',');
      } catch (err) {
        onToast('error', err instanceof ApiError ? err.message : 'Failed to save hashtags');
      }
    }, 400);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [tags, loaded, brand.id, onToast]);

  const normalize = (raw: string): string | null => {
    let t = raw.trim();
    if (t.startsWith('#')) t = t.slice(1);
    t = t.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    if (!t) return null;
    return t.slice(0, 100);
  };

  const commitDraft = () => {
    const pieces = draft.split(/[,\s]+/).map(normalize).filter((t): t is string => !!t);
    if (pieces.length === 0) { setDraft(''); return; }
    setTags((prev) => {
      const next = [...prev];
      for (const t of pieces) {
        if (next.length >= MAX_TAGS) break;
        if (!next.includes(t)) next.push(t);
      }
      return next;
    });
    setDraft('');
  };

  const removeAt = (idx: number) => {
    setTags((prev) => prev.filter((_, i) => i !== idx));
  };

  const atCap = tags.length >= MAX_TAGS;

  return (
    <div className="mt-6 bg-white/40 border border-white/60 rounded-lg px-5 py-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-xs font-medium uppercase tracking-wider text-ink-subtle">
          Brand hashtags
        </h3>
        <span className="text-2xs text-ink-subtle">
          {tags.length}/{MAX_TAGS} <span className="text-ink-subtle">· recommended {RECOMMENDED}</span>
        </span>
      </div>
      <p className="text-xs text-ink-muted mb-3">
        Surfaced as quick-insert chips in the composer toolbar when this brand is active.
        Keep it short — 3 high-quality tags outperform 10 generic ones.
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((t, i) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-accent-subtle text-accent border border-accent/15"
          >
            #{t}
            <button
              onClick={() => removeAt(i)}
              className="p-0.5 rounded-full hover:bg-accent/20"
              aria-label={`Remove #${t}`}
            >
              <X size={10} />
            </button>
          </span>
        ))}

        {!atCap && (
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                commitDraft();
              } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
                setTags((prev) => prev.slice(0, -1));
              }
            }}
            onBlur={commitDraft}
            placeholder={tags.length === 0 ? 'Type a tag and press Enter…' : '+ add hashtag'}
            className="flex-1 min-w-[140px] px-2 py-1 text-xs bg-white/60 border border-dashed border-line rounded-full focus:outline-none focus:border-accent focus:bg-white placeholder:text-ink-subtle"
          />
        )}
      </div>

      {atCap && (
        <p className="text-2xs text-warning mt-2 flex items-center gap-1">
          <AlertCircle size={10} />
          Cap reached ({MAX_TAGS}). Remove a tag to add another.
        </p>
      )}
    </div>
  );
}
