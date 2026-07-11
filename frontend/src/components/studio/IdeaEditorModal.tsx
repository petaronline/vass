'use client';

/**
 * IdeaEditorModal — lightweight composer (Patch 4.37.1).
 *
 * Used by the Ideas page. Smaller than the full post composer:
 *   - Optional title
 *   - Body (textarea)
 *   - Single media (image OR video) via the standard /uploads endpoint
 *   - Optional link URL (plain text — no OG preview)
 *   - Folder selector (move to a different folder, or "unfiled")
 *
 * Save behavior:
 *   - When `idea` is null → POST /organic/ideas
 *   - When `idea` is set → PATCH /organic/ideas/:id
 *
 * Close-without-saving discards unsaved changes; no warning prompt
 * (matches the rest of Vass's lightweight modal UX).
 *
 * Click outside the panel and ESC also close.
 */

import { useEffect, useRef, useState } from 'react';
import {
  X,
  Image as ImageIcon,
  Link as LinkIcon,
  Folder as FolderIcon,
  Trash2,
  RefreshCw,
  Check,
  PlayCircle,
  Save,
  Send,
} from 'lucide-react';
import { VideoPlayer } from './VideoPlayer';
import {
  organicIdeas,
  uploads,
  ApiError,
  type OrganicIdea,
  type OrganicIdeaFolder,
} from '@/lib/api';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Brand context for a new idea. Can be null when the user is
   *  creating from a profile-only scope (ungrouped account); in that
   *  case `accountId` must be set. */
  brandId: string | null;
  /** Profile context for a new idea. When set, the idea is tied to
   *  this profile. The server auto-derives brandId from the profile if
   *  not provided. */
  accountId?: string | null;
  /** Existing idea to edit, or null for a new one. */
  idea: OrganicIdea | null;
  /** Folders available to assign to. */
  folders: OrganicIdeaFolder[];
  /** Folder pre-selection for a new idea (e.g. the user is viewing a
   *  folder when they click "Add new idea"). Ignored when editing. */
  defaultFolderId?: string | null;
  onSaved: (idea: OrganicIdea) => void;
  onDeleted?: (ideaId: string) => void;
  /** Patch 4.37.1.1: when provided AND we're editing an existing idea,
   *  show a "Turn into post" button alongside Save. The page handles
   *  closing this modal and opening the composer with the seed. */
  onTurnIntoPost?: (idea: OrganicIdea) => void;
}

export function IdeaEditorModal({
  open,
  onClose,
  brandId,
  accountId,
  idea,
  folders,
  defaultFolderId,
  onSaved,
  onDeleted,
  onTurnIntoPost,
}: Props) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [mediaKind, setMediaKind] = useState<'image' | 'video' | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Initialize state when the modal opens with new content.
  useEffect(() => {
    if (!open) return;
    setError(null);
    if (idea) {
      setTitle(idea.title ?? '');
      setBody(idea.body ?? '');
      setLinkUrl(idea.linkUrl ?? '');
      setFolderId(idea.folderId);
      setUploadId(idea.uploadId);
      setMediaKind(idea.mediaKind === 'document' ? null : idea.mediaKind);
      setMediaUrl(idea.uploadId ? uploads.fileUrl(idea.uploadId) : null);
    } else {
      setTitle('');
      setBody('');
      setLinkUrl('');
      setFolderId(defaultFolderId ?? null);
      setUploadId(null);
      setMediaKind(null);
      setMediaUrl(null);
    }
  }, [open, idea, defaultFolderId]);

  // ESC closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving && !uploading) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, saving, uploading, onClose]);

  // Click outside the panel closes
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (saving || uploading) return;
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Defer one tick so the click that opened the modal doesn't immediately close it.
    const t = setTimeout(() => window.addEventListener('mousedown', onDoc), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onDoc);
    };
  }, [open, saving, uploading, onClose]);

  // Lock body scroll
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  const pickFile = () => fileRef.current?.click();

  const handleFile = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const r = await uploads.upload(file);
      setUploadId(r.upload.id);
      setMediaKind(r.upload.kind === 'document' ? null : r.upload.kind);
      setMediaUrl(uploads.fileUrl(r.upload.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const clearMedia = () => {
    setUploadId(null);
    setMediaKind(null);
    setMediaUrl(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      if (idea) {
        // Update — explicitly send each field so the server can clear
        // any that the user blanked out.
        const r = await organicIdeas.update(idea.id, {
          title: title.trim() ? title.trim() : null,
          body,
          uploadId,
          mediaKind,
          linkUrl: linkUrl.trim() ? linkUrl.trim() : null,
          folderId: folderId ?? null,
        });
        onSaved(r.idea);
      } else {
        const r = await organicIdeas.create({
          brandId: brandId ?? null,
          accountId: accountId ?? null,
          folderId: folderId ?? null,
          title: title.trim() ? title.trim() : null,
          body,
          uploadId,
          mediaKind,
          linkUrl: linkUrl.trim() ? linkUrl.trim() : null,
        });
        onSaved(r.idea);
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!idea) return;
    if (!confirm('Delete this idea? This can\u2019t be undone.')) return;
    setSaving(true);
    try {
      await organicIdeas.delete(idea.id);
      if (onDeleted) onDeleted(idea.id);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete');
      setSaving(false);
    }
  };

  // Save current edits, then hand off to the composer. We always save
  // first so the user doesn't lose unsaved tweaks (the composer will
  // delete the idea later if the post actually ships).
  const handleTurnIntoPostClick = async () => {
    if (!idea || !onTurnIntoPost) return;
    setSaving(true);
    setError(null);
    try {
      const r = await organicIdeas.update(idea.id, {
        title: title.trim() ? title.trim() : null,
        body,
        uploadId,
        mediaKind,
        linkUrl: linkUrl.trim() ? linkUrl.trim() : null,
        folderId: folderId ?? null,
      });
      onSaved(r.idea);
      // Hand the freshly-saved version to the page; it'll close us
      // and open the composer.
      onTurnIntoPost(r.idea);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save');
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm px-4">
      <div
        ref={panelRef}
        className="bg-white border border-line rounded-lg shadow-card w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-line/60">
          <h2 className="h-sub text-ink">
            {idea ? 'Edit idea' : 'New idea'}
          </h2>
          <button
            onClick={onClose}
            disabled={saving || uploading}
            className="p-1.5 rounded text-ink-muted hover:text-ink hover:bg-surface-hover transition-colors disabled:opacity-40"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Title */}
          <div>
            <label className="block text-xs font-semibold text-ink-muted mb-1">
              Title (optional)
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="A short heading…"
              maxLength={200}
              className="w-full px-3 py-2 rounded-lg border border-line bg-white text-sm text-ink placeholder:text-ink-subtle focus:outline-none focus:border-accent"
            />
          </div>

          {/* Body */}
          <div>
            <label className="block text-xs font-semibold text-ink-muted mb-1">
              Notes
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Brain-dump whatever — copy, hooks, references, things to test…"
              rows={6}
              maxLength={8000}
              className="w-full px-3 py-2 rounded-lg border border-line bg-white text-sm text-ink placeholder:text-ink-subtle focus:outline-none focus:border-accent resize-y"
            />
          </div>

          {/* Media */}
          <div>
            <label className="block text-xs font-semibold text-ink-muted mb-1">
              Image or video (optional)
            </label>
            {mediaUrl ? (
              <div className="relative group bg-surface-alt rounded-lg overflow-hidden border border-line aspect-video">
                {mediaKind === 'video' ? (
                  <VideoPlayer src={mediaUrl} />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={mediaUrl} alt="" className="w-full h-full object-cover" />
                )}
                <button
                  onClick={clearMedia}
                  className="absolute top-2 right-2 p-1.5 rounded bg-white/90 text-ink-subtle hover:text-danger hover:bg-white shadow-subtle"
                  title="Remove media"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ) : (
              <button
                onClick={pickFile}
                disabled={uploading}
                className="w-full px-3 py-6 rounded-lg border border-dashed border-line bg-surface-alt/40 text-sm text-ink-muted hover:bg-surface-alt hover:text-ink transition-colors disabled:opacity-40"
              >
                {uploading ? (
                  <span className="inline-flex items-center gap-2">
                    <RefreshCw size={14} className="animate-spin" />
                    Uploading…
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-2">
                    <ImageIcon size={14} />
                    Click to attach an image or video
                  </span>
                )}
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*,video/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
          </div>

          {/* Link */}
          <div>
            <label className="block text-xs font-semibold text-ink-muted mb-1">
              Reference link (optional)
            </label>
            <div className="relative">
              <LinkIcon size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle pointer-events-none" />
              <input
                type="text"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                placeholder="https://example.com"
                maxLength={2000}
                className="w-full pl-8 pr-3 py-2 rounded-lg border border-line bg-white text-sm text-ink placeholder:text-ink-subtle focus:outline-none focus:border-accent"
              />
            </div>
          </div>

          {/* Folder */}
          <div>
            <label className="block text-xs font-semibold text-ink-muted mb-1">
              Folder
            </label>
            <div className="relative">
              <FolderIcon size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle pointer-events-none" />
              <select
                value={folderId ?? ''}
                onChange={(e) => setFolderId(e.target.value || null)}
                className="w-full pl-8 pr-8 py-2 rounded-lg border border-line bg-white text-sm text-ink focus:outline-none focus:border-accent appearance-none"
              >
                <option value="">Unfiled</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.emoji ? `${f.emoji} ` : ''}{f.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg bg-danger/10 text-danger text-xs">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-line/60">
          <div>
            {idea && (
              <button
                onClick={handleDelete}
                disabled={saving || uploading}
                className="btn-danger"
              >
                <Trash2 size={13} />
                Delete
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={saving || uploading}
              className="btn-ghost"
            >
              Cancel
            </button>
            {/* Patch 4.37.1.1: shortcut to compose from this idea. Only
                shown when editing an existing idea AND the parent page
                provided the callback. Saves first so unsaved tweaks
                aren't lost. */}
            {idea && onTurnIntoPost && (
              <button
                onClick={handleTurnIntoPostClick}
                disabled={saving || uploading}
                className="btn-secondary"
              >
                <Send size={13} />
                Turn into post
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={saving || uploading}
              className="btn-primary"
            >
              {saving ? (
                <>
                  <RefreshCw size={14} className="animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  {idea ? <Save size={14} /> : <Check size={14} />}
                  {idea ? 'Save changes' : 'Create idea'}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
