'use client';

/**
 * Organic / Drafts — brand-scoped list of saved drafts (Patch 4.37.0).
 *
 * A draft is an organic_posts row with status='draft'. The composer
 * saves them via POST /organic/posts {asDraft: true} and updates them
 * via PATCH /organic/posts/:id {asDraft: true}.
 *
 * Click a draft → opens the composer in edit mode. When the composer's
 * publish/schedule path completes, the draft is deleted automatically.
 *
 * Patch 4.37.0.1 fixes:
 *  - Brand-event payload is the brand id as a STRING (not {brandId})
 *  - "New post" button matches Pipeline's full-pill style
 *  - AccountPicker added for cross-page consistency
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus,
  Trash2,
  FileText,
  Facebook,
  Instagram,
  AtSign,
  Music2,
  Linkedin,
  Image as ImageIcon,
  PlayCircle,
} from 'lucide-react';
import { VideoPlayer } from '@/components/studio/VideoPlayer';
import {
  organicDrafts,
  organicPosts,
  organicAccounts,
  uploads,
  ApiError,
  OrganicDraft,
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
import { ComposerModal } from '@/components/studio/ComposerModal';
import { AccountPicker } from '@/components/studio/AccountPicker';
import { PageHeader, PAGE_TINTS } from '@/components/PageHeader';

const PLATFORM_META: Record<OrganicPlatform, { Icon: typeof Facebook; color: string }> = {
  facebook_page: { Icon: Facebook,  color: '#1877F2' },
  instagram:     { Icon: Instagram, color: '#E1306C' },
  threads:       { Icon: AtSign,    color: '#000000' },
  tiktok:        { Icon: Music2,   color: '#000000' },
  linkedin:      { Icon: Linkedin, color: '#0A66C2' },
};

export default function DraftsPage() {
  const [drafts, setDrafts] = useState<OrganicDraft[]>([]);
  const [accounts, setAccounts] = useState<OrganicAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<ActiveScope>(() => getActiveScope());
  const [activeBrandId, setActiveBrandId] = useState<string>('all');
  const [accountFilter, setAccountFilter] = useState<Set<string> | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);

  // ─── Brand-selector wiring (Patch 4.37.5: multi-scope) ───
  useEffect(() => {
    setActiveBrandId(getActiveBrandId());
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && typeof detail === 'object' && 'type' in detail) {
        setScope(detail as ActiveScope);
        setActiveBrandId(getActiveBrandId());
        setAccountFilter(null);
      }
    };
    window.addEventListener(VASS_ACTIVE_SCOPE_EVENT, onChange);
    return () => window.removeEventListener(VASS_ACTIVE_SCOPE_EVENT, onChange);
  }, []);

  // ─── Accounts (for the picker, restricted by active scope) ───
  useEffect(() => {
    let cancelled = false;
    organicAccounts
      .list()
      .then((r) => { if (!cancelled) setAccounts(r.accounts); })
      .catch((err) => console.error('[drafts] failed to load accounts:', err));
    return () => { cancelled = true; };
  }, []);

  const brandAccounts = useMemo(() => {
    const ids = getActiveAccountIds(accounts);
    if (ids === null) return accounts;
    const set = new Set(ids);
    return accounts.filter((a) => set.has(a.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, scope]);

  // ─── Load drafts on every relevant change ───
  const loadDrafts = useCallback(async () => {
    setLoading(true);
    try {
      // If the user has explicitly emptied the picker filter, return
      // zero — same semantics as Pipeline.
      if (accountFilter !== null && accountFilter.size === 0) {
        setDrafts([]);
        return;
      }
      // Patch 4.37.5: derive account ids from the scope (brand items
      // expand to all profiles in that brand; profile items contribute
      // themselves). Intersect with the in-page account picker if the
      // user has narrowed further.
      const scopeIds = getActiveAccountIds(accounts);
      let ids: string[] | undefined = undefined;
      if (scopeIds !== null) {
        ids = accountFilter
          ? scopeIds.filter((id) => accountFilter.has(id))
          : scopeIds;
        if (ids.length === 0) {
          // Scope-filtered to nothing → don't query
          setDrafts([]);
          return;
        }
      } else if (accountFilter) {
        ids = Array.from(accountFilter);
      }
      const r = await organicDrafts.list(null, ids);
      setDrafts(r.drafts);
    } catch (err) {
      console.error('[drafts] load failed:', err);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, accountFilter, accounts]);

  useEffect(() => { loadDrafts(); }, [loadDrafts]);

  const openCompose = () => {
    setEditingDraftId(null);
    setComposerOpen(true);
  };
  const openDraft = (id: string) => {
    setEditingDraftId(id);
    setComposerOpen(true);
  };
  const closeComposer = () => {
    setComposerOpen(false);
    setEditingDraftId(null);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this draft? This can\u2019t be undone.')) return;
    try {
      await organicPosts.delete(id);
      setDrafts((curr) => curr.filter((d) => d.id !== id));
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to delete draft');
    }
  };

  return (
    <div>
      <PageHeader
        icon={FileText}
        title="Drafts"
        description="Saved posts you haven't published yet. Brand-scoped."
        tint={PAGE_TINTS.drafts}
        actions={
          <button onClick={openCompose} className="btn-primary">
            <Plus size={14} />
            New post
          </button>
        }
      />

      {/* Filter row — match Pipeline visually, just no post-type picker
          (drafts don't have multiple statuses). */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <AccountPicker
          accounts={brandAccounts}
          selected={accountFilter}
          onChange={setAccountFilter}
        />
      </div>

      {loading ? (
        <div className="px-6 py-16 text-center text-sm text-ink-subtle">Loading…</div>
      ) : drafts.length === 0 ? (
        <EmptyDrafts onCreate={openCompose} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {drafts.map((d) => (
            <DraftCard
              key={d.id}
              draft={d}
              onOpen={() => openDraft(d.id)}
              onDelete={() => handleDelete(d.id)}
            />
          ))}
        </div>
      )}

      <ComposerModal
        open={composerOpen}
        onClose={closeComposer}
        draftId={editingDraftId}
        onPublished={() => loadDrafts()}
      />
    </div>
  );
}

// ─── Empty state ─────────────────────────────────────────────────────

function EmptyDrafts({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="bg-white/72 backdrop-blur-card border border-white/60 rounded-lg shadow-glass px-8 py-16 text-center">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-surface-alt mb-3">
        <FileText size={20} className="text-ink-subtle" />
      </div>
      <h3 className="h-section text-ink mb-1">No drafts yet</h3>
      <p className="text-sm text-ink-muted mb-5 max-w-sm mx-auto">
        Start composing a post and save it as a draft to come back to it later.
      </p>
      <button
        onClick={onCreate}
        className="btn-primary"
      >
        <Plus size={14} />
        New post
      </button>
    </div>
  );
}

// ─── Draft card ──────────────────────────────────────────────────────

function DraftCard({
  draft,
  onOpen,
  onDelete,
}: {
  draft: OrganicDraft;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const mediaUrl = draft.mediaUploadId ? uploads.fileUrl(draft.mediaUploadId) : null;
  const updated = new Date(draft.updatedAt);
  const updatedLabel = isToday(updated)
    ? `Today at ${updated.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
    : updated.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div
      className="group relative bg-white border border-line rounded-lg shadow-subtle hover:shadow-card transition-shadow cursor-pointer overflow-hidden flex flex-col"
      onClick={onOpen}
    >
      {/* Media preview — fixed 4:5 so every card is the same size */}
      <div className="aspect-[4/5] bg-surface-alt relative flex items-center justify-center shrink-0">
        {mediaUrl ? (
          draft.mediaKind === 'video' ? (
            <VideoPlayer src={mediaUrl} thumbnailOnly />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={mediaUrl} alt="" className="w-full h-full object-cover" />
          )
        ) : (
          <div className="flex flex-col items-center text-ink-subtle">
            <ImageIcon size={28} />
            <span className="text-2xs mt-1">No media</span>
          </div>
        )}
      </div>

      {/* Body / meta — fixed height so cards stay uniform */}
      <div className="h-[88px] px-3 py-2.5 flex flex-col gap-1.5 shrink-0">
        <p className="text-xs text-ink line-clamp-2 flex-1">
          {draft.body.trim() || <span className="italic text-ink-subtle">(no text yet)</span>}
        </p>
        <div className="flex items-center justify-between pt-1.5">
          <div className="flex items-center gap-1.5">
            {draft.platforms.length > 0 ? (
              draft.platforms.slice(0, 3).map((p) => {
                const meta = PLATFORM_META[p];
                if (!meta) return null;
                const Icon = meta.Icon;
                return <Icon key={p} size={11} style={{ color: meta.color }} />;
              })
            ) : (
              <span className="text-2xs text-ink-subtle">no targets</span>
            )}
          </div>
          <span className="text-2xs text-ink-subtle">{updatedLabel}</span>
        </div>
      </div>

      {/* Hover-only delete */}
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="absolute top-2 right-2 p-1.5 rounded bg-white/90 backdrop-blur text-ink-subtle hover:text-danger hover:bg-white opacity-0 group-hover:opacity-100 transition-opacity shadow-subtle"
        title="Delete draft"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function isToday(d: Date): boolean {
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}
