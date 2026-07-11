/**
 * Vass logo — clean wordmark in Geist Sans with a small upward arrow accent.
 *
 * Approach: keep the full word "Vass" readable, place a small arrow
 * accent to the upper-right (or use it standalone as the mark).
 *
 * Variants:
 *   - "full": "Vass↗" — wordmark + accent arrow
 *   - "mark": just the arrow in a blue square (favicon, sidebar collapsed)
 *   - "wordmark": just "Vass" text, no arrow
 */
import React from 'react';

interface VassLogoProps {
  variant?: 'full' | 'mark' | 'wordmark';
  className?: string;
  height?: number;
  color?: string;
  background?: string;
}

export function VassLogo({
  variant = 'full',
  className = '',
  height = 28,
  color = 'currentColor',
  background = '#2563EB',
}: VassLogoProps) {
  if (variant === 'mark') {
    // Arrow inside a rounded square — for favicon / tight spaces
    return (
      <div
        className={`inline-flex items-center justify-center rounded ${className}`}
        style={{ width: height, height, background }}
        aria-label="Vass"
      >
        <svg
          viewBox="0 0 24 24"
          width={height * 0.6}
          height={height * 0.6}
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            d="M6 18 L18 6 M9 6 L18 6 L18 15"
            stroke="white"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    );
  }

  if (variant === 'wordmark') {
    return (
      <span
        className={className}
        style={{
          color,
          fontFamily: 'var(--font-geist-sans), system-ui, sans-serif',
          fontWeight: 700,
          fontSize: `${height * 0.85}px`,
          letterSpacing: '-0.04em',
          lineHeight: 1,
        }}
      >
        Vass
      </span>
    );
  }

  // Full: wordmark + small arrow accent
  return (
    <div
      className={`inline-flex items-baseline ${className}`}
      style={{ gap: height * 0.08 }}
      aria-label="Vass"
    >
      <span
        style={{
          color,
          fontFamily: 'var(--font-geist-sans), system-ui, sans-serif',
          fontWeight: 700,
          fontSize: `${height * 0.85}px`,
          letterSpacing: '-0.04em',
          lineHeight: 1,
        }}
      >
        Vass
      </span>
      <svg
        viewBox="0 0 24 24"
        width={height * 0.35}
        height={height * 0.35}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        style={{ marginBottom: height * 0.05 }}
      >
        <path
          d="M6 18 L18 6 M9 6 L18 6 L18 15"
          stroke={color}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
