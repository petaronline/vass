'use client';

/**
 * TikTokPreview — TikTok-styled vertical (9:16) card.
 *
 * TikTok posts are full-bleed vertical media with the caption + author
 * overlaid at the bottom-left and an action rail (avatar, like, comment,
 * bookmark, share) down the right. Colors here are platform-faithful
 * (black canvas, white text) the same way Facebook/Instagram previews
 * mimic their real UIs — these are intentionally NOT Vass design tokens.
 *
 * TikTok requires media; if none is attached yet we show a placeholder
 * canvas so the layout still reads.
 */
import { useState } from 'react';
import { Heart, MessageCircle, Bookmark, Share2, Music2, Plus } from 'lucide-react';
import type { PreviewMediaItem } from './FacebookPreview';
import { FeedVideo } from './FeedVideo';

interface Props {
  username: string;
  pictureUrl?: string | null;
  body: string;
  media: PreviewMediaItem[];
}

export function TikTokPreview({ username, pictureUrl, body, media }: Props) {
  const [carouselIndex, setCarouselIndex] = useState(0);
  const handle = username || 'yourhandle';
  const first = media[0];
  const active = media[Math.min(carouselIndex, Math.max(media.length - 1, 0))];

  return (
    <div className="mx-auto w-full max-w-[300px] font-[system-ui]">
      <div className="relative aspect-[9/16] w-full overflow-hidden rounded-xl bg-black">
        {/* Media canvas */}
        {!first ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/40">
            <Music2 size={32} />
            <span className="text-xs">Add a video or photo</span>
          </div>
        ) : active?.kind === 'video' ? (
          <div className="absolute inset-0">
            <FeedVideo src={active.url} mutePosition="top-right" />
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={active?.url} alt="" className="absolute inset-0 h-full w-full object-cover" />
        )}

        {/* Bottom gradient so overlaid text stays legible */}
        <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/70 to-transparent pointer-events-none" />

        {/* Photo-carousel dots */}
        {media.length > 1 && (
          <div className="absolute left-1/2 top-3 flex -translate-x-1/2 gap-1">
            {media.map((_, i) => (
              <button
                key={i}
                onClick={() => setCarouselIndex(i)}
                className={[
                  'h-1.5 rounded-full transition-all',
                  i === carouselIndex ? 'w-4 bg-white' : 'w-1.5 bg-white/50',
                ].join(' ')}
                aria-label={`Slide ${i + 1}`}
              />
            ))}
          </div>
        )}

        {/* Caption + author (bottom-left) */}
        <div className="absolute bottom-3 left-3 right-14 text-white pointer-events-none">
          <div className="text-sm font-semibold drop-shadow">@{handle}</div>
          <div className="mt-1 line-clamp-3 text-[13px] leading-snug drop-shadow whitespace-pre-wrap break-words">
            {body || <span className="text-white/60">Your caption will appear here…</span>}
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 text-[13px] drop-shadow">
            <Music2 size={12} />
            <span className="truncate">original sound - {handle}</span>
          </div>
        </div>

        {/* Right action rail */}
        <div className="absolute bottom-3 right-2 flex flex-col items-center gap-4 text-white pointer-events-none">
          <div className="relative mb-1">
            <div className="h-10 w-10 overflow-hidden rounded-full border-2 border-white bg-gray-300">
              {pictureUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={pictureUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-gray-600">
                  {handle.charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            <span className="absolute -bottom-1.5 left-1/2 flex h-4 w-4 -translate-x-1/2 items-center justify-center rounded-full bg-[#FE2C55]">
              <Plus size={10} className="text-white" strokeWidth={3} />
            </span>
          </div>
          <RailIcon icon={<Heart size={26} fill="white" />} label="0" />
          <RailIcon icon={<MessageCircle size={26} fill="white" />} label="0" />
          <RailIcon icon={<Bookmark size={26} fill="white" />} label="0" />
          <RailIcon icon={<Share2 size={26} fill="white" />} label="0" />
        </div>
      </div>
    </div>
  );
}

function RailIcon({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1 drop-shadow">
      {icon}
      <span className="text-xs font-semibold">{label}</span>
    </div>
  );
}
