'use client';

/**
 * FeedVideo — a video that mimics how social feeds play video.
 *
 * Real feeds autoplay muted on loop with NO browser control bar; the only
 * affordance is a mute/unmute toggle. This renders exactly that, so the
 * network previews stay faithful (no ugly native <video controls> strip
 * colliding with captions). The mute button is positioned per-network via
 * `mutePosition`.
 */
import { useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';

type Corner = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

interface Props {
  src: string;
  className?: string;
  /** Where the mute toggle sits, to match the network. */
  mutePosition?: Corner;
  /** Rounded corners on the toggle backdrop. */
}

const CORNER_CLASS: Record<Corner, string> = {
  'top-right': 'top-2 right-2',
  'top-left': 'top-2 left-2',
  'bottom-right': 'bottom-2 right-2',
  'bottom-left': 'bottom-2 left-2',
};

export function FeedVideo({ src, className = '', mutePosition = 'bottom-right' }: Props) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [muted, setMuted] = useState(true);

  // Keep the element's muted property in sync with state and (re)start
  // playback — browsers only autoplay while muted.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.muted = muted;
    el.play().catch(() => {});
  }, [muted, src]);

  return (
    <div className="relative h-full w-full">
      <video
        ref={ref}
        src={src}
        className={className || 'h-full w-full object-cover bg-black'}
        autoPlay
        loop
        muted
        playsInline
      />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setMuted((m) => !m);
        }}
        aria-label={muted ? 'Unmute' : 'Mute'}
        className={`absolute ${CORNER_CLASS[mutePosition]} z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/70`}
      >
        {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
      </button>
    </div>
  );
}
