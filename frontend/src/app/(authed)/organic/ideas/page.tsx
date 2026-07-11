'use client';

/**
 * Organic / Ideas — Notion-style brain-dump space (Patch 4.37.1).
 *
 * Layout:
 *   - Folder row at the top: "All" pill + each folder pill + "+ New folder".
 *     Click a folder to filter the grid. Click "All" to clear.
 *   - Idea grid: "Add new idea" card first, then existing ideas.
 *
 * Brand-scoped. Switching the active brand re-loads both folders and
 * ideas for that brand. Each idea/folder belongs to exactly one brand;
 * when "All brands" is selected, the page asks the user to pick a
 * specific brand (since ideas need a brand context to be created).
 *
 * Each idea card supports:
 *   - Click → open editor modal
 *   - Hover → kebab menu (Move to folder, Turn into post, Delete)
 *
 * "Turn into post" passes the idea body + media to the ComposerModal
 * via the ideaSeed prop. On successful save (draft/publish/schedule),
 * the composer deletes the idea automatically.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus,
  Trash2,
  FolderIcon,
  MoreVertical,
  Send,
  Link as LinkIcon,
  PlayCircle,
  Pencil,
  FolderInput,
  Lightbulb,
} from 'lucide-react';
import { VideoPlayer } from '@/components/studio/VideoPlayer';
import {
  organicIdeas,
  organicIdeaFolders,
  uploads,
  ApiError,
  type OrganicIdea,
  type OrganicIdeaFolder,
  type Upload,
} from '@/lib/api';
import { PageHeader, PAGE_TINTS } from '@/components/PageHeader';
import {
  getActiveScope,
  getActiveBrandIds,
  getActiveAccountIds,
  VASS_ACTIVE_SCOPE_EVENT,
  type ActiveScope,
} from '@/components/BrandSelector';
import { ComposerModal, type ComposerIdeaSeed } from '@/components/studio/ComposerModal';
import { IdeaEditorModal } from '@/components/studio/IdeaEditorModal';
import { FolderEditorModal } from '@/components/studio/FolderEditorModal';

/** Sentinel for the folder filter "show only unfiled ideas". */
const UNFILED = '__unfiled__';

export default function IdeasPage() {
  // ─── State ─────────────────────────────────────────────────────────
  // Patch 4.37.5: ideas page now follows the multi-scope. When scope
  // is 'all', we show every idea in the workspace. When scope has
  // items, we send the implied brandIds and accountIds to the server
  // — the server unions them and returns the matching set.
  const [scope, setScope] = useState<ActiveScope>(() => getActiveScope());
  const [ideas, setIdeas] = useState<OrganicIdea[]>([]);
  const [folders, setFolders] = useState<OrganicIdeaFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [folderFilter, setFolderFilter] = useState<string>('all');

  // Editor modals
  const [ideaEditorOpen, setIdeaEditorOpen] = useState(false);
  const [editingIdea, setEditingIdea] = useState<OrganicIdea | null>(null);
  const [folderEditorOpen, setFolderEditorOpen] = useState(false);
  const [editingFolder, setEditingFolder] = useState<OrganicIdeaFolder | null>(null);

  // Composer (for "Turn into post")
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerSeed, setComposerSeed] = useState<ComposerIdeaSeed | null>(null);

  // Per-idea card menu
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  // ─── Scope sync ──────────────────────────────────────────────────
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && typeof detail === 'object' && 'type' in detail) {
        setScope(detail as ActiveScope);
        // Scope change → reset folder filter (folders are brand-scoped
        // and a different brand has a different folder list).
        setFolderFilter('all');
      }
    };
    window.addEventListener(VASS_ACTIVE_SCOPE_EVENT, onChange);
    return () => window.removeEventListener(VASS_ACTIVE_SCOPE_EVENT, onChange);
  }, []);

  // ─── Load folders + ideas ─────────────────────────────────────────
  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const brandIds = getActiveBrandIds();
      const accountIds = getActiveAccountIds();
      const folderArg = folderFilter === 'all' ? null : folderFilter;

      // Folders are brand-scoped. When the scope has brand items, show
      // those brands' folders. When the scope is profile-only or 'all',
      // we still want some folder set so the user can move ideas into
      // them — fetch all folders the user owns in that case.
      const folderQuery = (brandIds && brandIds.length === 1) ? brandIds[0] : null;
      const [foldersRes, ideasRes] = await Promise.all([
        organicIdeaFolders.list(folderQuery),
        organicIdeas.list({
          brandIds: brandIds ?? undefined,
          accountIds: accountIds ?? undefined,
          folderId: folderArg,
        }),
      ]);
      setFolders(foldersRes.folders);
      setIdeas(ideasRes.ideas);
    } catch (err) {
      console.error('[ideas] load failed:', err);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, folderFilter]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Close kebab on outside click
  useEffect(() => {
    if (!openMenuId) return;
    const onDoc = () => setOpenMenuId(null);
    const t = setTimeout(() => window.addEventListener('click', onDoc), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('click', onDoc);
    };
  }, [openMenuId]);

  // ─── Idea CRUD handlers ───────────────────────────────────────────
  const openNewIdea = () => {
    setEditingIdea(null);
    setIdeaEditorOpen(true);
  };
  const openEditIdea = (idea: OrganicIdea) => {
    setEditingIdea(idea);
    setIdeaEditorOpen(true);
  };
  const handleIdeaSaved = (idea: OrganicIdea) => {
    setIdeas((curr) => {
      const existing = curr.findIndex((x) => x.id === idea.id);
      if (existing >= 0) {
        const out = [...curr];
        out[existing] = idea;
        return out.sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
      }
      return [idea, ...curr];
    });
  };
  const handleIdeaDeleted = (id: string) => {
    setIdeas((curr) => curr.filter((x) => x.id !== id));
  };
  const handleDirectDelete = async (id: string) => {
    if (!confirm('Delete this idea?')) return;
    try {
      await organicIdeas.delete(id);
      setIdeas((curr) => curr.filter((x) => x.id !== id));
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to delete');
    }
  };
  const handleMoveToFolder = async (idea: OrganicIdea, folderId: string | null) => {
    try {
      const r = await organicIdeas.update(idea.id, { folderId });
      handleIdeaSaved(r.idea);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to move');
    }
  };

  // ─── Turn into post ───────────────────────────────────────────────
  const handleTurnIntoPost = async (idea: OrganicIdea) => {
    // Build the seed — fetch the full upload object if there's media,
    // since the composer needs the same Upload shape its uploader
    // returns.
    let upload: Upload | null = null;
    if (idea.uploadId) {
      try {
        const r = await uploads.get(idea.uploadId);
        upload = r.upload;
      } catch {
        // If upload was deleted somehow, just drop it — better than failing
        upload = null;
      }
    }
    setComposerSeed({
      ideaId: idea.id,
      title: idea.title,
      body: idea.body,
      upload,
      mediaKind: upload ? idea.mediaKind : null,
    });
    setComposerOpen(true);
  };
  const closeComposer = () => {
    setComposerOpen(false);
    setComposerSeed(null);
  };

  // ─── Folder CRUD ──────────────────────────────────────────────────
  const openNewFolder = () => {
    setEditingFolder(null);
    setFolderEditorOpen(true);
  };
  const openEditFolder = (f: OrganicIdeaFolder) => {
    setEditingFolder(f);
    setFolderEditorOpen(true);
  };
  const handleFolderSaved = (f: OrganicIdeaFolder) => {
    setFolders((curr) => {
      const existing = curr.findIndex((x) => x.id === f.id);
      if (existing >= 0) {
        const out = [...curr];
        out[existing] = f;
        return out;
      }
      return [...curr, f];
    });
  };
  const handleFolderDeleted = (id: string) => {
    setFolders((curr) => curr.filter((x) => x.id !== id));
    // If the deleted folder was the current filter, reset.
    if (folderFilter === id) setFolderFilter('all');
    // Any ideas pointing at it become unfiled; refresh.
    loadAll();
  };

  // Patch 4.37.5: Ideas page no longer requires a single brand to be
  // selected. It always renders. When the scope is 'all', the page
  // shows every idea in the workspace; when narrowed, it shows the
  // matching subset.

  // Helpers — pick the right brandId/accountId for new ideas + folders
  const newIdeaBrandId = (() => {
    if (scope.type === 'all') return null;
    const firstBrand = scope.items.find((x) => x.type === 'brand');
    return firstBrand ? firstBrand.id : null;
  })();
  const newIdeaAccountId = (() => {
    if (scope.type === 'all') return null;
    if (scope.items.some((x) => x.type === 'brand')) return null;
    const firstProfile = scope.items.find((x) => x.type === 'profile');
    return firstProfile ? firstProfile.id : null;
  })();
  // A folder needs a brand. Allowed when EXACTLY one brand is in
  // scope. Otherwise the folder button is disabled with a tooltip.
  const folderBrandId = (() => {
    if (scope.type === 'all') return null;
    const brandsInScope = scope.items.filter((x) => x.type === 'brand');
    if (brandsInScope.length === 1) return brandsInScope[0].id;
    return null;
  })();

  return (
    <div>
      <PageHeading onNew={openNewIdea} disabled={false} />

      {/* Folder row */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <FolderChip
          label="All"
          active={folderFilter === 'all'}
          onClick={() => setFolderFilter('all')}
          count={null}
        />
        {folders.map((f) => (
          <FolderChip
            key={f.id}
            label={`${f.emoji ? `${f.emoji} ` : ''}${f.name}`}
            color={f.color}
            active={folderFilter === f.id}
            onClick={() => setFolderFilter(f.id)}
            count={f.ideaCount}
            onEdit={() => openEditFolder(f)}
          />
        ))}
        <FolderChip
          label="Unfiled"
          active={folderFilter === UNFILED}
          onClick={() => setFolderFilter(UNFILED)}
          count={null}
        />
        <button
          onClick={openNewFolder}
          disabled={!folderBrandId}
          title={folderBrandId ? undefined : 'Pick exactly one brand in the top selector to create a folder.'}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border border-dashed border-line text-sm text-ink-muted hover:bg-surface-hover hover:text-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus size={13} />
          New folder
        </button>
      </div>

      {/* Idea grid */}
      {loading ? (
        <div className="px-6 py-16 text-center text-sm text-ink-subtle">Loading…</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          <AddIdeaCard onClick={openNewIdea} />
          {ideas.map((idea) => (
            <IdeaCard
              key={idea.id}
              idea={idea}
              folders={folders}
              menuOpen={openMenuId === idea.id}
              onMenuOpen={(open) => setOpenMenuId(open ? idea.id : null)}
              onClickCard={() => openEditIdea(idea)}
              onTurnIntoPost={() => handleTurnIntoPost(idea)}
              onMoveToFolder={(fid) => handleMoveToFolder(idea, fid)}
              onDelete={() => handleDirectDelete(idea.id)}
            />
          ))}
        </div>
      )}

      <IdeaEditorModal
        open={ideaEditorOpen}
        onClose={() => { setIdeaEditorOpen(false); setEditingIdea(null); }}
        brandId={newIdeaBrandId}
        accountId={newIdeaAccountId}
        idea={editingIdea}
        folders={folders}
        defaultFolderId={
          folderFilter !== 'all' && folderFilter !== UNFILED ? folderFilter : null
        }
        onSaved={handleIdeaSaved}
        onDeleted={handleIdeaDeleted}
        onTurnIntoPost={(savedIdea) => {
          setIdeaEditorOpen(false);
          setEditingIdea(null);
          handleTurnIntoPost(savedIdea);
        }}
      />
      <FolderEditorModal
        open={folderEditorOpen}
        onClose={() => { setFolderEditorOpen(false); setEditingFolder(null); }}
        brandId={folderBrandId ?? ''}
        folder={editingFolder}
        onSaved={handleFolderSaved}
        onDeleted={handleFolderDeleted}
      />
      <ComposerModal
        open={composerOpen}
        onClose={closeComposer}
        ideaSeed={composerSeed}
        onPublished={() => {
          // Reload ideas — the composer just deleted ours from the server
          // if a save happened.
          loadAll();
        }}
      />
    </div>
  );
}

// ─── Heading ─────────────────────────────────────────────────────────

function PageHeading({ onNew, disabled }: { onNew: () => void; disabled: boolean }) {
  return (
    <PageHeader
      icon={Lightbulb}
      title="Ideas"
      description="Brain-dump space for content. Brand-scoped. Turn an idea into a post when it's ready."
      tint={PAGE_TINTS.ideas}
      actions={
        <button onClick={onNew} disabled={disabled} className="btn-primary">
          <Plus size={14} />
          New idea
        </button>
      }
    />
  );
}

// ─── Folder chip ─────────────────────────────────────────────────────

function FolderChip({
  label,
  active,
  onClick,
  color,
  count,
  onEdit,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  color?: string | null;
  count?: number | null;
  onEdit?: () => void;
}) {
  return (
    <div className="relative group inline-flex">
      <button
        onClick={onClick}
        className={[
          'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors border',
          active
            ? 'bg-ink text-white border-ink'
            : 'bg-white text-ink border-line hover:bg-surface-hover',
        ].join(' ')}
      >
        {color && (
          <span
            className="block w-2 h-2 rounded-full"
            style={{ backgroundColor: color }}
          />
        )}
        <span>{label}</span>
        {typeof count === 'number' && (
          <span className={[
            'text-2xs px-1.5 rounded-full',
            active ? 'bg-white/20 text-white' : 'bg-surface-alt text-ink-subtle',
          ].join(' ')}>
            {count}
          </span>
        )}
      </button>
      {onEdit && (
        <button
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-white border border-line text-ink-subtle hover:text-ink opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center shadow-subtle"
          title="Edit folder"
        >
          <Pencil size={10} />
        </button>
      )}
    </div>
  );
}

// ─── Cards ───────────────────────────────────────────────────────────

function AddIdeaCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group flex flex-col items-center justify-center gap-3 bg-white/40 hover:bg-white border border-dashed border-line hover:border-ink-subtle rounded-lg px-4 py-8 h-full min-h-[320px] text-ink-muted hover:text-ink transition-colors"
    >
      <div className="w-12 h-12 rounded-full bg-surface-alt group-hover:bg-accent-subtle flex items-center justify-center transition-colors">
        <Plus size={22} />
      </div>
      <span className="text-sm font-medium">Add new idea</span>
    </button>
  );
}

function IdeaCard({
  idea,
  folders,
  menuOpen,
  onMenuOpen,
  onClickCard,
  onTurnIntoPost,
  onMoveToFolder,
  onDelete,
}: {
  idea: OrganicIdea;
  folders: OrganicIdeaFolder[];
  menuOpen: boolean;
  onMenuOpen: (open: boolean) => void;
  onClickCard: () => void;
  onTurnIntoPost: () => void;
  onMoveToFolder: (folderId: string | null) => void;
  onDelete: () => void;
}) {
  const mediaUrl = idea.uploadId ? uploads.fileUrl(idea.uploadId) : null;
  const currentFolder = useMemo(
    () => folders.find((f) => f.id === idea.folderId) ?? null,
    [folders, idea.folderId]
  );
  const [moveOpen, setMoveOpen] = useState(false);

  return (
    <div
      className="group relative bg-white border border-line rounded-lg shadow-subtle hover:shadow-card transition-shadow cursor-pointer overflow-hidden flex flex-col"
      onClick={onClickCard}
    >
      {/* Media — always a fixed 4:5 area (placeholder when empty) so every
          idea card is the same size, like Drafts. */}
      <div className="aspect-[4/5] bg-surface-alt relative flex items-center justify-center shrink-0">
        {mediaUrl ? (
          idea.mediaKind === 'video' ? (
            <VideoPlayer src={mediaUrl} thumbnailOnly />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={mediaUrl} alt="" className="w-full h-full object-cover" />
          )
        ) : (
          <div className="flex flex-col items-center text-ink-subtle">
            <Lightbulb size={28} />
            <span className="text-2xs mt-1">No media</span>
          </div>
        )}
      </div>

      <div className="h-[132px] px-4 py-3 flex flex-col gap-1.5 shrink-0">
        {idea.title && (
          <h3 className="font-semibold text-sm text-ink line-clamp-1">{idea.title}</h3>
        )}
        <p className="text-xs text-ink-muted line-clamp-3 whitespace-pre-wrap flex-1">
          {idea.body.trim() || <span className="italic text-ink-subtle">(empty)</span>}
        </p>
        {idea.linkUrl && (
          <a
            href={idea.linkUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 text-2xs text-accent hover:underline truncate"
          >
            <LinkIcon size={10} />
            {idea.linkUrl}
          </a>
        )}
        <div className="flex items-center justify-between pt-1.5 text-2xs text-ink-subtle">
          <span>
            {currentFolder ? (
              <span className="inline-flex items-center gap-1">
                <FolderIcon size={10} />
                {currentFolder.emoji ? `${currentFolder.emoji} ` : ''}{currentFolder.name}
              </span>
            ) : (
              'Unfiled'
            )}
          </span>
          <span>{new Date(idea.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
        </div>
      </div>

      {/* Kebab menu trigger */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onMenuOpen(!menuOpen);
          setMoveOpen(false);
        }}
        className="absolute top-2 right-2 p-1.5 rounded bg-white/90 backdrop-blur text-ink-subtle hover:text-ink hover:bg-white opacity-0 group-hover:opacity-100 transition-opacity shadow-subtle"
        title="More"
      >
        <MoreVertical size={12} />
      </button>

      {/* Menu panel */}
      {menuOpen && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute top-10 right-2 bg-white border border-line rounded-lg shadow-card py-1 z-20 min-w-[180px]"
        >
          <button
            onClick={(e) => { e.stopPropagation(); onMenuOpen(false); onTurnIntoPost(); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-ink hover:bg-surface-hover text-left"
          >
            <Send size={13} /> Turn into post
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setMoveOpen((v) => !v); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-ink hover:bg-surface-hover text-left"
          >
            <FolderInput size={13} /> Move to folder…
          </button>
          {moveOpen && (
            <div className="border-t border-line/40 mt-1 pt-1 max-h-48 overflow-y-auto">
              <button
                onClick={(e) => { e.stopPropagation(); onMoveToFolder(null); onMenuOpen(false); setMoveOpen(false); }}
                className={[
                  'w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-surface-hover text-left',
                  idea.folderId === null ? 'text-accent font-semibold' : 'text-ink-muted',
                ].join(' ')}
              >
                <FolderIcon size={11} /> Unfiled
              </button>
              {folders.map((f) => (
                <button
                  key={f.id}
                  onClick={(e) => { e.stopPropagation(); onMoveToFolder(f.id); onMenuOpen(false); setMoveOpen(false); }}
                  className={[
                    'w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-surface-hover text-left',
                    idea.folderId === f.id ? 'text-accent font-semibold' : 'text-ink-muted',
                  ].join(' ')}
                >
                  {f.color && (
                    <span className="block w-2 h-2 rounded-full" style={{ backgroundColor: f.color }} />
                  )}
                  {f.emoji ? `${f.emoji} ` : ''}{f.name}
                </button>
              ))}
            </div>
          )}
          <div className="border-t border-line/40 mt-1 pt-1">
            <button
              onClick={(e) => { e.stopPropagation(); onMenuOpen(false); onDelete(); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-danger hover:bg-danger/10 text-left"
            >
              <Trash2 size={13} /> Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
