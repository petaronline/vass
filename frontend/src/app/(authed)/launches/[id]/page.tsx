'use client';

/**
 * Live launch progress page.
 *
 * Polls the backend every 2s while there's anything in flight. Stops polling
 * once everything has settled (completed, partial, or failed).
 *
 * Per-ad rows show: status icon, ad name, ad set ID, attempt count, error msg.
 * Failed ads get an inline "Edit" button that opens a modal pre-filled with
 * the ad's stored copy/CTA/URL. Submitting the modal merges the overrides
 * into the stored payload and re-queues the job. "Retry all failed" at the
 * top retries every failed ad as-is.
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  Rocket,
  Clock,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  RefreshCw,
  ArrowLeft,
  Pencil,
  X,
} from 'lucide-react';
import { PageHeader, PAGE_TINTS } from '@/components/PageHeader';
import {
  launches,
  adLaunches,
  LaunchBatchSummary,
  AdLaunchSummary,
  AdLaunchDetail,
  ApiError,
  META_CTAS,
  DEFAULT_META_CTA,
  ctasForObjective,
  defaultCtaForObjective,
} from '@/lib/api';

const POLL_MS = 2000;

export default function LaunchDetailPage() {
  const params = useParams<{ id: string }>();
  const batchId = params?.id as string;

  const [batch, setBatch] = useState<LaunchBatchSummary | null>(null);
  const [ads, setAds] = useState<AdLaunchSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retryingAll, setRetryingAll] = useState(false);

  /** When non-null, the Edit modal is open for this ad-launch id. */
  const [editingId, setEditingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await launches.get(batchId);
      setBatch(data.batch);
      setAds(data.adLaunches);
      setError(null);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load launch');
      setLoading(false);
    }
  }, [batchId]);

  // Initial load
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Polling — only while something's in flight
  useEffect(() => {
    if (!batch) return;
    const inFlight =
      batch.status === 'pending' || batch.status === 'running';
    if (!inFlight) return;
    const i = setInterval(refresh, POLL_MS);
    return () => clearInterval(i);
  }, [batch, refresh]);

  async function retryAll() {
    setRetryingAll(true);
    try {
      await launches.retryFailed(batchId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry all failed');
    } finally {
      setRetryingAll(false);
    }
  }

  if (loading) {
    return (
      <div>
        <div className="text-sm text-ink-muted">Loading…</div>
      </div>
    );
  }

  if (!batch) {
    return (
      <div>
        <div className="card py-12 text-center">
          <AlertCircle size={20} className="text-danger mx-auto mb-2" />
          <div className="text-sm text-ink">Launch not found.</div>
          <Link href="/launches" className="text-xs text-accent mt-2 inline-block">
            Back to launches
          </Link>
        </div>
      </div>
    );
  }

  const failed = ads.filter((a) => a.status === 'failed');
  const succeeded = ads.filter((a) => a.status === 'success').length;
  const total = ads.length;
  const progress = total > 0 ? Math.round((succeeded / total) * 100) : 0;

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/launches"
          className="inline-flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink mb-3"
        >
          <ArrowLeft size={12} />
          Back to launches
        </Link>

        <div className="flex items-start justify-between gap-4">
          <PageHeader
            icon={Rocket}
            title={batch.name || 'Untitled launch'}
            description={`${batch.adAccountName} · launched ${batch.startedAt ? new Date(batch.startedAt).toLocaleString() : ''}`}
            tint={PAGE_TINTS.launches}
          />
          {failed.length > 0 && (
            <button
              onClick={retryAll}
              disabled={retryingAll}
              className="btn-secondary"
            >
              <RefreshCw size={14} className={retryingAll ? 'animate-spin' : ''} />
              {retryingAll ? 'Retrying…' : `Retry all ${failed.length} failed`}
            </button>
          )}
        </div>

        {/* Progress bar */}
        <div className="mt-5">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <div className="text-ink-muted">
              <span className="text-ink font-medium">{succeeded}</span> of {total} ads launched
              {failed.length > 0 && (
                <span className="text-danger ml-2">({failed.length} failed)</span>
              )}
            </div>
            <div className="text-ink-muted">{progress}%</div>
          </div>
          <div className="h-1.5 bg-surface-alt rounded-full overflow-hidden">
            <div
              className="h-full bg-accent transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 px-3 py-2 rounded-lg border border-red-100 bg-red-50 text-sm text-danger">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Ads table */}
      <div className="card divide-y divide-line">
        {ads.map((ad) => (
          <AdLaunchRow
            key={ad.id}
            ad={ad}
            onEdit={() => setEditingId(ad.id)}
          />
        ))}
      </div>

      {/* Edit & retry modal */}
      {editingId && (
        <EditAdLaunchModal
          adLaunchId={editingId}
          onClose={() => setEditingId(null)}
          onSubmitted={async () => {
            setEditingId(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function AdLaunchRow({
  ad,
  onEdit,
}: {
  ad: AdLaunchSummary;
  onEdit: () => void;
}) {
  const showEdit = ad.status === 'failed';
  return (
    <div className="flex items-start gap-3 py-3 px-3 -mx-2 hover:bg-surface-hover transition-colors">
      <AdStatusIcon status={ad.status} />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-ink font-medium truncate">{ad.adName}</div>
        <div className="text-xs text-ink-subtle">
          Ad set {ad.adSetId} · attempts: {ad.attempts}
          {ad.metaAdId && <> · Meta ad ID: <span className="text-ink">{ad.metaAdId}</span></>}
        </div>
        {ad.errorMessage && (
          <div className="mt-1.5 text-xs text-danger px-2 py-1 bg-red-50 rounded border border-red-100">
            {ad.errorMessage}
            {/* Subcode hint — surface a friendlier explanation for known
                Meta subcodes that aren't self-explanatory. */}
            {ad.errorMessage.includes('1346001') && (
              <div className="mt-1.5 text-2xs text-danger/80 italic">
                Hint: this usually means the CTA isn't allowed for the campaign's
                objective (e.g. SHOP_NOW on a lead-gen ad set). Click Edit and
                try a different CTA like LEARN_MORE, GET_QUOTE, or SIGN_UP.
              </div>
            )}
          </div>
        )}
      </div>
      {showEdit && (
        <button onClick={onEdit} className="btn-secondary text-xs py-1 px-2.5 shrink-0">
          <Pencil size={12} />
          Edit & retry
        </button>
      )}
    </div>
  );
}

/**
 * Modal that fetches the current ad-launch payload, lets the user edit copy/
 * CTA/URL, and re-queues the ad with the overrides merged into the payload.
 */
function EditAdLaunchModal({
  adLaunchId,
  onClose,
  onSubmitted,
}: {
  adLaunchId: string;
  onClose: () => void;
  onSubmitted: () => Promise<void> | void;
}) {
  const [detail, setDetail] = useState<AdLaunchDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Form state — mirrors the detail's copy fields
  const [adName, setAdName] = useState('');
  const [message, setMessage] = useState('');
  const [headline, setHeadline] = useState('');
  const [description, setDescription] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [cta, setCta] = useState(DEFAULT_META_CTA);
  const [urlTags, setUrlTags] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    adLaunches
      .get(adLaunchId)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setAdName(d.creativeName ?? d.adName ?? '');
        setMessage(d.copy.message ?? '');
        setHeadline(d.copy.headline ?? '');
        setDescription(d.copy.description ?? '');
        setLinkUrl(d.copy.linkUrl ?? '');
        setUrlTags(d.copy.urlTags ?? '');
        // Pre-fill CTA: keep the existing value if any; otherwise use the
        // objective's recommended default (e.g. SHOP_NOW for sales,
        // LEARN_MORE for leads/awareness).
        setCta(d.copy.callToActionType || defaultCtaForObjective(d.objective));
      })
      .catch((e) => setErr(e instanceof Error ? e.message : 'Load failed'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [adLaunchId]);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      await adLaunches.retry(adLaunchId, {
        copy: {
          message,
          headline,
          description,
          linkUrl,
          callToActionType: cta,
          urlTags: urlTags.trim(),
        },
        creativeName: adName,
      });
      await onSubmitted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Submit failed');
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-4 pt-12"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg border border-line shadow-xl w-full max-w-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <div>
            <h2 className="h-sub text-ink flex items-center gap-2">
              <Pencil size={16} /> Edit &amp; retry
            </h2>
            {detail && (
              <div className="text-xs text-ink-subtle mt-0.5 truncate">
                {detail.adName}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-surface-alt text-ink-muted hover:text-ink"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-4 py-4 space-y-3">
          {loading ? (
            <div className="text-sm text-ink-muted py-6 text-center">
              <Loader2 size={16} className="animate-spin inline mr-2" /> Loading current values…
            </div>
          ) : err && !detail ? (
            <div className="text-sm text-danger">{err}</div>
          ) : (
            <>
              <Field label="Ad name">
                <input
                  type="text"
                  value={adName}
                  onChange={(e) => setAdName(e.target.value)}
                  className="input w-full text-sm"
                />
              </Field>
              <Field label="Primary text (body)">
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  className="input w-full text-sm resize-y"
                />
              </Field>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Headline">
                  <input
                    type="text"
                    value={headline}
                    onChange={(e) => setHeadline(e.target.value)}
                    className="input w-full text-sm"
                  />
                </Field>
                <Field label="Description">
                  <input
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="input w-full text-sm"
                  />
                </Field>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label={detail?.objective ? `CTA (${formatObjective(detail.objective)})` : 'CTA (required)'}>
                  <select
                    value={cta}
                    onChange={(e) => setCta(e.target.value)}
                    className="input w-full text-sm bg-surface"
                  >
                    {ctasForObjective(detail?.objective ?? null).map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                    {/* If the current CTA isn't in the allowed list for this
                        objective, still show it so the user sees what's there —
                        but mark it as risky. */}
                    {cta && detail?.objective &&
                      !ctasForObjective(detail.objective).some((c) => c.value === cta) && (
                        <option value={cta}>⚠ {cta} — may be rejected by Meta</option>
                      )}
                  </select>
                </Field>
                <Field label="Link URL">
                  <input
                    type="url"
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    className="input w-full text-sm"
                    placeholder="https://"
                  />
                </Field>
              </div>

              <Field label="URL parameters (UTM tracking, optional)">
                <input
                  type="text"
                  value={urlTags}
                  onChange={(e) => setUrlTags(e.target.value)}
                  className="input w-full text-sm font-mono"
                  placeholder="utm_source=fb&utm_medium=cpc&utm_campaign=spring"
                  maxLength={500}
                />
                <div className="text-2xs text-ink-subtle mt-1 leading-relaxed">
                  Meta appends these to the destination URL on click. Leave
                  blank to skip.
                </div>
              </Field>

              {err && (
                <div className="text-sm text-danger flex items-start gap-1.5">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" /> {err}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-line bg-surface-alt/30">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="btn-secondary text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={loading || submitting}
            className="btn-primary text-sm"
          >
            {submitting ? (
              <><Loader2 size={14} className="animate-spin" /> Submitting…</>
            ) : (
              <><RefreshCw size={14} /> Save &amp; retry</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
        {label}
      </div>
      {children}
    </label>
  );
}

/**
 * Format a Meta ODAX objective string for display next to the CTA dropdown,
 * so the user knows why the list is filtered. e.g. "OUTCOME_LEADS" → "Leads".
 */
function formatObjective(obj: string): string {
  const map: Record<string, string> = {
    OUTCOME_AWARENESS: 'Awareness',
    OUTCOME_TRAFFIC: 'Traffic',
    OUTCOME_ENGAGEMENT: 'Engagement',
    OUTCOME_LEADS: 'Leads',
    OUTCOME_APP_PROMOTION: 'App promotion',
    OUTCOME_SALES: 'Sales',
  };
  return map[obj] ?? obj;
}

function AdStatusIcon({ status }: { status: string }) {
  if (status === 'success') {
    return (
      <div className="w-7 h-7 rounded-full bg-green-50 text-success flex items-center justify-center shrink-0">
        <CheckCircle2 size={14} />
      </div>
    );
  }
  if (status === 'failed') {
    return (
      <div className="w-7 h-7 rounded-full bg-red-50 text-danger flex items-center justify-center shrink-0">
        <XCircle size={14} />
      </div>
    );
  }
  if (status === 'launching') {
    return (
      <div className="w-7 h-7 rounded-full bg-accent-subtle text-accent flex items-center justify-center shrink-0">
        <Loader2 size={14} className="animate-spin" />
      </div>
    );
  }
  return (
    <div className="w-7 h-7 rounded-full bg-surface-alt text-ink-muted flex items-center justify-center shrink-0">
      <Clock size={14} />
    </div>
  );
}
