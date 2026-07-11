/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      // ---- Vass design tokens ----
      colors: {
        // Brand
        accent: {
          DEFAULT: '#2563EB',   // Electric blue — primary actions, active states
          hover: '#1D4ED8',     // Slightly darker for hover
          subtle: '#EFF4FE',    // Very pale blue for backgrounds (active row, hover)
          ring: '#93C5FD',      // For focus rings
        },
        // Neutrals
        ink: {
          DEFAULT: '#0A0A0A',   // Near-black, primary text
          muted: '#6B7280',     // Secondary text
          subtle: '#9CA3AF',    // Tertiary text
        },
        surface: {
          DEFAULT: '#FFFFFF',   // Main background
          alt: '#FAFAFA',       // Sidebar, raised panels
          hover: '#F5F5F5',     // Hover states on neutral elements
          // Glass: translucent surfaces over the tinted page background.
          // Use with backdrop-blur for the liquid-glass effect.
          glass: 'rgb(255 255 255 / 0.72)',
          'glass-strong': 'rgb(255 255 255 / 0.88)',
        },
        line: {
          DEFAULT: '#E5E7EB',   // Default borders
          strong: '#D1D5DB',    // Emphasized borders
          glass: 'rgb(255 255 255 / 0.6)', // Inner highlight on glass surfaces
        },
        // ---- Per-product accent tints ----
        // Each surface is intentionally soft — they're whispered hues that
        // tint backgrounds and category cards, not loud brand colors.
        product: {
          // Launch (primary action) — electric blue, matches `accent`
          launch:        '#2563EB',
          'launch-bg':   '#EEF2FF',
          'launch-glow': 'rgba(99, 102, 241, 0.18)',
          // Sheets (bulk import) — warm coral / peach
          sheets:        '#EA580C',
          'sheets-bg':   '#FFF1EA',
          'sheets-glow': 'rgba(251, 146, 60, 0.18)',
          // Audit (analysis) — emerald
          audit:         '#059669',
          'audit-bg':    '#ECFDF5',
          'audit-glow':  'rgba(52, 211, 153, 0.18)',
          // Templates — violet
          templates:        '#7C3AED',
          'templates-bg':   '#F3EEFF',
          'templates-glow': 'rgba(167, 139, 250, 0.18)',
          // Launches history — slate
          launches:         '#475569',
          'launches-bg':    '#F1F5F9',
          'launches-glow':  'rgba(148, 163, 184, 0.18)',
        },
        // Semantic
        success: '#10B981',
        warning: '#F59E0B',
        danger: '#EF4444',
      },
      // ---- Page background gradient stops ----
      // Used in app/(authed)/layout.tsx for the soft Sketch-style backdrop.
      backgroundImage: {
        'app-tint':
          'radial-gradient(at 0% 0%, rgba(244, 232, 255, 0.6) 0px, transparent 40%), ' +
          'radial-gradient(at 100% 0%, rgba(255, 232, 220, 0.55) 0px, transparent 45%), ' +
          'radial-gradient(at 100% 100%, rgba(220, 240, 255, 0.5) 0px, transparent 45%), ' +
          'radial-gradient(at 0% 100%, rgba(255, 245, 220, 0.45) 0px, transparent 45%)',
        // Per-product subtle backdrop. Designed to sit behind feature cards.
        'tint-launch':
          'radial-gradient(at 0% 0%, rgba(99, 102, 241, 0.10) 0px, transparent 60%)',
        'tint-sheets':
          'radial-gradient(at 0% 0%, rgba(251, 146, 60, 0.12) 0px, transparent 60%)',
        'tint-audit':
          'radial-gradient(at 0% 0%, rgba(52, 211, 153, 0.12) 0px, transparent 60%)',
        'tint-templates':
          'radial-gradient(at 0% 0%, rgba(167, 139, 250, 0.12) 0px, transparent 60%)',
        'tint-launches':
          'radial-gradient(at 0% 0%, rgba(148, 163, 184, 0.10) 0px, transparent 60%)',
      },
      fontFamily: {
        // Geist Sans for both display and body — clean, modern, very legible
        // at any size. We keep the `display` alias for headings so existing
        // `font-display` classes throughout the codebase keep working.
        display: ['var(--font-geist-sans)', 'system-ui', 'sans-serif'],
        sans: ['var(--font-geist-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // Tighter scale than Tailwind default — more editorial
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],   // 11px
        'xs':  ['0.75rem',   { lineHeight: '1.125rem' }],
        'sm':  ['0.875rem',  { lineHeight: '1.25rem' }],
        'base':['0.9375rem', { lineHeight: '1.5rem' }], // 15px — slightly more elegant than 16
        'lg':  ['1.0625rem', { lineHeight: '1.625rem' }],
        'xl':  ['1.25rem',   { lineHeight: '1.75rem' }],
        '2xl': ['1.5rem',    { lineHeight: '2rem' }],
        '3xl': ['1.875rem',  { lineHeight: '2.25rem' }],
        '4xl': ['2.25rem',   { lineHeight: '2.5rem', letterSpacing: '-0.02em' }],
        '5xl': ['3rem',      { lineHeight: '1.1',    letterSpacing: '-0.025em' }],
      },
      borderRadius: {
        // Slightly softer than default — but not bubbly
        'sm': '0.375rem',  // 6px — inputs
        'DEFAULT': '0.5rem', // 8px — buttons
        'md': '0.625rem',
        'lg': '0.75rem',   // 12px — cards
        'xl': '1rem',      // 16px — large cards, modals
        '2xl': '1.25rem',  // 20px — product hero cards
      },
      boxShadow: {
        // Restrained — these aren't "glow" shadows
        'subtle': '0 1px 2px 0 rgb(0 0 0 / 0.04)',
        'card':   '0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.04)',
        'lift':   '0 4px 12px -2px rgb(0 0 0 / 0.08), 0 2px 4px -2px rgb(0 0 0 / 0.04)',
        // Glass: very soft drop shadow plus inset top highlight to fake the
        // liquid-glass refraction.
        'glass':
          '0 1px 2px 0 rgb(0 0 0 / 0.04), ' +
          '0 8px 24px -8px rgb(0 0 0 / 0.06), ' +
          'inset 0 1px 0 0 rgb(255 255 255 / 0.7)',
        'glass-lift':
          '0 4px 16px -4px rgb(0 0 0 / 0.08), ' +
          '0 12px 36px -12px rgb(0 0 0 / 0.10), ' +
          'inset 0 1px 0 0 rgb(255 255 255 / 0.7)',
        'focus':  '0 0 0 3px rgb(37 99 235 / 0.15)',
      },
      backdropBlur: {
        // Used by glass surfaces. Tailwind defaults are fine but we expose
        // a "card" shorthand to keep usage consistent.
        'card': '14px',
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'shimmer': 'shimmer 2.4s linear infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
};
