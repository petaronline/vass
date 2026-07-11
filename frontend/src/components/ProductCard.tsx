'use client';

/**
 * ProductCard — the tile-style entry-point each Vass tool gets on the
 * dashboard.
 *
 * Look:
 *   - Translucent white surface with backdrop blur (liquid glass on the
 *     tinted page backdrop — you can faintly see the dot grid through it).
 *   - One soft corner-glow in the product's hue. Different corner per card
 *     so cards don't visually align like identical tiles.
 *   - Mouse-tracking glow: a soft radial spotlight in the same hue follows
 *     the cursor across the card. Fades out on leave.
 *   - The icon tile carries a stronger version of the hue.
 *
 * IMPORTANT: this is a client component. The dashboard page is a server
 * component, and server → client prop passing CANNOT transport React
 * components as values (they contain functions, which can't be serialized
 * across the RSC boundary). That's why icons are referenced by string name
 * here and resolved internally via a small registry. If you add a new
 * product, add its icon to `ICON_REGISTRY` below.
 *
 * Status:
 *   - `live`        — clickable, lifts gently on hover, arrow nudges right
 *   - `beta`        — clickable, "Beta" pill in the corner
 *   - `coming-soon` — not clickable, muted opacity, no tracking
 */
import Link from 'next/link';
import {
  ArrowRight,
  Rocket,
  Layers,
  Table2,
  Shield,
  BookCopy,
  History,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';

export type ProductTheme =
  | 'launch'
  | 'bulkLaunch'
  | 'sheets'
  | 'audit'
  | 'templates'
  | 'launches'
  | 'ai';

/**
 * Icon names accepted by ProductCard. Pass a string from the dashboard
 * (server component); we map it to the actual Lucide component here on
 * the client side. Add new entries as products are added.
 */
export type ProductIconName =
  | 'rocket'
  | 'layers'
  | 'table'
  | 'shield'
  | 'book'
  | 'history'
  | 'sparkles';

const ICON_REGISTRY: Record<ProductIconName, LucideIcon> = {
  rocket:   Rocket,
  layers:   Layers,
  table:    Table2,
  shield:   Shield,
  book:     BookCopy,
  history:  History,
  sparkles: Sparkles,
};

type CornerPos = 'tl' | 'tr' | 'bl' | 'br';

interface ProductStyle {
  /** "r, g, b" — used to compose RGBA gradients at varying opacity. */
  rgb: string;
  /** Solid hue for the icon foreground (a darker shade of the same family). */
  iconFg: string;
  /** Which corner the static glow anchors to. Picked so the six cards on
      the dashboard land in different corners and never line up. */
  corner: CornerPos;
}

const CORNER_POS: Record<CornerPos, string> = {
  tl: '0% 0%',
  tr: '100% 0%',
  bl: '0% 100%',
  br: '100% 100%',
};

/**
 * Per-theme styling. Hues are kept soft (rgb values picked from Tailwind's
 * 300-500 range) so the palette feels harmonized rather than carnival.
 */
const STYLES: Record<ProductTheme, ProductStyle> = {
  launch:     { rgb: '99, 102, 241',  iconFg: '#4338CA', corner: 'tr' }, // indigo
  bulkLaunch: { rgb: '251, 191, 36',  iconFg: '#B45309', corner: 'tl' }, // warm amber
  sheets:     { rgb: '244, 114, 182', iconFg: '#BE185D', corner: 'bl' }, // rose-pink
  audit:      { rgb: '52, 211, 153',  iconFg: '#047857', corner: 'br' }, // mint
  templates:  { rgb: '167, 139, 250', iconFg: '#6D28D9', corner: 'br' }, // lilac
  launches:   { rgb: '125, 211, 252', iconFg: '#0369A1', corner: 'tr' }, // sky
  ai:         { rgb: '252, 165, 165', iconFg: '#BE123C', corner: 'bl' }, // peach
};

export function ProductCard({
  theme,
  iconName,
  title,
  tagline,
  href,
  ctaLabel,
  status,
}: {
  theme: ProductTheme;
  /** String key into `ICON_REGISTRY`. Pass the icon by name from the server
      component — passing the icon component itself would crash SSR. */
  iconName: ProductIconName;
  title: string;
  tagline: string;
  href: string;
  ctaLabel: string;
  status: 'live' | 'beta' | 'coming-soon';
}) {
  const isLive = status !== 'coming-soon';
  const s = STYLES[theme];
  const Icon = ICON_REGISTRY[iconName];

  // The static corner glow — always visible, anchors the card's identity.
  const cornerBg = `radial-gradient(at ${CORNER_POS[s.corner]}, rgba(${s.rgb}, 0.22) 0%, transparent 55%)`;

  const block = (
    <div
      className={[
        'relative rounded-lg p-5 flex flex-col h-full overflow-hidden',
        'border border-white/60',
        // Translucent liquid-glass surface — the dot grid faintly shows
        // through. backdrop-blur softens whatever sits behind.
        'bg-white/55 backdrop-blur-card',
      ].join(' ')}
      style={{
        boxShadow:
          '0 1px 2px 0 rgb(0 0 0 / 0.04), ' +
          '0 8px 24px -12px rgb(0 0 0 / 0.06), ' +
          'inset 0 1px 0 0 rgb(255 255 255 / 0.7)',
      }}
    >
      {/* Static corner glow (always on, no animation). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: cornerBg }}
      />

      <div className="relative flex items-start justify-between gap-3 mb-4">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center"
          style={{ background: `rgba(${s.rgb}, 0.18)`, color: s.iconFg }}
        >
          <Icon size={18} strokeWidth={2} />
        </div>
        {status === 'beta' && (
          <span className="text-2xs font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-white/85 text-ink-muted border border-black/[0.08]">
            Beta
          </span>
        )}
        {status === 'coming-soon' && (
          <span className="text-2xs font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-white/85 text-ink-subtle border border-black/[0.08]">
            Soon
          </span>
        )}
      </div>

      <h3 className="relative h-section text-ink mb-1.5">
        {title}
      </h3>
      <p className="relative text-xs text-ink-muted leading-relaxed mb-5 flex-1">
        {tagline}
      </p>
      <div className="relative flex items-center gap-1.5 text-sm font-medium text-ink">
        {ctaLabel}
        {isLive && (
          <ArrowRight
            size={14}
            className="transition-transform group-hover:translate-x-0.5"
          />
        )}
      </div>
    </div>
  );

  const cls = [
    'group block min-h-[180px] rounded-lg',
    isLive
      ? 'transition-transform duration-200 hover:-translate-y-0.5 cursor-pointer'
      : 'opacity-70',
  ].join(' ');

  return isLive ? (
    <Link href={href} className={cls}>
      {block}
    </Link>
  ) : (
    <div className={cls}>{block}</div>
  );
}
