'use client';

/**
 * WeekView — Sprout-style 7-day timeline (Patch 4.36.2).
 *
 * Layout model (revised):
 *   • Hours along Y axis, days along X. No left gutter — hour labels
 *     overlay the leftmost (Monday) column's top edge for each band.
 *   • Hour BANDS have VARIABLE height. The band's height is derived
 *     from the max number of posts in that hour across all 7 columns.
 *     Empty hours stay at a small fixed minimum; busy hours grow tall
 *     enough to give every post its own full-width row inside the band.
 *   • Within a band, posts are stacked top-to-bottom in time order
 *     (12:05 above 12:55 if both are in the 12 AM band).
 *   • Rows align across columns — Monday's row #2 in the 14:00 band is
 *     at the same Y as Tuesday's row #2 in the 14:00 band, even if
 *     Tuesday has no post in that row.
 *   • Card visuals: soft-tinted background by status, a 4px left accent
 *     bar (the only "loud" color), thin neutral outline, small thumbnail.
 *
 * Click a card → parent opens detail drawer (single post, not the day).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Trash2,
  Pencil,
  Facebook,
  Instagram,
  AtSign,
  Music2,
  Linkedin,
  CheckCircle2,
  Clock,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import type { CalendarPost, OrganicPlatform } from '@/lib/api';
import { uploads } from '@/lib/api';

// ─── Layout constants ────────────────────────────────────────────────
/** Vertical space allotted to one post row inside an hour band. */
const ROW_PX = 56;
/** Minimum height of an empty hour band (just for the label line). */
const MIN_BAND_PX = 36;
/** Inset between the row content and the band edges. */
const ROW_GAP_PX = 4;

const PLATFORM_META: Record<OrganicPlatform, { Icon: typeof Facebook; color: string }> = {
  facebook_page: { Icon: Facebook,  color: '#1877F2' },
  instagram:     { Icon: Instagram, color: '#E1306C' },
  threads:       { Icon: AtSign,    color: '#000000' },
  tiktok:        { Icon: Music2,   color: '#000000' },
  linkedin:      { Icon: Linkedin, color: '#0A66C2' },
};

interface Props {
  posts: CalendarPost[];
  weekStart: Date;
  setWeekStart: (d: Date) => void;
  onCancelSchedule: (postId: string) => void;
  onPostClick: (post: CalendarPost) => void;
  /** Patch 4.40.0: drag-to-reschedule. Called when a scheduled Vass
   *  post is dropped onto a new (day, hour) slot. The new Date keeps
   *  the post's original minutes; only day + hour change. Parent does
   *  the optimistic update + API call. */
  onReschedule?: (post: CalendarPost, newWhen: Date) => void;
  /** Patch 4.41.0: edit a scheduled post. Renders a pencil on
   *  scheduled Vass cards; clicking opens the composer pre-filled. */
  onEditPost?: (post: CalendarPost) => void;
}

interface PostPlacement {
  post: CalendarPost;
  /** Day column 0..6 (Mon..Sun). */
  dayIdx: number;
  /** Hour band 0..23. */
  hour: number;
  /** Row index WITHIN this hour band, after sorting siblings by minute. */
  rowInBand: number;
}

export function WeekView({ posts, weekStart, setWeekStart, onCancelSchedule, onPostClick, onReschedule, onEditPost }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Patch 4.40.0: drag-to-reschedule. Tracks the post being dragged and
  // the slot currently hovered, so we can highlight the drop target.
  const [dragPostId, setDragPostId] = useState<string | null>(null);
  const [hoverSlot, setHoverSlot] = useState<{ dayIdx: number; hour: number } | null>(null);

  // Day list Mon..Sun
  const days = useMemo(() => {
    const arr: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      arr.push(d);
    }
    return arr;
  }, [weekStart]);

  // ─── Pre-compute placement: (dayIdx, hour) -> sorted posts -> rowInBand
  // Also compute each hour band's height = max(MIN_BAND_PX, maxRows*ROW_PX).
  const { placements, bandHeights, bandOffsets, totalHeight } = useMemo(() => {
    // bucket[dayIdx][hour] = CalendarPost[]
    const bucket: CalendarPost[][][] = Array.from({ length: 7 }, () =>
      Array.from({ length: 24 }, () => [])
    );
    for (const p of posts) {
      const ts = new Date(p.timestamp);
      for (let i = 0; i < 7; i++) {
        if (sameLocalDay(ts, days[i])) {
          bucket[i][ts.getHours()].push(p);
          break;
        }
      }
    }
    // Sort each bucket by minute ASC and assign rowInBand.
    const placements: PostPlacement[] = [];
    const heights: number[] = new Array(24).fill(MIN_BAND_PX);
    for (let h = 0; h < 24; h++) {
      let maxRowsThisHour = 0;
      for (let d = 0; d < 7; d++) {
        const cell = bucket[d][h];
        if (cell.length === 0) continue;
        cell.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        for (let r = 0; r < cell.length; r++) {
          placements.push({ post: cell[r], dayIdx: d, hour: h, rowInBand: r });
        }
        if (cell.length > maxRowsThisHour) maxRowsThisHour = cell.length;
      }
      if (maxRowsThisHour > 0) {
        heights[h] = maxRowsThisHour * ROW_PX + ROW_GAP_PX * 2;
      }
    }
    // Cumulative offsets — top of hour band h = sum of heights of hours < h.
    const offsets: number[] = new Array(24).fill(0);
    for (let h = 1; h < 24; h++) offsets[h] = offsets[h - 1] + heights[h - 1];
    const total = offsets[23] + heights[23];
    return { placements, bandHeights: heights, bandOffsets: offsets, totalHeight: total };
  }, [posts, days]);

  // Auto-scroll on initial mount / week change — find the hour offset
  // for 7am so it lines up regardless of band-height variability above.
  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = bandOffsets[7] ?? 0;
    }
  }, [weekStart, bandOffsets]);

  // ─── Navigation
  const prevWeek = () => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() - 7);
    setWeekStart(d);
  };
  const nextWeek = () => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + 7);
    setWeekStart(d);
  };
  const today = () => setWeekStart(mondayOf(new Date()));

  const headerLabel = `Week of ${weekStart.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })}`;
  const todayDate = new Date();

  return (
    <div className="bg-white border border-line rounded-lg shadow-card overflow-hidden">
      {/* Top toolbar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-line/60">
        <div className="flex items-center gap-1">
          <button onClick={prevWeek} className="p-1.5 rounded hover:bg-surface-hover text-ink-muted hover:text-ink" aria-label="Previous week">
            <ChevronLeft size={16} />
          </button>
          <button onClick={today} className="text-xs font-medium text-ink-muted hover:text-ink px-2 py-1 rounded hover:bg-surface-hover transition-colors">
            Today
          </button>
          <button onClick={nextWeek} className="p-1.5 rounded hover:bg-surface-hover text-ink-muted hover:text-ink" aria-label="Next week">
            <ChevronRight size={16} />
          </button>
        </div>
        <h2 className="h-sub text-ink">{headerLabel}</h2>
        <div className="w-[100px]" />
      </div>

      {/* Day-of-week header — sticky on top of the scrolling grid.
          Left-padded by the hour-gutter width so day columns line up
          with the grid below. */}
      <div className="flex border-b border-line/60 sticky top-0 z-10 bg-white">
        <div className="w-[44px] shrink-0 border-r border-line/40" />
        <div className="flex-1 grid grid-cols-7">
          {days.map((d, i) => {
            const isToday = sameLocalDay(d, todayDate);
            return (
              <div
                key={i}
                className={[
                  'flex flex-col items-center justify-center px-2 py-2 border-l border-line/40 first:border-l-0',
                  isToday ? 'bg-accent-subtle/30' : '',
                ].join(' ')}
              >
                <span className="text-2xs uppercase tracking-wider font-semibold text-ink-subtle">
                  {d.toLocaleDateString(undefined, { weekday: 'short' })}
                </span>
                <span
                  className={[
                    'text-sm font-semibold',
                    isToday ? 'text-accent' : 'text-ink',
                  ].join(' ')}
                >
                  {d.getDate()}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Scrollable grid — flex row: 44px hour gutter + 7-col day grid */}
      <div ref={scrollerRef} className="overflow-y-auto" style={{ maxHeight: '70vh' }}>
        <div
          className="relative flex bg-white"
          style={{ height: totalHeight + 'px' }}
        >
          {/* Hour-label gutter on the left */}
          <div className="w-[44px] shrink-0 border-r border-line/40 relative">
            {bandOffsets.map((offset, h) =>
              h === 0 ? null : (
                <span
                  key={h}
                  className="absolute right-1.5 text-2xs text-ink-subtle pointer-events-none select-none"
                  style={{ top: offset + 'px', transform: 'translateY(-50%)', lineHeight: '12px' }}
                >
                  {formatHour(h)}
                </span>
              )
            )}
          </div>

          {/* Main grid (7 day columns) — wrapped so post placements
              can position relative to it. */}
          <div className="flex-1 relative grid grid-cols-7">
            {/* Hour band horizontal dividers — drawn behind the columns */}
            {bandOffsets.map((offset, h) => (
              <div
                key={h}
                className="absolute left-0 right-0 border-t border-line/30 pointer-events-none"
                style={{ top: offset + 'px' }}
              />
            ))}

            {/* Day columns */}
            {days.map((d, dayIdx) => {
              const isToday = sameLocalDay(d, todayDate);
              return (
                <div
                  key={dayIdx}
                  className={[
                    'relative border-l border-line/40 first:border-l-0',
                    isToday ? 'bg-accent-subtle/[0.04]' : '',
                  ].join(' ')}
                />
              );
            })}

            {/* Drop-zone overlay (Patch 4.40.0) — one target per
                (day, hour). Only active while a post is being dragged,
                so it never interferes with normal clicks. Each zone
                computes a new datetime from its day+hour, preserving
                the dragged post's original minutes. */}
            {dragPostId && onReschedule && days.map((d, dayIdx) =>
              bandOffsets.map((offset, hour) => {
                const isHover = hoverSlot?.dayIdx === dayIdx && hoverSlot?.hour === hour;
                return (
                  <div
                    key={`dz-${dayIdx}-${hour}`}
                    className={[
                      'absolute z-10',
                      isHover ? 'bg-accent/10 ring-1 ring-inset ring-accent/40' : '',
                    ].join(' ')}
                    style={{
                      top: offset + 'px',
                      height: bandHeights[hour] + 'px',
                      left: `${(dayIdx / 7) * 100}%`,
                      width: `${100 / 7}%`,
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      if (!isHover) setHoverSlot({ dayIdx, hour });
                    }}
                    onDragLeave={() => {
                      if (isHover) setHoverSlot(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const id = e.dataTransfer.getData('text/vass-post') || dragPostId;
                      const post = posts.find((p) => p.id === id);
                      setDragPostId(null);
                      setHoverSlot(null);
                      if (!post) return;
                      // Build the new datetime: target day + target hour,
                      // keep original minutes/seconds.
                      const orig = new Date(post.timestamp);
                      const when = new Date(d);
                      when.setHours(hour, orig.getMinutes(), 0, 0);
                      onReschedule(post, when);
                    }}
                  />
                );
              })
            )}

            {/* Posts — absolute-positioned over the columns. */}
            {placements.map((pl) => (
              <WeekPostCard
                key={`${pl.post.source}:${pl.post.id}`}
                placement={pl}
                bandOffset={bandOffsets[pl.hour]}
                onClick={() => onPostClick(pl.post)}
                onCancel={() => onCancelSchedule(pl.post.id)}
                onEdit={onEditPost ? () => onEditPost(pl.post) : undefined}
                draggable={!!onReschedule && pl.post.status === 'scheduled' && pl.post.source === 'vass'}
                isDragging={dragPostId === pl.post.id}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/vass-post', pl.post.id);
                  e.dataTransfer.effectAllowed = 'move';
                  setDragPostId(pl.post.id);
                }}
                onDragEnd={() => { setDragPostId(null); setHoverSlot(null); }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Post card — neutral palette, status as left accent only ────────

function WeekPostCard({
  placement,
  bandOffset,
  onClick,
  onCancel,
  onEdit,
  draggable = false,
  isDragging = false,
  onDragStart,
  onDragEnd,
}: {
  placement: PostPlacement;
  bandOffset: number;
  onClick: () => void;
  onCancel: () => void;
  onEdit?: () => void;
  draggable?: boolean;
  isDragging?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}) {
  const { post, dayIdx, rowInBand } = placement;
  const ts = new Date(post.timestamp);
  const timeStr = ts.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  // Position
  const top = bandOffset + ROW_GAP_PX + rowInBand * ROW_PX;
  const left = `calc(${(dayIdx / 7) * 100}% + 3px)`;
  const width = `calc(${100 / 7}% - 6px)`;

  const visual = statusVisuals(post.status);
  const StatusIcon = visual.Icon;
  const mediaUrl = resolveMediaUrl(post.mediaUrl);
  const isPublished = post.status === 'published' || post.status === 'partial';
  const isScheduledVass = post.status === 'scheduled' && post.source === 'vass';

  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={[
        'absolute rounded-lg overflow-hidden group transition-all',
        'border border-line bg-white hover:shadow-card hover:z-20',
        draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
        isDragging ? 'opacity-40' : '',
      ].join(' ')}
      style={{
        top: top + 'px',
        left,
        width,
        height: ROW_PX - ROW_GAP_PX + 'px',
        backgroundColor: visual.tintBg, // very faint status tint
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onClick}
    >
      {/* Left accent bar — the only "loud" status color */}
      <div
        className="absolute left-0 top-0 bottom-0"
        style={{ width: '4px', backgroundColor: visual.accent }}
      />

      <div className="h-full pl-3 pr-1.5 py-1 flex items-center gap-2">
        {/* Thumbnail */}
        {mediaUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mediaUrl}
            alt=""
            className="w-9 h-9 rounded object-cover bg-black shrink-0"
          />
        ) : (
          <div className="w-9 h-9 rounded bg-surface-alt flex items-center justify-center shrink-0">
            <StatusIcon size={14} className="text-ink-subtle" />
          </div>
        )}

        {/* Text */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-2xs font-semibold text-ink">
              {timeStr}
            </span>
            <div className="flex items-center gap-0.5">
              {post.platforms.slice(0, 3).map((p) => {
                const meta = PLATFORM_META[p];
                if (!meta) return null;
                const Icon = meta.Icon;
                return <Icon key={p} size={9} style={{ color: meta.color }} />;
              })}
            </div>
          </div>
          <p className="text-2xs text-ink-muted truncate leading-tight mt-0.5">
            {post.body || <span className="italic text-ink-subtle">(no text)</span>}
          </p>
        </div>

        {/* Hover actions */}
        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity">
          {isPublished && post.permalink && (
            <a
              href={post.permalink}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="p-1 rounded text-ink-subtle hover:text-ink hover:bg-surface-hover"
              title="Open on platform"
            >
              <ExternalLink size={11} />
            </a>
          )}
          {isScheduledVass && onEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(); }}
              className="p-1 rounded text-ink-subtle hover:text-accent hover:bg-accent/10"
              title="Edit"
            >
              <Pencil size={11} />
            </button>
          )}
          {isScheduledVass && (
            <button
              onClick={(e) => { e.stopPropagation(); onCancel(); }}
              className="p-1 rounded text-ink-subtle hover:text-danger hover:bg-danger/10"
              title="Cancel"
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Monday of the week containing `d`, in local time. */
export function mondayOf(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const offset = (out.getDay() + 6) % 7;
  out.setDate(out.getDate() - offset);
  return out;
}

function formatHour(h: number): string {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

function resolveMediaUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith('vass-upload:')) {
    return uploads.fileUrl(url.slice('vass-upload:'.length));
  }
  return url;
}

/**
 * Status visuals — neutral cards with a colored left bar only.
 *  - `accent`: hex for the 4px left bar (the only loud color)
 *  - `tintBg`: very faint background tint as an inline rgba (hard to do
 *      reliably via Tailwind alone since we want sub-10% alpha values)
 */
function statusVisuals(status: CalendarPost['status']): {
  accent: string;
  tintBg: string;
  Icon: typeof CheckCircle2;
} {
  switch (status) {
    case 'scheduled':
      // soft slate blue
      return { accent: '#6b7fa3', tintBg: 'rgba(107, 127, 163, 0.04)', Icon: Clock };
    case 'publishing':
      return { accent: '#6b7fa3', tintBg: 'rgba(107, 127, 163, 0.04)', Icon: RefreshCw };
    case 'published':
      // muted green
      return { accent: '#5b9f6a', tintBg: 'rgba(91, 159, 106, 0.04)', Icon: CheckCircle2 };
    case 'partial':
      // muted amber
      return { accent: '#c98a3e', tintBg: 'rgba(201, 138, 62, 0.05)', Icon: AlertCircle };
    default:
      return { accent: '#a3a3a3', tintBg: 'rgba(0, 0, 0, 0.02)', Icon: Clock };
  }
}
