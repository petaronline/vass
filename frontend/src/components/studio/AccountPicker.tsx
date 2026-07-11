'use client';

/**
 * AccountPicker — filterable account-list dropdown for the Pipeline.
 *
 * Replaces the old chip row (which broke at 50+ accounts). Shows:
 *   - A trigger button with summary ("3 of 12 accounts" / "All accounts")
 *   - On click, opens a dropdown panel containing:
 *       • search input (filters the list as you type)
 *       • Select all / Clear buttons
 *       • checklist of accounts with platform icon
 *
 * Accepts a `selected` Set OR null. null = "all selected" (default state).
 * When the user begins toggling, the parent owns whether to flip to a
 * Set or stay null.
 *
 * Only renders when there's >1 account to filter — single-account brands
 * don't need the picker.
 */

import { useEffect, useRef, useState, useMemo } from 'react';
import { Check, ChevronDown, Facebook, Instagram, AtSign, Music2, Linkedin, Search, X } from 'lucide-react';
import type { OrganicAccount, OrganicPlatform } from '@/lib/api';

const PLATFORM_ICONS: Record<OrganicPlatform, { Icon: typeof Facebook; color: string }> = {
  facebook_page: { Icon: Facebook,  color: '#1877F2' },
  instagram:     { Icon: Instagram, color: '#E1306C' },
  threads:       { Icon: AtSign,    color: '#000000' },
  tiktok:        { Icon: Music2,   color: '#000000' },
  linkedin:      { Icon: Linkedin, color: '#0A66C2' },
};

interface Props {
  accounts: OrganicAccount[];
  /** null = all accounts selected (no active filter); Set = explicitly
   *  selected. Empty Set = nothing selected (returns no posts). */
  selected: Set<string> | null;
  onChange: (next: Set<string> | null) => void;
}

export function AccountPicker({ accounts, selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Close on ESC
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Focus search when dropdown opens
  useEffect(() => {
    if (open) {
      // Defer to next frame so the input exists
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setSearch('');
    }
  }, [open]);

  // Derived: how the trigger button summarizes state.
  const allCount = accounts.length;
  const selectedCount = selected === null ? allCount : selected.size;
  const isAll = selected === null;
  const triggerLabel = isAll
    ? `All accounts (${allCount})`
    : selectedCount === 0
      ? 'No accounts'
      : selectedCount === allCount
        ? `All accounts (${allCount})`
        : `${selectedCount} of ${allCount} accounts`;

  // Filtered list (by search query).
  const accountLabel = (a: OrganicAccount): string =>
    a.meta?.name || a.meta?.username || '(account)';

  const filtered = useMemo(() => {
    if (!search.trim()) return accounts;
    const q = search.trim().toLowerCase();
    return accounts.filter((a) => accountLabel(a).toLowerCase().includes(q));
  }, [accounts, search]);

  // ─── Actions ───
  const isSelected = (id: string) => isAll || (selected as Set<string>).has(id);

  const toggle = (id: string) => {
    if (isAll) {
      // First click on a checked-by-default item: uncheck just that one,
      // implicitly turning "all" into "all minus this one".
      const next = new Set(accounts.map((a) => a.id));
      next.delete(id);
      onChange(next.size === allCount ? null : next);
      return;
    }
    const next = new Set(selected as Set<string>);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // If user re-selects everything, collapse to null ("all").
    onChange(next.size === allCount ? null : next);
  };

  const selectAll = () => onChange(null);
  const clearAll = () => onChange(new Set());

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-secondary btn-sm"
      >
        <span>{triggerLabel}</span>
        <ChevronDown size={13} className="text-ink-subtle" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1.5 w-[320px] bg-white border border-line rounded-lg shadow-card z-50 flex flex-col overflow-hidden">
          {/* Search */}
          <div className="relative px-3 py-2 border-b border-line">
            <Search size={12} className="absolute left-5 top-1/2 -translate-y-1/2 text-ink-subtle pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search accounts…"
              className="w-full pl-6 pr-7 py-1 text-sm bg-transparent border-none focus:outline-none placeholder-ink-subtle"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-4 top-1/2 -translate-y-1/2 p-0.5 rounded text-ink-subtle hover:text-ink"
              >
                <X size={11} />
              </button>
            )}
          </div>

          {/* Bulk actions */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-line bg-surface-alt/30">
            <button
              onClick={selectAll}
              className="text-xs font-medium text-accent hover:underline"
            >
              Select all
            </button>
            <button
              onClick={clearAll}
              className="text-xs font-medium text-ink-muted hover:text-ink"
            >
              Clear
            </button>
          </div>

          {/* List */}
          <div className="overflow-y-auto max-h-[300px]">
            {filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-ink-subtle">
                No accounts match "{search}"
              </div>
            ) : (
              filtered.map((a) => {
                const cfg = PLATFORM_ICONS[a.platform];
                const Icon = cfg?.Icon;
                const checked = isSelected(a.id);
                return (
                  <button
                    key={a.id}
                    onClick={() => toggle(a.id)}
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface-hover text-left transition-colors"
                  >
                    {/* Checkbox */}
                    <div
                      className={[
                        'shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors',
                        checked
                          ? 'bg-accent border-accent text-white'
                          : 'bg-white border-line',
                      ].join(' ')}
                    >
                      {checked && <Check size={10} strokeWidth={3} />}
                    </div>
                    {/* Platform icon */}
                    {Icon && (
                      <Icon size={12} style={{ color: cfg.color }} className="shrink-0" />
                    )}
                    {/* Label */}
                    <span className="text-sm text-ink truncate flex-1">
                      {accountLabel(a)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
