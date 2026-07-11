'use client';

/**
 * FacebookPreview — FB-feed-styled card.
 *
 * Patch 4.27: handles single image, multi-image carousel, and single
 * video. Media is supplied as an ordered array of items.
 */
import { useState } from 'react';
import {
  ThumbsUp,
  MessageCircle,
  Share2,
  Globe,
  MoreHorizontal,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { FeedVideo } from './FeedVideo';

export interface PreviewMediaItem {
  kind: 'image' | 'video' | 'document';
  url: string;
}

interface Props {
  pageName: string;
  pagePictureUrl?: string | null;
  body: string;
  media: PreviewMediaItem[];
}

export function FacebookPreview({ pageName, pagePictureUrl, body, media }: Props) {
  const [carouselIndex, setCarouselIndex] = useState(0);

  return (
    <div className="bg-white rounded-lg border border-[#dadde1] shadow-sm w-full max-w-[500px] mx-auto overflow-hidden font-[system-ui]">
      {/* Header */}
      <div className="flex items-start gap-2 px-4 pt-3 pb-2">
        <div className="w-10 h-10 rounded-full overflow-hidden bg-gray-200 shrink-0">
          {pagePictureUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={pagePictureUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-sm font-semibold text-gray-500">
              {pageName.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-semibold text-[#050505] leading-tight truncate">
            {pageName || 'Your Page'}
          </div>
          <div className="flex items-center gap-1 text-[13px] text-[#65676b] mt-0.5">
            <span>Just now</span>
            <span>·</span>
            <Globe size={11} />
          </div>
        </div>
        <button className="text-[#65676b] p-1 rounded hover:bg-[#f2f2f2]" aria-label="More">
          <MoreHorizontal size={18} />
        </button>
      </div>

      {/* Body */}
      {body && (
        <div className="px-4 pb-3 text-[15px] text-[#050505] whitespace-pre-wrap leading-snug break-words">
          {body}
        </div>
      )}
      {!body && media.length === 0 && (
        <div className="px-4 pb-3 text-[15px] text-[#a8a8a8] italic">
          Your post text will appear here…
        </div>
      )}

      {/* Media */}
      <FbMedia
        media={media}
        carouselIndex={carouselIndex}
        setCarouselIndex={setCarouselIndex}
      />

      {/* Reactions row */}
      <div className="flex items-center justify-between px-4 py-2 text-[#65676b] text-[13px]">
        <div className="flex items-center gap-1">
          <span className="w-4 h-4 rounded-full bg-[#1877F2] flex items-center justify-center">
            <ThumbsUp size={9} className="text-white" fill="white" />
          </span>
          <span>—</span>
        </div>
        <div className="flex gap-3 text-[13px]">
          <span>0 comments</span>
          <span>0 shares</span>
        </div>
      </div>

      <div className="grid grid-cols-3 border-t border-[#dadde1]">
        <FbAction icon={<ThumbsUp size={16} />} label="Like" />
        <FbAction icon={<MessageCircle size={16} />} label="Comment" />
        <FbAction icon={<Share2 size={16} />} label="Share" />
      </div>
    </div>
  );
}

function FbMedia({
  media,
  carouselIndex,
  setCarouselIndex,
}: {
  media: PreviewMediaItem[];
  carouselIndex: number;
  setCarouselIndex: (i: number) => void;
}) {
  if (media.length === 0) return null;

  // Single video
  if (media.length === 1 && media[0].kind === 'video') {
    return (
      <div className="w-full max-h-[480px] aspect-video border-y border-[#dadde1]">
        <FeedVideo src={media[0].url} mutePosition="bottom-right" className="h-full w-full object-contain bg-black" />
      </div>
    );
  }

  // Single image
  if (media.length === 1 && media[0].kind === 'image') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={media[0].url}
        alt=""
        className="w-full max-h-[480px] object-cover border-y border-[#dadde1]"
      />
    );
  }

  // Multi-image carousel
  const active = media[Math.min(carouselIndex, media.length - 1)];
  return (
    <div className="relative border-y border-[#dadde1]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={active.url}
        alt=""
        className="w-full max-h-[480px] object-cover bg-black"
      />
      {/* Image count badge */}
      <div className="absolute top-2 right-2 bg-black/60 text-white text-xs font-medium px-2 py-1 rounded-full">
        {carouselIndex + 1} / {media.length}
      </div>
      {/* Prev / Next chevrons */}
      {carouselIndex > 0 && (
        <button
          onClick={() => setCarouselIndex(carouselIndex - 1)}
          className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/90 hover:bg-white shadow-sm flex items-center justify-center"
          aria-label="Previous"
        >
          <ChevronLeft size={16} />
        </button>
      )}
      {carouselIndex < media.length - 1 && (
        <button
          onClick={() => setCarouselIndex(carouselIndex + 1)}
          className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/90 hover:bg-white shadow-sm flex items-center justify-center"
          aria-label="Next"
        >
          <ChevronRight size={16} />
        </button>
      )}
    </div>
  );
}

function FbAction({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <button className="flex items-center justify-center gap-2 py-2 text-[15px] font-semibold text-[#65676b] hover:bg-[#f2f2f2] transition-colors">
      <span>{icon}</span>
      <span>{label}</span>
    </button>
  );
}
