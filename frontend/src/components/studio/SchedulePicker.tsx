'use client';

/**
 * SchedulePicker — date + time + timezone picker.
 *
 * Used inside ComposerModal when the user picks "Schedule" in the footer.
 * Shape modeled on Sprout's screenshot: explicit Date field, hour/minute
 * selects, timezone dropdown below in an "Advanced" affordance.
 *
 * The selected datetime is held as separate parts (date Y-M-D string,
 * hour 0-23, minute 0-59, IANA TZ name) and the parent composes an
 * ISO string on submit using `Intl.DateTimeFormat` to convert the
 * civil time in the chosen TZ to UTC.
 *
 * No external date library — using vanilla Date and a hand-rolled IANA
 * offset calculator. Keeps the bundle lean.
 */

import { useEffect, useState, useMemo } from 'react';
import { Calendar, Clock, Globe, X } from 'lucide-react';

interface Props {
  open: boolean;
  /** Current scheduled value (ISO string) — used to prefill on reopen. */
  value: string | null;
  onClose: () => void;
  /** Called with the composed ISO string when user confirms. */
  onConfirm: (iso: string) => void;
  /** Lower bound for the time picker. Default = now + 1 minute. */
  minDate?: Date;
}

/** A short, hand-picked list of common IANA zones. The user's browser TZ
 *  is auto-detected and pinned to the top. */
const TIMEZONE_PRESETS = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Belgrade',
  'Europe/Istanbul',
  'Africa/Lagos',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];

/** Compute the UTC offset (ms) for a wall-clock datetime in the given
 *  IANA zone. Used to convert "8:30 PM on May 28 in Europe/Belgrade"
 *  → the right UTC instant.
 *
 *  Strategy: format a UTC date in the target zone via Intl, parse the
 *  parts back, compare to the same UTC date to derive the offset.
 *  This is the standard idiom; no library needed. */
function zonedTimeToUtcIso(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): string {
  // Build a UTC date with the given wall-clock parts.
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  // Format that UTC instant *as displayed in the target zone*. The diff
  // between the displayed wall-clock and our intended wall-clock is the
  // offset we need to subtract to get the true UTC instant.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = fmt.formatToParts(new Date(asIfUtc));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const displayed = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour') === 24 ? 0 : get('hour'),
    get('minute'), get('second')
  );
  const offset = displayed - asIfUtc; // ms the zone is AHEAD of UTC
  const trueUtc = asIfUtc - offset;
  return new Date(trueUtc).toISOString();
}

function formatTzLabel(tz: string): string {
  // Try to get a friendly label like "Belgrade (UTC+02:00)"
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    });
    const part = fmt.formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? '';
    const city = tz.split('/').slice(-1)[0].replace(/_/g, ' ');
    return `${city} (${part || 'UTC'})`;
  } catch {
    return tz;
  }
}

export function SchedulePicker({ open, value, onClose, onConfirm, minDate }: Props) {
  // Pre-fill helpers
  const browserTz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
    catch { return 'UTC'; }
  }, []);

  const fromIso = (iso: string | null): { date: string; hour: number; minute: number } => {
    const d = iso ? new Date(iso) : new Date(Date.now() + 60 * 60 * 1000); // default = 1h from now
    const yyyy = String(d.getFullYear()).padStart(4, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return {
      date: `${yyyy}-${mm}-${dd}`,
      hour: d.getHours(),
      minute: d.getMinutes(),
    };
  };

  const [date, setDate] = useState('');
  const [hour, setHour] = useState(0);
  const [minute, setMinute] = useState(0);
  const [tz, setTz] = useState(browserTz);
  const [advanced, setAdvanced] = useState(false);

  // Reset on open
  useEffect(() => {
    if (!open) return;
    const seed = fromIso(value);
    setDate(seed.date);
    setHour(seed.hour);
    setMinute(seed.minute);
    setTz(browserTz);
    setAdvanced(false);
  }, [open, value, browserTz]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // IMPORTANT: useMemo must come BEFORE any early return so React's
  // hooks-order invariant holds when `open` toggles. Previously this
  // sat below the `if (!open) return null;` and caused the entire app
  // to crash with "Rendered fewer hooks than expected" on close.
  const tzOptions = useMemo(() => {
    const set = new Set<string>([browserTz, ...TIMEZONE_PRESETS]);
    return Array.from(set);
  }, [browserTz]);

  // Early return AFTER all hooks have been registered.
  if (!open) return null;

  const todayStr = (() => {
    const d = minDate ?? new Date();
    const yyyy = String(d.getFullYear()).padStart(4, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  })();

  const handleConfirm = () => {
    if (!date) return;
    const [y, m, d] = date.split('-').map(Number);
    const iso = zonedTimeToUtcIso(y, m, d, hour, minute, tz);
    // Validate it's in the future
    if (new Date(iso).getTime() - Date.now() < 30_000) {
      // Caller will show an error; just bail
      return;
    }
    onConfirm(iso);
  };

  // Preview string showing what we'll send (in the user's local tz for clarity)
  const previewStr = (() => {
    if (!date) return '';
    try {
      const [y, m, d] = date.split('-').map(Number);
      const iso = zonedTimeToUtcIso(y, m, d, hour, minute, tz);
      const dt = new Date(iso);
      return dt.toLocaleString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
    } catch { return ''; }
  })();

  const isPast = (() => {
    if (!date) return false;
    try {
      const [y, m, d] = date.split('-').map(Number);
      const iso = zonedTimeToUtcIso(y, m, d, hour, minute, tz);
      return new Date(iso).getTime() - Date.now() < 30_000;
    } catch { return false; }
  })();

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[min(520px,92vw)] bg-white rounded-lg shadow-glass-lift border border-white/60 overflow-hidden animate-slide-up">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h2 className="h-sub text-ink leading-tight">
            Schedule post
          </h2>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-hover transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Date + time */}
          <div className="grid grid-cols-[1fr_auto_auto] gap-3 items-end">
            <div>
              <label className="block text-xs font-medium uppercase tracking-wider text-ink-subtle mb-1.5">
                <Calendar size={11} className="inline -mt-0.5 mr-1" /> Date
              </label>
              <input
                type="date"
                value={date}
                min={todayStr}
                onChange={(e) => setDate(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-white border border-line rounded-lg focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/15 transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs font-medium uppercase tracking-wider text-ink-subtle mb-1.5">
                <Clock size={11} className="inline -mt-0.5 mr-1" /> Hour
              </label>
              <select
                value={hour}
                onChange={(e) => setHour(Number(e.target.value))}
                className="px-2 py-2 text-sm bg-white border border-line rounded-lg focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/15 transition-colors"
              >
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{String(i).padStart(2, '0')}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium uppercase tracking-wider text-ink-subtle mb-1.5">
                Min
              </label>
              <select
                value={minute}
                onChange={(e) => setMinute(Number(e.target.value))}
                className="px-2 py-2 text-sm bg-white border border-line rounded-lg focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/15 transition-colors"
              >
                {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                  <option key={m} value={m}>{String(m).padStart(2, '0')}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Advanced — timezone */}
          <div>
            <button
              type="button"
              onClick={() => setAdvanced((v) => !v)}
              className="text-xs font-medium text-accent hover:underline flex items-center gap-1"
            >
              <Globe size={11} />
              {advanced ? 'Hide advanced' : 'Advanced (timezone)'}
            </button>
            {advanced && (
              <div className="mt-3">
                <label className="block text-xs font-medium uppercase tracking-wider text-ink-subtle mb-1.5">
                  Time zone
                </label>
                <select
                  value={tz}
                  onChange={(e) => setTz(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-white border border-line rounded-lg focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/15 transition-colors"
                >
                  {tzOptions.map((z) => (
                    <option key={z} value={z}>{formatTzLabel(z)}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Preview */}
          {previewStr && (
            <div className="px-3 py-2.5 bg-accent-subtle border border-accent/20 rounded-lg">
              <div className="text-2xs uppercase tracking-wider font-semibold text-accent mb-0.5">
                Will publish at
              </div>
              <div className="text-sm font-medium text-ink">
                {previewStr}
                <span className="text-ink-subtle ml-2 text-xs">({formatTzLabel(tz)})</span>
              </div>
            </div>
          )}
          {isPast && (
            <p className="text-xs text-warning flex items-center gap-1">
              That time has already passed — pick something further out.
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line bg-surface-alt/30">
          <button
            onClick={onClose}
            className="btn-ghost"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!date || isPast}
            className="btn-primary"
          >
            Schedule
          </button>
        </div>
      </div>
    </div>
  );
}
