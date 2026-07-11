'use client';

/**
 * VideoPlayer — a video that actually plays inline.
 *
 * Before this, video appeared everywhere as a muted static frame with a
 * decorative play icon and no way to play it. This shows the same poster
 * frame, but clicking the play button starts playback with native
 * controls. Used anywhere a video thumbnail appears (drafts, ideas,
 * pipeline, composer preview).
 */
import { useState, useRef } from 'react';
import { PlayCircle } from 'lucide-react';

interface Props {
  src: string;
  /** object-fit for the poster/preview frame. */
  fit?: 'cover' | 'contain';
  className?: string;
  /** When true, render a STATIC poster frame with a non-interactive play
   *  badge — no playback. Used for grid thumbnails / upload-strip tiles
   *  where the video should only play in the detail/preview view. */
  thumbnailOnly?: boolean;
}

export function VideoPlayer({ src, fit = 'cover', className = '', thumbnailOnly = false }: Props) {
  const [playing, setPlaying] = useState(false);
  const ref = useRef<HTMLVideoElement | null>(null);

  const start = () => {
    setPlaying(true);
    requestAnimationFrame(() => {
      ref.current?.play().catch(() => {});
    });
  };

  if (thumbnailOnly) {
    return (
      <div className={`relative w-full h-full ${className}`}>
        <video
          src={src}
          className={`w-full h-full ${fit === 'cover' ? 'object-cover' : 'object-contain'} bg-black pointer-events-none`}
          muted
          playsInline
          preload="metadata"
        />
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <PlayCircle size={32} className="text-white/80 drop-shadow" />
        </div>
      </div>
    );
  }

  return (
    <div className={`relative w-full h-full ${className}`}>
      <video
        ref={ref}
        src={src}
        className={`w-full h-full ${fit === 'cover' ? 'object-cover' : 'object-contain'} bg-black`}
        playsInline
        controls={playing}
        preload="metadata"
        onPause={() => {/* keep controls visible once started */}}
      />
      {!playing && (
        <button
          type="button"
          onClick={start}
          aria-label="Play video"
          className="absolute inset-0 flex items-center justify-center bg-black/10 hover:bg-black/20 transition-colors"
        >
          <PlayCircle size={44} className="text-white/90 drop-shadow" />
        </button>
      )}
    </div>
  );
}
