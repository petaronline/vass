'use client';

/**
 * DateRangePicker — preset ranges + a custom two-month calendar, in the
 * style of Sprout's range picker. Emits {from, to} as Date objects.
 *
 * Presets: Today, Yesterday, Last 7 days (default), Last 30 days, Last 90 days,
 * Month to date, Year to date, Last 12 months. Plus Custom (calendar).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, Check } from 'lucide-react';

export interface DateRange {
  from: Date;
  to: Date;
}

export type PresetId =
  | 'today' | 'yesterday' | 'last7' | 'last30' | 'last90'
  | 'mtd' | 'ytd' | 'last12mo' | 'custom';

const PRESETS: { id: PresetId; label: string }[] = [
  { id: 'today',    label: 'Today' },
  { id: 'yesterday',label: 'Yesterday' },
  { id: 'last7',    label: 'Last 7 days' },
  { id: 'last30',   label: 'Last 30 days' },
  { id: 'last90',   label: 'Last 90 days' },
  { id: 'mtd',      label: 'Month to date' },
  { id: 'ytd',      label: 'Year to date' },
  { id: 'last12mo', label: 'Last 12 months' },
];

function startOfDay(d: Date): Date { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function endOfDay(d: Date): Date { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

export function rangeForPreset(id: PresetId): DateRange {
  const now = new Date();
  const today = startOfDay(now);
  switch (id) {
    case 'today':     return { from: today, to: endOfDay(now) };
    case 'yesterday': return { from: addDays(today, -1), to: endOfDay(addDays(today, -1)) };
    case 'last7':     return { from: addDays(today, -6), to: endOfDay(now) };
    case 'last30':    return { from: addDays(today, -29), to: endOfDay(now) };
    case 'last90':    return { from: addDays(today, -89), to: endOfDay(now) };
    case 'mtd':       return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: endOfDay(now) };
    case 'ytd':       return { from: new Date(now.getFullYear(), 0, 1), to: endOfDay(now) };
    case 'last12mo':  return { from: new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()), to: endOfDay(now) };
    default:          return { from: addDays(today, -6), to: endOfDay(now) };
  }
}

function fmtShort(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function DateRangePicker({
  value,
  preset,
  onChange,
}: {
  value: DateRange;
  preset: PresetId;
  onChange: (range: DateRange, preset: PresetId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [calMonth, setCalMonth] = useState(() => new Date(value.to.getFullYear(), value.to.getMonth(), 1));
  // Custom-range building state: first click sets `from`, second sets `to`.
  const [draftFrom, setDraftFrom] = useState<Date | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const label = useMemo(() => {
    const p = PRESETS.find((x) => x.id === preset);
    if (p) return p.label;
    return `${fmtShort(value.from)} – ${fmtShort(value.to)}`;
  }, [preset, value]);

  const choosePreset = (id: PresetId) => {
    onChange(rangeForPreset(id), id);
    setOpen(false);
  };

  const clickDay = (day: Date) => {
    if (!draftFrom) {
      setDraftFrom(startOfDay(day));
      return;
    }
    // second click completes the range
    let from = draftFrom;
    let to = day;
    if (to < from) [from, to] = [to, from];
    onChange({ from: startOfDay(from), to: endOfDay(to) }, 'custom');
    setDraftFrom(null);
    setOpen(false);
  };

  // Calendar grid for calMonth.
  const grid = useMemo(() => {
    const first = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1);
    const startWeekday = first.getDay();
    const daysInMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 0).getDate();
    const cells: (Date | null)[] = [];
    for (let i = 0; i < startWeekday; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(calMonth.getFullYear(), calMonth.getMonth(), d));
    return cells;
  }, [calMonth]);

  const inRange = (d: Date) =>
    d >= startOfDay(value.from) && d <= endOfDay(value.to);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg bg-white/72 backdrop-blur-card border border-white/60 shadow-subtle text-ink hover:bg-white"
      >
        <CalendarIcon size={14} className="text-ink-muted" />
        {label}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 flex rounded-xl border border-line bg-white shadow-glass overflow-hidden">
          {/* Presets */}
          <div className="w-44 border-r border-line py-2">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => choosePreset(p.id)}
                className={[
                  'flex w-full items-center justify-between px-4 py-2 text-sm text-left hover:bg-black/[0.03]',
                  preset === p.id ? 'text-accent font-medium' : 'text-ink',
                ].join(' ')}
              >
                {p.label}
                {preset === p.id && <Check size={14} />}
              </button>
            ))}
          </div>

          {/* Calendar */}
          <div className="p-3 w-72">
            <div className="flex items-center justify-between mb-2">
              <button
                type="button"
                onClick={() => setCalMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1))}
                className="p-1 rounded hover:bg-black/5"
                aria-label="Previous month"
              >
                <ChevronLeft size={16} />
              </button>
              <div className="text-sm font-medium text-ink">
                {calMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
              </div>
              <button
                type="button"
                onClick={() => setCalMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1))}
                className="p-1 rounded hover:bg-black/5"
                aria-label="Next month"
              >
                <ChevronRight size={16} />
              </button>
            </div>
            <div className="grid grid-cols-7 gap-0.5 text-center text-2xs text-ink-subtle mb-1">
              {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => (
                <div key={d} className="py-1">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-0.5">
              {grid.map((d, i) => {
                if (!d) return <div key={i} />;
                const selected = inRange(d) || (draftFrom && sameDay(d, draftFrom));
                const isToday = sameDay(d, new Date());
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => clickDay(d)}
                    className={[
                      'h-8 text-xs rounded-md transition-colors',
                      selected ? 'bg-accent text-white' : 'text-ink hover:bg-black/5',
                      isToday && !selected ? 'ring-1 ring-accent/40' : '',
                    ].join(' ')}
                  >
                    {d.getDate()}
                  </button>
                );
              })}
            </div>
            {draftFrom && (
              <p className="text-2xs text-ink-muted mt-2">
                Pick the end date (start: {fmtShort(draftFrom)})
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
