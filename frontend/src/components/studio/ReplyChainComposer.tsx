'use client';

/**
 * ReplyChainComposer — stacked cards for Threads reply chains.
 *
 * Threads supports threads-of-threads ("reply chains"): post a head,
 * then reply to your own head with another post, then reply to that
 * reply, etc. Up to 5 posts total (head + 4 replies) in our scope.
 *
 * UI shape:
 *   - One card per reply, indented to suggest the chain
 *   - HighlightedTextarea per reply (URLs/hashtags/mentions blue)
 *   - 500 char counter per reply (Threads' per-post limit)
 *   - Up to N images attached per reply (carousel). Video per-reply
 *     deferred — the head post is the natural place for a Reel.
 *   - "Remove reply" button on each card
 *   - "+ Add reply" button below the stack when count < max
 *
 * Reply state shape: { body, mediaItems[] } — kept simple, no per-reply
 * topic tag / first comment / collaborators.
 *
 * This component only renders when the parent passes ≥1 Threads target;
 * the parent is responsible for the conditional mount.
 */

import { useRef } from 'react';
import { Plus, Trash2, ImagePlus, X, MessageCircle } from 'lucide-react';
import { ComposerSection } from './ComposerSection';
import { HighlightedTextarea } from './HighlightedTextarea';
import { uploads as uploadsApi, ApiError, Upload } from '@/lib/api';

interface ReplyMediaItem {
  upload: Upload;
  kind: 'image' | 'video' | 'document';
}

export interface ReplyDraft {
  body: string;
  mediaItems: ReplyMediaItem[];
}

interface Props {
  replies: ReplyDraft[];
  onChange: (next: ReplyDraft[]) => void;
  /** Max chain length excluding the head. Default 4 → 5 posts total. */
  maxReplies?: number;
  /** Char limit applied per reply. Default 500 (Threads). */
  charLimit?: number;
  /** Max images per reply (carousel). Default 10. */
  maxMediaPerReply?: number;
  /** Callback for upload errors so the parent can surface a toast. */
  onUploadError?: (message: string) => void;
  /** Optional pill rendered inline-left of the "Add reply" button.
   *  Used to mark this field as Threads-only. */
  badge?: React.ReactNode;
}

const MAX_REPLIES_DEFAULT = 4;
const CHAR_LIMIT_DEFAULT = 500;
const MAX_MEDIA_DEFAULT = 10;

export function ReplyChainComposer({
  replies,
  onChange,
  maxReplies = MAX_REPLIES_DEFAULT,
  charLimit = CHAR_LIMIT_DEFAULT,
  maxMediaPerReply = MAX_MEDIA_DEFAULT,
  onUploadError,
  badge,
}: Props) {
  const addReply = () => {
    if (replies.length >= maxReplies) return;
    onChange([...replies, { body: '', mediaItems: [] }]);
  };

  const updateReply = (idx: number, patch: Partial<ReplyDraft>) => {
    onChange(replies.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const removeReply = (idx: number) => {
    onChange(replies.filter((_, i) => i !== idx));
  };

  return (
    <ComposerSection
      icon={MessageCircle}
      label="Reply chain"
      counter={replies.length > 0 ? `${replies.length} / ${maxReplies}` : undefined}
    >
      <div className="space-y-3">
        {/* Stacked reply cards */}
        <div className="space-y-2">
          {replies.map((reply, idx) => (
            <ReplyCard
              key={idx}
              index={idx}
              value={reply}
              charLimit={charLimit}
              maxMedia={maxMediaPerReply}
              onChange={(patch) => updateReply(idx, patch)}
              onRemove={() => removeReply(idx)}
              onUploadError={onUploadError}
            />
          ))}
        </div>

        {/* Add reply button (with optional Threads-only pill inline-left) */}
        {replies.length < maxReplies && (
          <div className="flex items-center gap-2">
            {badge && <span className="shrink-0">{badge}</span>}
            <button
              type="button"
              onClick={addReply}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-dashed border-line text-xs text-ink-muted hover:text-ink hover:border-ink-subtle transition-colors"
            >
              <Plus size={12} />
              {replies.length === 0 ? 'Add reply' : 'Add another reply'}
            </button>
          </div>
        )}
      </div>
    </ComposerSection>
  );
}

// ─── Single reply card ──────────────────────────────────────────────────

interface ReplyCardProps {
  index: number;
  value: ReplyDraft;
  charLimit: number;
  maxMedia: number;
  onChange: (patch: Partial<ReplyDraft>) => void;
  onRemove: () => void;
  onUploadError?: (message: string) => void;
}

function ReplyCard({
  index,
  value,
  charLimit,
  maxMedia,
  onChange,
  onRemove,
  onUploadError,
}: ReplyCardProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const overLimit = value.body.length > charLimit;
  const canAddMore = value.mediaItems.length < maxMedia;

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const remaining = maxMedia - value.mediaItems.length;
    const filesToUpload = Array.from(files).slice(0, remaining);
    if (filesToUpload.length === 0) return;

    // Upload sequentially — keeps the UI responsive without overwhelming
    // the backend and matches the head composer's behavior.
    const newItems: ReplyMediaItem[] = [];
    for (const f of filesToUpload) {
      try {
        const r = await uploadsApi.upload(f);
        if (!r || !r.upload || !r.upload.id) {
          onUploadError?.('Upload returned an unexpected response.');
          continue;
        }
        // We support images-only in reply media for now. If someone
        // selects a video, reject with a clear message.
        const ct = r.upload.contentType ?? '';
        if (!ct.startsWith('image/')) {
          onUploadError?.(
            `Reply media must be an image (got ${ct || 'unknown type'}). Use the main post for videos.`
          );
          continue;
        }
        newItems.push({ upload: r.upload, kind: 'image' });
      } catch (e) {
        onUploadError?.(
          e instanceof ApiError
            ? `${e.message} (status ${e.status})`
            : e instanceof Error
              ? e.message
              : 'Upload failed'
        );
      }
    }
    if (newItems.length > 0) {
      onChange({ mediaItems: [...value.mediaItems, ...newItems] });
    }
    // Reset input so the user can pick the same file again on retry.
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removeMediaAt(mediaIdx: number) {
    onChange({
      mediaItems: value.mediaItems.filter((_, i) => i !== mediaIdx),
    });
  }

  return (
    <div className="relative pl-4">
      {/* Indent indicator line (subtle, hints at the reply relationship) */}
      <div className="absolute left-0 top-3 bottom-3 w-px bg-line" />

      <div className="bg-white border border-line rounded-lg p-3 space-y-2 shadow-card/40">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wider text-ink-subtle">
            Reply {index + 1}
          </span>
          <button
            type="button"
            onClick={onRemove}
            className="p-1 rounded-lg text-ink-subtle hover:text-danger hover:bg-danger/5"
            title="Remove this reply"
          >
            <Trash2 size={12} />
          </button>
        </div>

        <HighlightedTextarea
          value={value.body}
          onChange={(v) => onChange({ body: v })}
          placeholder={`Reply ${index + 1}…`}
        />

        {/* Media row */}
        {value.mediaItems.length > 0 && (
          <div className="flex gap-1.5 flex-wrap">
            {value.mediaItems.map((m, mIdx) => (
              <div key={mIdx} className="relative group">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={uploadsApi.fileUrl(m.upload.id)}
                  alt={`Reply ${index + 1} image ${mIdx + 1}`}
                  className="w-14 h-14 object-cover rounded-lg border border-line bg-black"
                />
                <button
                  type="button"
                  onClick={() => removeMediaAt(mIdx)}
                  className="absolute -top-1 -right-1 p-0.5 rounded-full bg-ink text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Remove image"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Footer: attach button + counter */}
        <div className="flex items-center justify-between pt-1">
          <div>
            {canAddMore && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
                  multiple
                  onChange={(e) => handleFiles(e.target.files)}
                  className="hidden"
                  id={`reply-${index}-file`}
                />
                <label
                  htmlFor={`reply-${index}-file`}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-2xs text-ink-muted hover:text-ink hover:bg-surface-hover cursor-pointer transition-colors"
                >
                  <ImagePlus size={11} />
                  Add image
                </label>
              </>
            )}
          </div>
          <span
            className={[
              'text-2xs font-mono tabular-nums',
              overLimit ? 'text-danger font-semibold' : 'text-ink-subtle',
            ].join(' ')}
          >
            {value.body.length.toLocaleString()} / {charLimit.toLocaleString()}
          </span>
        </div>
      </div>
    </div>
  );
}
