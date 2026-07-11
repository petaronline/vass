'use client';

/**
 * StatusPicker — Pipeline filter for post-status buckets.
 *
 * Two checkboxes: Scheduled (covers scheduled + publishing Vass posts)
 * and Published (covers everything already on the platform).
 *
 * Default state: both on. Persists the user's choice via the parent.
 *
 * Visual style mirrors AccountPicker: a single trigger button with a
 * dropdown panel.
 */

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Clock, CheckCircle2 } from 'lucide-react';

export type StatusBucket = 'scheduled' | 'published';

interface Props {
  /** Currently-active buckets. Empty Set = nothing visible (rare, but supported). */
  selected: Set<StatusBucket>;
  onChange: (next: Set<StatusBucket>) => void;
}

export function StatusPicker({ selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

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

  // Summary label for the trigger
  const both = selected.has('scheduled') && selected.has('published');
  const triggerLabel = both
    ? 'All post types'
    : selected.size === 0
      ? 'No types'
      : selected.has('scheduled')
        ? 'Scheduled only'
        : 'Published only';

  const toggle = (b: StatusBucket) => {
    const next = new Set(selected);
    if (next.has(b)) next.delete(b);
    else next.add(b);
    onChange(next);
  };

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
        <div className="absolute left-0 top-full mt-1.5 w-[200px] bg-white border border-line rounded-lg shadow-card z-50 overflow-hidden">
          <Row
            label="Scheduled"
            sub="Upcoming + publishing"
            Icon={Clock}
            checked={selected.has('scheduled')}
            onClick={() => toggle('scheduled')}
          />
          <Row
            label="Published"
            sub="Already on platform"
            Icon={CheckCircle2}
            checked={selected.has('published')}
            onClick={() => toggle('published')}
          />
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  sub,
  Icon,
  checked,
  onClick,
}: {
  label: string;
  sub: string;
  Icon: typeof Clock;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface-hover text-left transition-colors"
    >
      <div
        className={[
          'shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors',
          checked ? 'bg-accent border-accent text-white' : 'bg-white border-line',
        ].join(' ')}
      >
        {checked && <Check size={10} strokeWidth={3} />}
      </div>
      <Icon size={12} className="text-ink-muted shrink-0" />
      <div className="flex flex-col flex-1 min-w-0">
        <span className="text-sm text-ink leading-tight">{label}</span>
        <span className="text-2xs text-ink-subtle leading-tight">{sub}</span>
      </div>
    </button>
  );
}
