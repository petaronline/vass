'use client';

/**
 * PageHeader (Patch 4.39.0) — the one canonical page header for every
 * top-level page (paid + organic). Standardizes what had drifted apart
 * across Launch / Bulk launch / Sheets / Audit / Dashboard and the
 * organic pages.
 *
 * Layout (matches the old Bulk launch header, positioned like the
 * organic pages):
 *   [icon badge]  Title (text-3xl)            [right-side actions]
 *                 Description (text-sm muted)
 *
 * - `icon` is a Lucide icon component; it renders inside a rounded
 *   square tinted with `tint` (a per-product color).
 * - `actions` is an optional right-aligned slot (toggle, buttons).
 * - `activeOnly` / `onActiveOnlyChange`: when provided, renders the
 *   standardized "Active only" toggle on the right (pages that had the
 *   old "Show active only" / "Active only" toggle).
 */

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Toggle } from '@/components/Toggle';

export interface PageHeaderTint {
  /** Background of the icon badge (e.g. 'rgba(37,99,235,0.14)'). */
  bg: string;
  /** Icon foreground color (e.g. '#1D4ED8'). */
  fg: string;
}

export function PageHeader({
  icon: Icon,
  title,
  description,
  tint,
  actions,
  activeOnly,
  onActiveOnlyChange,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  tint?: PageHeaderTint;
  actions?: ReactNode;
  activeOnly?: boolean;
  onActiveOnlyChange?: (v: boolean) => void;
}) {
  const t = tint ?? { bg: 'rgba(37, 99, 235, 0.14)', fg: '#1D4ED8' };
  const showToggle = typeof activeOnly === 'boolean' && !!onActiveOnlyChange;

  return (
    <header className="flex items-start justify-between gap-4 mb-6 flex-wrap">
      <div className="flex items-start gap-3">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: t.bg, color: t.fg }}
        >
          <Icon size={18} strokeWidth={2} />
        </div>
        <div>
          <h1 className="h-page">{title}</h1>
          {description && (
            <p className="text-sm text-ink-muted mt-1 max-w-2xl">{description}</p>
          )}
        </div>
      </div>

      {(actions || showToggle) && (
        <div className="flex items-center gap-2 shrink-0 mt-1">
          {actions}
          {showToggle && (
            <>
              <span className="text-xs font-medium text-ink-muted select-none">Active only</span>
              <Toggle
                checked={activeOnly!}
                onChange={onActiveOnlyChange!}
                size="sm"
                label="Active only"
              />
            </>
          )}
        </div>
      )}
    </header>
  );
}

/** Per-product tints, matching tailwind.config product.* colors. */
export const PAGE_TINTS = {
  launch:     { bg: 'rgba(37, 99, 235, 0.14)',  fg: '#1D4ED8' },
  bulk:       { bg: 'rgba(251, 191, 36, 0.18)', fg: '#B45309' },
  sheets:     { bg: 'rgba(251, 146, 60, 0.18)', fg: '#EA580C' },
  audit:      { bg: 'rgba(52, 211, 153, 0.18)', fg: '#059669' },
  dashboard:  { bg: 'rgba(99, 102, 241, 0.16)', fg: '#4F46E5' },
  studio:     { bg: 'rgba(16, 185, 129, 0.16)', fg: '#059669' },
  pipeline:   { bg: 'rgba(16, 185, 129, 0.16)', fg: '#059669' },
  drafts:     { bg: 'rgba(100, 116, 139, 0.16)', fg: '#475569' },
  ideas:      { bg: 'rgba(245, 158, 11, 0.16)', fg: '#B45309' },
  analytics:  { bg: 'rgba(13, 148, 136, 0.16)', fg: '#0F766E' },
  templates:  { bg: 'rgba(139, 92, 246, 0.16)', fg: '#6D28D9' },
  launches:   { bg: 'rgba(37, 99, 235, 0.14)', fg: '#1D4ED8' },
  team:       { bg: 'rgba(99, 102, 241, 0.16)', fg: '#4F46E5' },
  accounts:   { bg: 'rgba(16, 185, 129, 0.16)', fg: '#059669' },
  scheduled:  { bg: 'rgba(16, 185, 129, 0.16)', fg: '#059669' },
} as const satisfies Record<string, PageHeaderTint>;
