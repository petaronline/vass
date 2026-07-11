/**
 * Avatar for an ad account.
 *
 * If a `pictureUrl` is provided, renders that image. Otherwise renders
 * the first letter of the name on a colored circle, deterministic per name.
 *
 * Handles image-load errors by falling back to initials at runtime.
 */
'use client';

import { useState } from 'react';

interface Props {
  name: string;
  pictureUrl: string | null;
  size?: number;
  className?: string;
}

// 8 muted tone-on-tone palettes that don't clash with the electric blue accent
const PALETTES = [
  { bg: '#FEF2F2', fg: '#B91C1C' }, // red
  { bg: '#FFF7ED', fg: '#C2410C' }, // orange
  { bg: '#FEFCE8', fg: '#A16207' }, // yellow
  { bg: '#F0FDF4', fg: '#15803D' }, // green
  { bg: '#ECFEFF', fg: '#0E7490' }, // cyan
  { bg: '#EFF6FF', fg: '#1D4ED8' }, // blue (matches accent)
  { bg: '#F5F3FF', fg: '#6D28D9' }, // violet
  { bg: '#FDF4FF', fg: '#A21CAF' }, // fuchsia
];

function paletteFor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return PALETTES[Math.abs(hash) % PALETTES.length];
}

function initialOf(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '?';
  return trimmed[0].toUpperCase();
}

export function AdAccountAvatar({ name, pictureUrl, size = 24, className }: Props) {
  const [imgFailed, setImgFailed] = useState(false);

  const showImage = pictureUrl && !imgFailed;

  if (showImage) {
    return (
      <img
        src={pictureUrl}
        alt={name}
        width={size}
        height={size}
        onError={() => setImgFailed(true)}
        className={['rounded-full object-cover shrink-0', className].filter(Boolean).join(' ')}
        style={{ width: size, height: size }}
      />
    );
  }

  // Fallback: colored circle with initial
  const palette = paletteFor(name);
  const fontSize = Math.max(10, Math.floor(size * 0.45));

  return (
    <span
      aria-hidden
      className={['inline-flex items-center justify-center rounded-full shrink-0 font-display font-bold', className].filter(Boolean).join(' ')}
      style={{
        width: size,
        height: size,
        backgroundColor: palette.bg,
        color: palette.fg,
        fontSize,
        lineHeight: 1,
      }}
    >
      {initialOf(name)}
    </span>
  );
}
