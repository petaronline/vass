'use client';

/**
 * InstagramPreview — IG-feed-styled card.
 *
 * Patch 4.27: image, multi-image carousel, or single video. The IG feed
 * card layout is square media + heart/comment/send action row + caption.
 */
import { useState } from 'react';
import {
  Heart,
  MessageCircle,
  Send,
  Bookmark,
  MoreHorizontal,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { FeedVideo } from './FeedVideo';
import type { PreviewMediaItem } from './FacebookPreview';

interface Props {
  username: string;
  pictureUrl?: string | null;
  body: string;
  media: PreviewMediaItem[];
}

const TRUNCATE_AT = 130;

export function InstagramPreview({ username, pictureUrl, body, media }: Props) {
  const [carouselIndex, setCarouselIndex] = useState(0);
  const display = username || 'your.account';
  const isLong = body.length > TRUNCATE_AT;

  return (
    <div className="bg-white rounded-lg border border-[#dbdbdb] w-full max-w-[470px] mx-auto overflow-hidden font-[system-ui]">
      {/* Header */}
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="w-8 h-8 rounded-full overflow-hidden bg-gradient-to-tr from-[#fdd835] via-[#e1306c] to-[#833ab4] p-[1.5px] shrink-0">
          <div className="w-full h-full rounded-full bg-white p-[1.5px]">
            <div className="w-full h-full rounded-full overflow-hidden bg-gray-200">
              {pictureUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={pictureUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-[10px] font-semibold text-gray-500">
                  {display.charAt(0).toUpperCase()}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-semibold text-black leading-tight truncate">{display}</div>
        </div>
        <button className="text-black p-1" aria-label="More">
          <MoreHorizontal size={16} />
        </button>
      </div>

      {/* Square media */}
      <IgMedia
        media={media}
        carouselIndex={carouselIndex}
        setCarouselIndex={setCarouselIndex}
      />

      {/* Action row */}
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
        <div className="flex items-center gap-3.5 text-black">
          <Heart size={22} strokeWidth={1.8} />
          <MessageCircle size={22} strokeWidth={1.8} />
          <Send size={22} strokeWidth={1.8} />
        </div>
        <Bookmark size={22} strokeWidth={1.8} className="text-black" />
      </div>

      {/* Carousel dots */}
      {media.length > 1 && (
        <div className="flex justify-center gap-1 pb-1.5">
          {media.map((_, i) => (
            <span
              key={i}
              className={[
                'w-1.5 h-1.5 rounded-full transition-colors',
                i === carouselIndex ? 'bg-[#0095f6]' : 'bg-[#dbdbdb]',
              ].join(' ')}
            />
          ))}
        </div>
      )}

      {/* Likes & caption */}
      <div className="px-3 pb-3">
        <div className="text-[13px] font-semibold text-black leading-tight">—</div>
        {body ? (
          <div className="mt-1 text-[13px] text-black leading-snug">
            <span className="font-semibold mr-1">{display}</span>
            <span className="whitespace-pre-wrap break-words">
              {isLong ? `${body.slice(0, TRUNCATE_AT).trimEnd()}…` : body}
            </span>
            {isLong && (
              <span className="text-[#8e8e8e] ml-1 cursor-pointer">more</span>
            )}
          </div>
        ) : (
          <div className="mt-1 text-[13px] text-[#8e8e8e] italic">
            Your caption will appear here…
          </div>
        )}
        <div className="text-[10px] uppercase tracking-wider text-[#8e8e8e] mt-2">
          Just now
        </div>
      </div>
    </div>
  );
}

function IgMedia({
  media,
  carouselIndex,
  setCarouselIndex,
}: {
  media: PreviewMediaItem[];
  carouselIndex: number;
  setCarouselIndex: (i: number) => void;
}) {
  // Empty state
  if (media.length === 0) {
    return (
      <div className="bg-[#fafafa] aspect-[4/5] flex items-center justify-center border-y border-[#dbdbdb]">
        <div className="text-center px-6">
          <div className="text-[13px] text-[#8e8e8e] italic">
            Instagram posts require an image or video.
          </div>
        </div>
      </div>
    );
  }

  // Single video → autoplay loop muted (IG style)
  if (media.length === 1 && media[0].kind === 'video') {
    return (
      <div className="w-full aspect-[9/16] border-y border-[#dbdbdb]">
        <FeedVideo src={media[0].url} mutePosition="bottom-right" />
      </div>
    );
  }

  // Single image — IG default feed crop is 4:5 portrait
  if (media.length === 1 && media[0].kind === 'image') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={media[0].url}
        alt=""
        className="w-full aspect-[4/5] object-cover border-y border-[#dbdbdb]"
      />
    );
  }

  // Carousel — all items share the post's aspect; we default to 4:5
  const active = media[Math.min(carouselIndex, media.length - 1)];
  return (
    <div className="relative border-y border-[#dbdbdb]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={active.url}
        alt=""
        className="w-full aspect-[4/5] object-cover bg-black"
      />
      <div className="absolute top-2 right-2 bg-black/60 text-white text-xs font-medium px-2 py-1 rounded-full">
        {carouselIndex + 1} / {media.length}
      </div>
      {carouselIndex > 0 && (
        <button
          onClick={() => setCarouselIndex(carouselIndex - 1)}
          className="absolute left-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-white/90 hover:bg-white shadow-sm flex items-center justify-center"
          aria-label="Previous"
        >
          <ChevronLeft size={14} />
        </button>
      )}
      {carouselIndex < media.length - 1 && (
        <button
          onClick={() => setCarouselIndex(carouselIndex + 1)}
          className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-white/90 hover:bg-white shadow-sm flex items-center justify-center"
          aria-label="Next"
        >
          <ChevronRight size={14} />
        </button>
      )}
    </div>
  );
}
