'use client';

/**
 * AppBackdrop — fixed, full-viewport decorative layer behind every authed
 * page. Three layers, painted bottom-up:
 *
 *   1. Neutral four-corner soft gradient (always on) — gives the app the
 *      "Sketch-style watercolour" backdrop feel.
 *   2. Per-route hue tint, anchored to a different corner per product so
 *      the page feels like it belongs to that tool.
 *   3. A faint dot grid that fades out near the edges via a radial mask.
 *      Gives the app a "design canvas" feel without being noisy.
 *
 * IMPORTANT: layers use POSITIVE z-index, not negative. Negative z-index
 * on fixed-position elements paints behind the root stacking context's
 * background — meaning the layout's own painted background would HIDE
 * them. Positive (or 0) z-index keeps them visible. The actual page
 * content uses `relative z-10` (or higher) to stack above.
 *
 * Ignores pointer events.
 */
import { usePathname } from 'next/navigation';

/** Hue + corner per top-level route. Hues are kept soft so they whisper. */
const ROUTE_TINTS: Array<{ match: RegExp; rgb: string; corner: string }> = [
  // /launch — indigo, top-right
  { match: /^\/launch(\/|$)/,       rgb: '99, 102, 241',  corner: '100% 0%' },
  // /bulk-launch — warm amber, top-left
  { match: /^\/bulk-launch(\/|$)/,  rgb: '251, 191, 36',  corner: '0% 0%' },
  // /sheets — pink-rose, bottom-left
  { match: /^\/sheets(\/|$)/,       rgb: '244, 114, 182', corner: '0% 100%' },
  // /audit — mint, top-left
  { match: /^\/audit(\/|$)/,        rgb: '52, 211, 153',  corner: '0% 0%' },
  // /templates — lilac, bottom-right
  { match: /^\/templates(\/|$)/,    rgb: '167, 139, 250', corner: '100% 100%' },
  // /launches — sky, top-right
  { match: /^\/launches(\/|$)/,     rgb: '125, 211, 252', corner: '100% 0%' },
  // /settings — neutral slate, bottom-right (calm utility area)
  { match: /^\/settings(\/|$)/,     rgb: '148, 163, 184', corner: '100% 100%' },
  // /organic — teal, bottom-left
  { match: /^\/organic(\/|$)/,      rgb: '20, 184, 166',  corner: '0% 100%' },
];

export function AppBackdrop() {
  const pathname = usePathname();
  const tint = ROUTE_TINTS.find((t) => t.match.test(pathname));

  return (
    <>
      {/* Layer 1: neutral four-corner soft watercolour gradient.
          Always paints. Sits at z-index 0 (above the layout's own bg
          fill, below page content). */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          background:
            'radial-gradient(at 0% 0%, rgba(244, 232, 255, 0.6) 0px, transparent 40%), ' +
            'radial-gradient(at 100% 0%, rgba(255, 232, 220, 0.55) 0px, transparent 45%), ' +
            'radial-gradient(at 100% 100%, rgba(220, 240, 255, 0.5) 0px, transparent 45%), ' +
            'radial-gradient(at 0% 100%, rgba(255, 245, 220, 0.45) 0px, transparent 45%)',
        }}
      />

      {/* Layer 2: per-route hue tint. Paints on top of the neutral
          gradient when the route matches a known tool. */}
      {tint && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-0"
          style={{
            background: `radial-gradient(at ${tint.corner}, rgba(${tint.rgb}, 0.22) 0px, transparent 55%)`,
          }}
        />
      )}

      {/* Layer 3: dot grid — 20px spacing. Now actually visible (12%
          opacity). Soft radial mask fades it out near the edges so the
          page doesn't feel boxed-in. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(15, 23, 42, 0.12) 1px, transparent 1.5px)',
          backgroundSize: '20px 20px',
          WebkitMaskImage:
            'radial-gradient(ellipse at center, rgba(0,0,0,1) 0%, rgba(0,0,0,0.6) 70%, transparent 100%)',
          maskImage:
            'radial-gradient(ellipse at center, rgba(0,0,0,1) 0%, rgba(0,0,0,0.6) 70%, transparent 100%)',
        }}
      />
    </>
  );
}
