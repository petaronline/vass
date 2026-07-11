'use client';

/**
 * Launches list — every launch batch the current user can see.
 *
 * Admins see everyone's launches. Members see their own.
 *
 * Lightweight polling on this list so freshly-created batches show up
 * without a manual refresh.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Rocket, ArrowRight, Clock, CheckCircle2, AlertCircle, AlertTriangle, Trash2, Loader2 } from 'lucide-react';
import { PageHeader, PAGE_TINTS } from '@/components/PageHeader';
import { launches, LaunchBatchSummary, ApiError } from '@/lib/api';

export default function LaunchesPage() {
  const [batches, setBatches] = useState<LaunchBatchSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Clear-history flow:
   *   - idle    → just the button
   *   - confirm → inline "Are you sure?" with Cancel + Confirm
   *   - busy    → spinner on Confirm
   */
  const [clearState, setClearState] = useState<'idle' | 'confirm' | 'busy'>('idle');

  async function loadBatches() {
    try {
      const data = await launches.list();
      setBatches(data.batches);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load launches');
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await launches.list();
        if (!cancelled) {
          setBatches(data.batches);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load launches');
        }
      }
    }
    load();
    // Light polling — refresh list every 5s so progress on running batches
    // shows in the list cards. We don't poll forever; just while page is open.
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  /**
   * Clear all launch history visible to the current user. Doesn't touch
   * the live Meta ads — only Vass's local batch records. In-flight batches
   * are preserved server-side as a safety measure.
   */
  async function handleClearHistory() {
    setClearState('busy');
    try {
      await launches.clearAll();
      await loadBatches();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear history');
    } finally {
      setClearState('idle');
    }
  }

  /** How many batches the Clear button is actually going to wipe (settled only). */
  const settledCount = batches?.filter(
    (b) => b.status !== 'pending' && b.status !== 'running'
  ).length ?? 0;

  return (
    <div>
      <div className="mb-8 flex items-end justify-between gap-4 flex-wrap">
        <PageHeader
          icon={Rocket}
          title="Launches"
          description="Every launch batch with its current status. Click a row for live progress."
          tint={PAGE_TINTS.launches}
        />
        <div className="flex items-center gap-2">
          {/* Clear-history flow: a single button that morphs into a confirm
              prompt. Hidden when there's nothing to clear. */}
          {settledCount > 0 && clearState === 'idle' && (
            <button
              type="button"
              onClick={() => setClearState('confirm')}
              className="btn-ghost text-sm"
              title="Delete every settled batch from Vass (does NOT touch live ads on Meta)"
            >
              <Trash2 size={14} />
              Clear history
            </button>
          )}
          {clearState === 'confirm' && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-red-200 bg-red-50">
              <AlertTriangle size={14} className="text-danger" />
              <span className="text-xs text-ink">
                Delete {settledCount} batch{settledCount === 1 ? '' : 'es'}?
                Live ads on Meta stay running.
              </span>
              <button
                type="button"
                onClick={() => setClearState('idle')}
                className="text-xs text-ink-muted hover:text-ink px-2 py-1"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleClearHistory}
                className="text-xs font-medium text-danger hover:text-red-700 px-2 py-1"
              >
                Yes, clear
              </button>
            </div>
          )}
          {clearState === 'busy' && (
            <div className="flex items-center gap-2 text-xs text-ink-muted px-3 py-1.5">
              <Loader2 size={14} className="animate-spin" /> Clearing…
            </div>
          )}
          <Link href="/launch" className="btn-primary">
            <Rocket size={14} />
            New launch
          </Link>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 px-3 py-2 rounded-lg border border-red-100 bg-red-50 text-sm text-danger">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!batches ? (
        <div className="text-sm text-ink-muted">Loading…</div>
      ) : batches.length === 0 ? (
        <div className="card py-16 text-center">
          <div className="text-sm text-ink-muted mb-3">No launches yet.</div>
          <Link href="/launch" className="btn-primary inline-flex">
            <Rocket size={14} />
            Launch your first ads
          </Link>
        </div>
      ) : (
        <div className="card divide-y divide-line">
          {batches.map((b) => (
            <BatchRow key={b.id} batch={b} />
          ))}
        </div>
      )}
    </div>
  );
}

function BatchRow({ batch }: { batch: LaunchBatchSummary }) {
  const ts = batch.startedAt ?? batch.createdAt;
  const date = new Date(ts);
  const dateStr = date.toLocaleString();
  const inProgress = batch.status === 'pending' || batch.status === 'running';

  return (
    <Link
      href={`/launches/${batch.id}`}
      className="flex items-center gap-4 py-3 px-1 hover:bg-surface-hover -mx-2 px-3 rounded transition-colors"
    >
      <StatusBadge status={batch.status} />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-ink font-medium truncate">
          {batch.name || 'Untitled launch'}
        </div>
        <div className="text-xs text-ink-subtle">
          {batch.adAccountName ?? 'Unknown account'} · {dateStr}
        </div>
      </div>
      <div className="text-xs text-ink-muted whitespace-nowrap text-right">
        <div>
          <span className="text-success font-medium">{batch.totalAdsLaunched}</span>
          {' / '}
          <span>{batch.totalAdsPlanned}</span>
          {' ads'}
          {batch.totalAdsFailed > 0 && (
            <span className="text-danger ml-1">({batch.totalAdsFailed} failed)</span>
          )}
        </div>
        <div className="text-2xs uppercase tracking-wider mt-0.5">
          {inProgress ? 'in progress' : batch.status}
        </div>
      </div>
      <ArrowRight size={14} className="text-ink-subtle shrink-0" />
    </Link>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { icon: any; bg: string; fg: string; label: string }> = {
    pending: { icon: Clock, bg: 'bg-surface-alt', fg: 'text-ink-muted', label: 'pending' },
    running: { icon: Clock, bg: 'bg-accent-subtle', fg: 'text-accent', label: 'running' },
    completed: { icon: CheckCircle2, bg: 'bg-green-50', fg: 'text-success', label: 'done' },
    partial: { icon: AlertTriangle, bg: 'bg-yellow-50', fg: 'text-warning', label: 'partial' },
    failed: { icon: AlertCircle, bg: 'bg-red-50', fg: 'text-danger', label: 'failed' },
  };
  const info = map[status] ?? map.pending;
  const Icon = info.icon;
  return (
    <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${info.bg} ${info.fg}`}>
      <Icon size={16} />
    </div>
  );
}
