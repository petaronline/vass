'use client';

/**
 * DayDrawer — right-side overlay that shows EVERY post for a given day.
 *
 * Renders when the user clicks a day cell in the Pipeline calendar.
 * Shows posts with full body (no truncation), thumbnail, platform icons,
 * status, time, and a permalink button for published ones.
 *
 * The drawer overlays the calendar but doesn't block the rest of the
 * page from being interactive (no backdrop dim). ESC and click-outside
 * close it.
 */

import { useEffect, useRef } from 'react';
import {
  X,
  ExternalLink,
  Trash2,
  Facebook,
  Instagram,
  AtSign,
  Music2,
  Linkedin,
  CheckCircle2,
  Clock,
  AlertCircle,
  RefreshCw,
  Hash,
  MessageCircle,
} from 'lucide-react';
import type { CalendarPost, OrganicPlatform } from '@/lib/api';
import { uploads } from '@/lib/api';

const PLATFORM_META: Record<OrganicPlatform, { Icon: typeof Facebook; color: string; label: string }> = {
  facebook_page: { Icon: Facebook,  color: '#1877F2', label: 'Facebook' },
  instagram:     { Icon: Instagram, color: '#E1306C', label: 'Instagram' },
  threads:       { Icon: AtSign,    color: '#000000', label: 'Threads' },
  tiktok:        { Icon: Music2,   color: '#000000', label: 'TikTok' },
  linkedin:      { Icon: Linkedin, color: '#0A66C2', label: 'LinkedIn' },
};

interface Props {
  /** The date the drawer is for. */
  date: Date;
  /** Posts for that day (already filtered). */
  posts: CalendarPost[];
  /** Close handler. */
  onClose: () => void;
  /** Cancel-schedule handler — only used for source='vass' scheduled posts. */
  onCancelSchedule: (postId: string) => void;
}

export function DayDrawer({ date, posts, onClose, onCancelSchedule }: Props) {
  const drawerRef = useRef<HTMLDivElement>(null);

  // ESC closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Click-outside closes
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Defer one tick so the click that opened the drawer doesn't immediately close it
    const t = setTimeout(() => window.addEventListener('mousedown', onDoc), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onDoc);
    };
  }, [onClose]);

  const heading = date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <div
      ref={drawerRef}
      className="fixed top-0 right-0 h-full w-[420px] max-w-[90vw] bg-white border-l border-line shadow-card z-40 flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-line">
        <div>
          <h2 className="h-sub text-ink">{heading}</h2>
          <p className="text-xs text-ink-muted mt-0.5">
            {posts.length} {posts.length === 1 ? 'post' : 'posts'}
          </p>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded hover:bg-surface-hover text-ink-muted hover:text-ink"
          aria-label="Close"
        >
          <X size={16} />
        </button>
      </div>

      {/* Posts list */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {posts.length === 0 ? (
          <p className="text-sm text-ink-subtle text-center py-8">
            Nothing here yet.
          </p>
        ) : (
          posts.map((post) => (
            <DayDrawerPostCard
              key={`${post.source}:${post.id}`}
              post={post}
              onCancelSchedule={onCancelSchedule}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ─── Single post card inside the drawer ──────────────────────────────

function DayDrawerPostCard({
  post,
  onCancelSchedule,
}: {
  post: CalendarPost;
  onCancelSchedule: (postId: string) => void;
}) {
  const timeStr = new Date(post.timestamp).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  const statusVisual = statusVisuals(post.status);
  const StatusIcon = statusVisual.Icon;
  const mediaUrl = resolveMediaUrl(post.mediaUrl);

  const isScheduled = post.status === 'scheduled' && post.source === 'vass';

  return (
    <div className="bg-white border border-line rounded-lg overflow-hidden">
      {/* Header strip: time + status + platforms */}
      <div className="flex items-center gap-2 px-3 py-2 bg-surface-alt/40 border-b border-line">
        <span className="text-sm font-semibold text-ink">{timeStr}</span>
        <span className={['inline-flex items-center gap-1 text-2xs uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded', statusVisual.bg, statusVisual.text].join(' ')}>
          <StatusIcon size={9} />
          {statusVisual.label}
        </span>
        <div className="flex items-center gap-1 ml-auto">
          {post.platforms.map((p) => {
            const meta = PLATFORM_META[p];
            if (!meta) return null;
            const Icon = meta.Icon;
            return (
              <span key={p} title={meta.label} className="inline-flex">
                <Icon size={13} style={{ color: meta.color }} />
              </span>
            );
          })}
        </div>
      </div>

      {/* Body */}
      <div className="px-3 py-3 space-y-2">
        {/* Thumbnail */}
        {mediaUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mediaUrl}
            alt=""
            className="w-full max-h-[280px] object-cover rounded bg-black"
          />
        )}

        {/* Topic tag + reply count */}
        {(post.topicTag || post.replyChainLength > 0) && (
          <div className="flex items-center gap-2 flex-wrap">
            {post.topicTag && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-medium bg-surface-alt text-ink-muted border border-line">
                <Hash size={9} strokeWidth={2.5} />
                {post.topicTag}
              </span>
            )}
            {post.replyChainLength > 0 && (
              <span className="inline-flex items-center gap-1 text-2xs text-ink-subtle">
                <MessageCircle size={10} />
                +{post.replyChainLength} {post.replyChainLength === 1 ? 'reply' : 'replies'}
              </span>
            )}
          </div>
        )}

        {/* Body text */}
        <p className="text-sm text-ink whitespace-pre-wrap leading-snug">
          {post.body || <span className="italic text-ink-subtle">(no text)</span>}
        </p>

        {/* Actions */}
        <div className="flex items-center gap-3 pt-1">
          {post.permalink && (
            <a
              href={post.permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
            >
              <ExternalLink size={11} /> Open on platform
            </a>
          )}
          {isScheduled && (
            <button
              onClick={() => onCancelSchedule(post.id)}
              className="inline-flex items-center gap-1 text-xs text-danger hover:underline ml-auto"
            >
              <Trash2 size={11} /> Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Helpers (duplicated from pipeline/page.tsx so this component is
//      self-contained; both files use the same visual taxonomy) ──────

function resolveMediaUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith('vass-upload:')) {
    return uploads.fileUrl(url.slice('vass-upload:'.length));
  }
  return url;
}

function statusVisuals(status: CalendarPost['status']): {
  bg: string;
  text: string;
  Icon: typeof CheckCircle2;
  label: string;
} {
  switch (status) {
    case 'scheduled':
      return { bg: 'bg-accent-subtle', text: 'text-accent', Icon: Clock, label: 'Scheduled' };
    case 'published':
      return { bg: 'bg-success/15', text: 'text-success', Icon: CheckCircle2, label: 'Published' };
    case 'partial':
      return { bg: 'bg-warning/15', text: 'text-warning', Icon: AlertCircle, label: 'Partial' };
    case 'publishing':
      return { bg: 'bg-accent-subtle', text: 'text-accent', Icon: RefreshCw, label: 'Publishing' };
    default:
      // Failed / cancelled / draft shouldn't appear in the calendar at all,
      // but keep a safe fallback so we don't crash if they slip through.
      return { bg: 'bg-surface-hover', text: 'text-ink-subtle', Icon: Clock, label: status };
  }
}
