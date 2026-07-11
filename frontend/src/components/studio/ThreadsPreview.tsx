'use client';

/**
 * ThreadsPreview — Threads-feed-styled card.
 *
 * Matches Threads' visual style: profile picture circle, "name • handle • time",
 * post body in serif-like sans, optional media, action row underneath
 * (heart / reply / repost / share). When a reply chain is present we
 * render each reply as its own card connected by a vertical line on the
 * left, mimicking Threads' own threading visual.
 *
 * Topic tag (if any) renders as a small pill at the top of the head post,
 * matching how Threads surfaces topics in the feed today.
 */

import { useState } from 'react';
import {
  Heart,
  MessageCircle,
  Repeat2,
  Send,
  MoreHorizontal,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { FeedVideo } from './FeedVideo';
import type { PreviewMediaItem } from './FacebookPreview';

interface ReplyPreview {
  body: string;
  media: PreviewMediaItem[];
}

interface Props {
  username: string;
  pictureUrl?: string | null;
  body: string;
  media: PreviewMediaItem[];
  /** Optional topic tag to render as a pill above the head post. */
  topicTag?: string | null;
  /** Optional reply chain — each entry is a separate connected card. */
  replyChain?: ReplyPreview[];
}

export function ThreadsPreview({
  username,
  pictureUrl,
  body,
  media,
  topicTag,
  replyChain = [],
}: Props) {
  const display = username || 'your.account';

  return (
    <div className="w-full max-w-[470px] mx-auto font-[system-ui]">
      {/* Head post */}
      <ThreadsCard
        username={display}
        pictureUrl={pictureUrl}
        body={body}
        media={media}
        topicTag={topicTag}
        isHead
        hasReplyBelow={replyChain.length > 0}
      />

      {/* Reply chain — each one is its own card; we offset the avatar
          slightly to suggest the chain visually, like Threads does. */}
      {replyChain.map((reply, idx) => (
        <ThreadsCard
          key={idx}
          username={display}
          pictureUrl={pictureUrl}
          body={reply.body}
          media={reply.media}
          hasReplyBelow={idx < replyChain.length - 1}
        />
      ))}
    </div>
  );
}

// ─── Single post card ───────────────────────────────────────────────────

interface CardProps {
  username: string;
  pictureUrl?: string | null;
  body: string;
  media: PreviewMediaItem[];
  topicTag?: string | null;
  /** Head vs reply — only the head gets the topic tag and a slightly
   *  taller "first-post" feel. */
  isHead?: boolean;
  /** When true, draws the vertical thread line down to the next card. */
  hasReplyBelow?: boolean;
}

function ThreadsCard({
  username,
  pictureUrl,
  body,
  media,
  topicTag,
  isHead = false,
  hasReplyBelow = false,
}: CardProps) {
  const [carouselIndex, setCarouselIndex] = useState(0);
  const initial = (username || '?').charAt(0).toUpperCase();
  const safeBody = body || (isHead ? 'Your post body…' : 'Reply body…');

  return (
    <div className="bg-white border-b border-[#e5e7eb] last:border-b-0">
      <div className="flex gap-3 px-4 pt-3 pb-2">
        {/* Avatar column — includes the thread-line below when there's
            a reply chain. */}
        <div className="flex flex-col items-center shrink-0">
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-gray-200 to-gray-300 overflow-hidden flex items-center justify-center">
            {pictureUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={pictureUrl} alt={username} className="w-full h-full object-cover" />
            ) : (
              <span className="text-sm font-semibold text-gray-500">{initial}</span>
            )}
          </div>
          {hasReplyBelow && <div className="flex-1 w-px bg-[#e5e7eb] mt-1 mb-1 min-h-[20px]" />}
        </div>

        {/* Content column */}
        <div className="flex-1 min-w-0">
          {/* Header row: name [> #topic] · time + more */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-sm min-w-0">
              <span className="font-semibold text-black truncate">{username}</span>
              {/* Topic tag rendered inline-right of the username (head post
                  only), matching Threads' own UX. Threads shows it as
                  "username > #topic" in the post header. */}
              {isHead && topicTag && topicTag.trim().length > 0 && (
                <>
                  <ChevronRight size={12} className="text-[#999] shrink-0" />
                  <span className="font-semibold text-black truncate">
                    {topicTag.trim()}
                  </span>
                </>
              )}
              <span className="text-[#999] shrink-0">·</span>
              <span className="text-[#999] text-xs shrink-0">now</span>
            </div>
            <MoreHorizontal size={16} className="text-[#999] shrink-0" />
          </div>

          {/* Body */}
          <div
            className={[
              'mt-1 text-[15px] leading-[20px] text-black whitespace-pre-wrap break-words',
              !body && 'text-[#999] italic',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {safeBody}
          </div>

          {/* Media */}
          {media.length > 0 && (
            <div className="mt-2 rounded-2xl overflow-hidden border border-[#e5e7eb] relative bg-black">
              {media.length === 1 ? (
                <SingleMedia item={media[0]} />
              ) : (
                <>
                  <div className="aspect-square">
                    <SingleMedia item={media[carouselIndex]} />
                  </div>
                  {/* Carousel arrows */}
                  {carouselIndex > 0 && (
                    <button
                      type="button"
                      onClick={() => setCarouselIndex((i) => Math.max(0, i - 1))}
                      className="absolute left-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70 transition-colors"
                    >
                      <ChevronLeft size={16} />
                    </button>
                  )}
                  {carouselIndex < media.length - 1 && (
                    <button
                      type="button"
                      onClick={() => setCarouselIndex((i) => Math.min(media.length - 1, i + 1))}
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70 transition-colors"
                    >
                      <ChevronRight size={16} />
                    </button>
                  )}
                  {/* Dot indicator */}
                  <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1">
                    {media.map((_, i) => (
                      <span
                        key={i}
                        className={[
                          'block w-1.5 h-1.5 rounded-full transition-colors',
                          i === carouselIndex ? 'bg-white' : 'bg-white/40',
                        ].join(' ')}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Action row */}
          <div className="mt-2 flex items-center gap-4 text-[#666]">
            <ActionIcon Icon={Heart} />
            <ActionIcon Icon={MessageCircle} />
            <ActionIcon Icon={Repeat2} />
            <ActionIcon Icon={Send} />
          </div>
        </div>
      </div>
    </div>
  );
}

function SingleMedia({ item }: { item: PreviewMediaItem }) {
  if (item.kind === 'video') {
    return (
      <div className="w-full aspect-square">
        <FeedVideo src={item.url} mutePosition="bottom-right" className="h-full w-full object-cover bg-black" />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={item.url} alt="" className="w-full h-auto object-cover" />
  );
}

function ActionIcon({ Icon }: { Icon: typeof Heart }) {
  return (
    <button
      type="button"
      className="p-1.5 -ml-1.5 hover:text-black transition-colors"
      // Visual-only — clicking does nothing in preview
      onClick={(e) => e.preventDefault()}
    >
      <Icon size={18} strokeWidth={1.7} />
    </button>
  );
}
