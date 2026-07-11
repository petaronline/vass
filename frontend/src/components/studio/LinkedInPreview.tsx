'use client';

/**
 * LinkedInPreview — LinkedIn-feed-styled card.
 *
 * A LinkedIn post: author block (name, subtitle, "Now · globe"), the
 * commentary text, optional media, and the Like / Comment / Repost /
 * Send action bar. Colors are platform-faithful (LinkedIn greys/blue)
 * like the other previews — intentionally not Vass tokens.
 *
 * `authorName` is the profile or company-page name; `subtitle` is the
 * headline/follower line under it.
 */
import { PdfFirstPage } from './PdfFirstPage';
import { useState } from 'react';
import {
  ThumbsUp,
  MessageCircle,
  Repeat2,
  Send,
  Globe,
  MoreHorizontal,
  ChevronLeft,
  ChevronRight,
  FileText,
} from 'lucide-react';
import { FeedVideo } from './FeedVideo';
import type { PreviewMediaItem } from './FacebookPreview';

interface Props {
  authorName: string;
  authorPictureUrl?: string | null;
  subtitle?: string | null;
  body: string;
  media: PreviewMediaItem[];
  documentTitle?: string | null;
}

export function LinkedInPreview({
  authorName,
  authorPictureUrl,
  subtitle,
  body,
  media,
  documentTitle,
}: Props) {
  const [carouselIndex, setCarouselIndex] = useState(0);
  const name = authorName || 'Your Page';

  return (
    <div className="mx-auto w-full max-w-[500px] overflow-hidden rounded-lg border border-[#e0dfdc] bg-white font-[system-ui] shadow-sm">
      {/* Header */}
      <div className="flex items-start gap-2 px-4 pt-3 pb-1">
        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-full bg-gray-200">
          {authorPictureUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={authorPictureUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-base font-semibold text-gray-500">
              {name.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-[#000000e6] leading-tight">
            {name}
          </div>
          {subtitle && (
            <div className="truncate text-xs text-[#00000099] leading-tight">{subtitle}</div>
          )}
          <div className="mt-0.5 flex items-center gap-1 text-xs text-[#00000099]">
            <span>Now</span>
            <span>·</span>
            <Globe size={12} />
          </div>
        </div>
        <button className="rounded p-1 text-[#00000099] hover:bg-[#00000008]" aria-label="More">
          <MoreHorizontal size={20} />
        </button>
      </div>

      {/* Body */}
      {body ? (
        <div className="whitespace-pre-wrap break-words px-4 pb-2 pt-1 text-sm leading-snug text-[#000000e6]">
          {body}
        </div>
      ) : (
        media.length === 0 && (
          <div className="px-4 pb-2 pt-1 text-sm italic text-[#00000066]">
            Your post text will appear here…
          </div>
        )
      )}

      {/* Media */}
      <LiMedia media={media} carouselIndex={carouselIndex} setCarouselIndex={setCarouselIndex} documentTitle={documentTitle} />

      {/* Counts row */}
      <div className="flex items-center justify-between px-4 py-2 text-xs text-[#00000099]">
        <div className="flex items-center gap-1">
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#0A66C2]">
            <ThumbsUp size={9} className="text-white" fill="white" />
          </span>
          <span>—</span>
        </div>
        <div>0 comments</div>
      </div>

      <div className="grid grid-cols-4 border-t border-[#e0dfdc]">
        <LiAction icon={<ThumbsUp size={18} />} label="Like" />
        <LiAction icon={<MessageCircle size={18} />} label="Comment" />
        <LiAction icon={<Repeat2 size={18} />} label="Repost" />
        <LiAction icon={<Send size={18} />} label="Send" />
      </div>
    </div>
  );
}

function LiMedia({
  media,
  carouselIndex,
  setCarouselIndex,
  documentTitle,
}: {
  media: PreviewMediaItem[];
  carouselIndex: number;
  setCarouselIndex: (i: number) => void;
  documentTitle?: string | null;
}) {
  if (media.length === 0) return null;

  if (media.length === 1 && media[0].kind === 'document') {
    return <LiDocument url={media[0].url} title={documentTitle} />;
  }
  if (media.length === 1 && media[0].kind === 'video') {
    return (
      <div className="max-h-[480px] w-full aspect-video border-y border-[#e0dfdc]">
        <FeedVideo src={media[0].url} mutePosition="bottom-right" className="h-full w-full object-contain bg-black" />
      </div>
    );
  }
  if (media.length === 1) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={media[0].url}
        alt=""
        className="max-h-[480px] w-full border-y border-[#e0dfdc] object-cover"
      />
    );
  }

  const active = media[Math.min(carouselIndex, media.length - 1)];
  return (
    <div className="relative border-y border-[#e0dfdc]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={active.url} alt="" className="max-h-[480px] w-full bg-black object-cover" />
      <div className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-1 text-xs font-medium text-white">
        {carouselIndex + 1} / {media.length}
      </div>
      {carouselIndex > 0 && (
        <button
          onClick={() => setCarouselIndex(carouselIndex - 1)}
          className="absolute left-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 shadow-sm hover:bg-white"
          aria-label="Previous"
        >
          <ChevronLeft size={16} />
        </button>
      )}
      {carouselIndex < media.length - 1 && (
        <button
          onClick={() => setCarouselIndex(carouselIndex + 1)}
          className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 shadow-sm hover:bg-white"
          aria-label="Next"
        >
          <ChevronRight size={16} />
        </button>
      )}
    </div>
  );
}

function LiAction({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <button className="flex items-center justify-center gap-1.5 py-2.5 text-sm font-semibold text-[#00000099] transition-colors hover:bg-[#00000008]">
      <span>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

/** LinkedIn document post: shows the PDF's first page (rendered client-side)
 *  with a title bar, falling back to a file card if rendering fails. */
function LiDocument({ url, title }: { url: string; title?: string | null }) {
  const [useCard, setUseCard] = useState(false);
  const heading = title?.trim() || 'Untitled document';

  if (useCard) {
    return (
      <div className="flex items-center gap-3 border-y border-[#e0dfdc] bg-[#f3f2ef] px-4 py-5">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-[#e0dfdc] text-[#666]">
          <FileText size={22} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-[#1b1f23]">{heading}</div>
          <div className="text-xs text-[#666]">PDF document</div>
        </div>
      </div>
    );
  }

  return (
    <div className="border-y border-[#e0dfdc] bg-[#f3f2ef]">
      <div className="w-full bg-white">
        <PdfFirstPage src={url} className="w-full block" onFail={() => setUseCard(true)} />
      </div>
      <div className="flex items-center gap-2 px-4 py-3">
        <FileText size={16} className="shrink-0 text-[#666]" />
        <span className="truncate text-sm font-semibold text-[#1b1f23]">{heading}</span>
      </div>
    </div>
  );
}
