'use client';

/**
 * Bulk Launch — drop many creatives at once, auto-detect each file's
 * aspect from its actual pixel dimensions, auto-group files into ads by
 * filename stem (with aspect-y tokens stripped). Default copy applies to
 * every ad, with per-ad overrides via the edit modal.
 *
 * Layout (≥lg viewports):
 *
 *   +-------------------------+  +---------------+
 *   |  Where                  |  | Summary       |
 *   |  Media + ads table      |  | (sticky right |
 *   |  Default copy           |  |  rail with    |
 *   |  Naming & status        |  |  Launch CTA)  |
 *   +-------------------------+  +---------------+
 *
 * Backend: this whole page produces the same LaunchSpec the /launch
 * page does. No new endpoints. Each "ad" maps to one LaunchCreativeSpec
 * with `uploadIds` covering all non-null aspect slots.
 */

import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2,
  AlertTriangle,
  Edit3,
  X,
  Upload as UploadIcon,
  Layers as LayersIcon,
  Trash2,
  Info,
  Sparkles,
  Rocket,
  CheckCircle2,
} from 'lucide-react';
import {
  adAccounts,
  metaExplore,
  uploads as uploadsApi,
  launches,
  AdAccount,
  MetaCampaign,
  MetaAdSet,
  Upload,
  DesiredAdStatus,
  LaunchCopySpec,
  META_CTAS,
  DEFAULT_META_CTA,
  AD_NAME_PLACEHOLDERS,
  DEFAULT_AD_NAME_TEMPLATE,
} from '@/lib/api';
import {
  getActiveAdAccountIds,
  VASS_ACTIVE_SCOPE_EVENT,
} from '@/components/BrandSelector';
import { PageHeader, PAGE_TINTS } from '@/components/PageHeader';
import {
  pairProbedFiles,
  probeDimensions,
  classifyAspect,
  pairKeyFromFilename,
  ASPECT_LABEL,
  type Aspect,
  type ProbedFile,
  type PairedAd,
} from '@/lib/aspect-pairing';

// =====================================================================
// Page component
// =====================================================================

export default function BulkLaunchPage() {
  const router = useRouter();

  // ----- Where -----
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [allAccounts, setAllAccounts] = useState<AdAccount[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);

  const [campaigns, setCampaigns] = useState<MetaCampaign[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [campaignId, setCampaignId] = useState<string | null>(null);

  const [adSets, setAdSets] = useState<MetaAdSet[]>([]);
  const [adSetsLoading, setAdSetsLoading] = useState(false);
  const [adSetId, setAdSetId] = useState<string | null>(null);

  // ----- Media -----
  /**
   * Source of truth for media. Each entry is a fully-probed file
   * (uploaded, classified, with a pair key). The `ads` derived value
   * regroups these on every change.
   */
  const [probedFiles, setProbedFiles] = useState<ProbedFile[]>([]);
  /** uploadId → original Upload metadata (e.g. thumbnails if needed). */
  const [uploadMeta, setUploadMeta] = useState<Map<string, Upload>>(new Map());
  /** Local-id → progress (0..1) for the running upload bars. */
  const [uploadProgress, setUploadProgress] = useState<Map<string, { name: string; progress: number }>>(new Map());
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // ----- Default copy -----
  const [primaryText, setPrimaryText] = useState('');
  const [headline, setHeadline] = useState('');
  const [description, setDescription] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [cta, setCta] = useState<string>(DEFAULT_META_CTA);
  const [urlTags, setUrlTags] = useState('');

  // ----- Per-ad overrides + ad-id-level remove tracking -----
  /**
   * Overrides keyed by ad.id. The ad.id is derived from pair-key during
   * pairing — stable across re-pairing as long as the same pair-key
   * shows up, which is true when files keep their names. If the user
   * renames or re-uploads, overrides may detach; that's an acceptable
   * trade-off for keeping the model simple.
   */
  const [overrides, setOverrides] = useState<Map<string, Partial<LaunchCopySpec> & { adName?: string }>>(new Map());

  // ----- Naming + status -----
  const [batchName, setBatchName] = useState('');
  const [adNameTemplate, setAdNameTemplate] = useState(DEFAULT_AD_NAME_TEMPLATE);
  const [desiredStatus, setDesiredStatus] = useState<DesiredAdStatus>('DRAFT');

  // ----- Submit state -----
  const [editingAdId, setEditingAdId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // =====================================================================
  // Derived: pair files into ads. Recomputed on every probedFiles change.
  // Pairing is deterministic for the same inputs so ad.id is stable
  // enough for the overrides map to stay valid through normal flows.
  // =====================================================================
  const { ads } = useMemo(() => pairProbedFiles(probedFiles), [probedFiles]);

  // =====================================================================
  // Effects
  // =====================================================================

  useEffect(() => {
    let cancelled = false;
    adAccounts.list(false)
      .then((accs) => !cancelled && setAllAccounts(accs.accounts))
      .finally(() => !cancelled && setAccountsLoading(false));
    return () => { cancelled = true; };
  }, []);

  // Patch 4.38.0: pre-select the ad account from the shared scope when
  // it resolves to one. Persists the brand/ad-account selection the
  // user made elsewhere in the app.
  useEffect(() => {
    if (allAccounts.length === 0) return;
    const apply = () => {
      const ids = getActiveAdAccountIds(
        allAccounts.map((a) => ({ id: a.id, brandId: a.brandId }))
      );
      if (ids && ids.length > 0) {
        setAccountId((cur) => (cur && ids.includes(cur) ? cur : ids[0]));
      }
    };
    apply();
    const onChange = () => apply();
    window.addEventListener(VASS_ACTIVE_SCOPE_EVENT, onChange);
    return () => window.removeEventListener(VASS_ACTIVE_SCOPE_EVENT, onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allAccounts]);

  useEffect(() => {
    if (!accountId) { setCampaigns([]); setCampaignId(null); return; }
    setCampaignsLoading(true);
    setCampaignId(null);
    setAdSets([]);
    setAdSetId(null);
    metaExplore.listCampaigns(accountId)
      .then((r) => setCampaigns(r.campaigns))
      .finally(() => setCampaignsLoading(false));
  }, [accountId]);

  useEffect(() => {
    if (!campaignId) { setAdSets([]); setAdSetId(null); return; }
    setAdSetsLoading(true);
    setAdSetId(null);
    metaExplore.listAdSets(campaignId)
      .then((r) => setAdSets(r.adSets))
      .finally(() => setAdSetsLoading(false));
  }, [campaignId]);

  // =====================================================================
  // File handling
  // =====================================================================

  /**
   * Upload + probe a single file. Manages the per-file progress UI and
   * returns a ProbedFile record when both steps succeed. The caller is
   * responsible for inserting that record into `probedFiles` (with any
   * overrides applied — e.g. forcing pairKey / aspect for a manual slot
   * assignment).
   */
  const uploadAndProbe = useCallback(async (file: File): Promise<ProbedFile | null> => {
    const localId = `pending_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    setUploadProgress((prev) => new Map(prev).set(localId, { name: file.name, progress: 0 }));
    try {
      // 1. Probe dimensions BEFORE uploading. If probing fails (corrupt
      //    file, unsupported codec), we still upload but treat it as
      //    landscape so the user can still launch it manually.
      let probe: { width: number; height: number } | null = null;
      try {
        probe = await probeDimensions(file);
      } catch (err) {
        console.warn('Probe failed:', file.name, err);
      }

      // 2. Upload.
      const { upload } = await uploadsApi.upload(file, (p) => {
        setUploadProgress((prev) => {
          const next = new Map(prev);
          const cur = next.get(localId);
          if (cur) next.set(localId, { ...cur, progress: p });
          return next;
        });
      });

      // 3. Build the probed-file record.
      const width  = probe?.width  ?? 1080;
      const height = probe?.height ?? 1080;
      setUploadMeta((prev) => new Map(prev).set(upload.id, upload));
      return {
        uploadId: upload.id,
        filename: upload.filename,
        width,
        height,
        aspect: probe ? classifyAspect(width, height) : 'landscape',
        pairKey: pairKeyFromFilename(upload.filename),
      };
    } catch (err) {
      console.error('Upload failed:', file.name, err);
      setSubmitError(`Upload failed for ${file.name}: ${err instanceof Error ? err.message : 'unknown'}`);
      return null;
    } finally {
      setUploadProgress((prev) => {
        const next = new Map(prev);
        next.delete(localId);
        return next;
      });
    }
  }, []);

  const handleFiles = useCallback(async (files: FileList) => {
    setUploading(true);
    setSubmitError(null);

    const arr = Array.from(files);
    const CONCURRENCY = 3;
    let cursor = 0;
    const newProbed: ProbedFile[] = [];

    async function worker() {
      while (cursor < arr.length) {
        const file = arr[cursor++];
        const probed = await uploadAndProbe(file);
        if (probed) newProbed.push(probed);
      }
    }

    await Promise.all(Array(CONCURRENCY).fill(0).map(() => worker()));
    setProbedFiles((prev) => [...prev, ...newProbed]);
    setUploading(false);
  }, [uploadAndProbe]);

  /**
   * Upload + probe a single file, then assign it explicitly to the
   * targetAspect slot on the given ad. We override the file's pairKey
   * to match the ad's pairKey (so auto-pairing places it on the same
   * ad) and force its aspect bucket to targetAspect (so it lands in
   * the slot the user clicked, regardless of detected dimensions).
   *
   * The chip still displays the file's real dimensions so the user can
   * see if they uploaded something off-shape.
   */
  const handleAddToSlot = useCallback(async (
    ad: PairedAd,
    targetAspect: Aspect,
    file: File
  ) => {
    setUploading(true);
    setSubmitError(null);
    const probed = await uploadAndProbe(file);
    if (probed) {
      setProbedFiles((prev) => [
        ...prev,
        {
          ...probed,
          // Force the slot — user picked it deliberately.
          aspect: targetAspect,
          // Force the pair key so it groups with the target ad.
          pairKey: ad.pairKey,
        },
      ]);
    }
    setUploading(false);
  }, [uploadAndProbe]);

  function removeAd(ad: PairedAd) {
    // Drop the ad's overrides and remove its underlying probed files.
    const uploadIds = new Set<string>(
      (Object.values(ad.slots).filter(Boolean) as string[])
    );
    setProbedFiles((prev) => prev.filter((p) => !uploadIds.has(p.uploadId)));
    setOverrides((prev) => {
      const next = new Map(prev);
      next.delete(ad.id);
      return next;
    });
  }

  function removeFileFromAd(ad: PairedAd, aspect: Aspect) {
    const uploadId = ad.slots[aspect];
    if (!uploadId) return;
    setProbedFiles((prev) => prev.filter((p) => p.uploadId !== uploadId));
  }

  // =====================================================================
  // Submit
  // =====================================================================

  const adSet = useMemo(() => adSets.find((a) => a.id === adSetId) ?? null, [adSets, adSetId]);
  const account = useMemo(() => allAccounts.find((a) => a.id === accountId) ?? null, [allAccounts, accountId]);
  const campaign = useMemo(() => campaigns.find((c) => c.id === campaignId) ?? null, [campaigns, campaignId]);

  const validation = useMemo(() => {
    const errors: string[] = [];
    if (!accountId)  errors.push('Pick an ad account');
    if (!campaignId) errors.push('Pick a campaign');
    if (!adSetId)    errors.push('Pick an ad set');
    if (ads.length === 0) errors.push('Add at least one creative');
    if (!primaryText.trim()) errors.push('Default primary text is required');
    if (!linkUrl.trim())     errors.push('Default link URL is required');
    return errors;
  }, [accountId, campaignId, adSetId, ads, primaryText, linkUrl]);

  async function handleSubmit() {
    if (validation.length > 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const baseCopy: LaunchCopySpec = {
        message:          primaryText.trim(),
        headline:         headline.trim()    || undefined,
        description:      description.trim() || undefined,
        linkUrl:          linkUrl.trim(),
        callToActionType: cta,
        urlTags:          urlTags.trim()     || undefined,
      };
      const result = await launches.create({
        adAccountId: accountId!,
        batchName: batchName.trim() || `Bulk launch ${new Date().toLocaleString()}`,
        desiredAdStatus: desiredStatus,
        adSets: [{ adSetId: adSetId!, adSetName: adSet?.name ?? '' }],
        creatives: ads.map((ad) => {
          const ovr = overrides.get(ad.id);
          const uploadIds = (Object.values(ad.slots).filter(Boolean) as string[]);
          return {
            uploadIds,
            creativeName: ovr?.adName?.trim() || ad.pairKey,
            copyOverride: ovr ? stripEmpty({
              message:          ovr.message,
              headline:         ovr.headline,
              description:      ovr.description,
              linkUrl:          ovr.linkUrl,
              callToActionType: ovr.callToActionType,
              urlTags:          ovr.urlTags,
            }) : undefined,
          };
        }),
        copy: baseCopy,
        adNameTemplate,
      });
      router.push(`/launches/${result.batchId}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submit failed');
      setSubmitting(false);
    }
  }

  // =====================================================================
  // Render
  // =====================================================================

  if (accountsLoading) {
    return (
      <div className="w-full">
        <div className="card flex items-center gap-2 text-sm text-ink-muted">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      </div>
    );
  }

  const enabledAccounts = allAccounts.filter((a) => a.isEnabled && a.status === 'active');

  return (
    <div className="w-full pb-12">
      {/* Page header */}
      <PageHeader
        icon={LayersIcon}
        title="Bulk launch"
        description="Drop many creatives. Vass detects each file's aspect by its dimensions and groups files into ads by filename."
        tint={PAGE_TINTS.bulk}
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 lg:items-start">
        {/* ===== Main column ===== */}
        <div className="space-y-6 min-w-0">
          {/* 1. Where */}
          <section className="card space-y-4">
            <h2 className="h-sub text-ink">Where</h2>

            <Field label="Ad account">
              {enabledAccounts.length === 0 ? (
                <div className="text-sm text-ink-muted">
                  No enabled ad accounts. Visit{' '}
                  <a href="/settings/ad-accounts" className="text-accent">Settings → Ad accounts</a>{' '}
                  to enable some.
                </div>
              ) : (
                <select
                  value={accountId ?? ''}
                  onChange={(e) => setAccountId(e.target.value || null)}
                  className="input"
                >
                  <option value="">Choose an ad account…</option>
                  {enabledAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>
                  ))}
                </select>
              )}
            </Field>

            {accountId && (
              <Field label="Campaign">
                {campaignsLoading ? (
                  <Loading text="Loading campaigns…" />
                ) : campaigns.length === 0 ? (
                  <div className="text-sm text-ink-muted">No campaigns in this ad account.</div>
                ) : (
                  <select
                    value={campaignId ?? ''}
                    onChange={(e) => setCampaignId(e.target.value || null)}
                    className="input"
                  >
                    <option value="">Choose a campaign…</option>
                    {campaigns.map((c) => (
                      <option key={c.id} value={c.id}>{c.name} — {c.objective}</option>
                    ))}
                  </select>
                )}
              </Field>
            )}

            {campaignId && (
              <Field label="Ad set">
                {adSetsLoading ? (
                  <Loading text="Loading ad sets…" />
                ) : adSets.length === 0 ? (
                  <div className="text-sm text-ink-muted">No ad sets in this campaign.</div>
                ) : (
                  <select
                    value={adSetId ?? ''}
                    onChange={(e) => setAdSetId(e.target.value || null)}
                    className="input"
                  >
                    <option value="">Choose an ad set…</option>
                    {adSets.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                )}
              </Field>
            )}
          </section>

          {/* 2. Media + ad table */}
          {adSetId && (
            <section className="card space-y-4">
              <div className="flex items-start justify-between">
                <h2 className="h-sub text-ink">Media</h2>
                {ads.length > 0 && (
                  <div className="text-xs text-ink-muted">
                    {ads.length} ad{ads.length > 1 ? 's' : ''} ready
                  </div>
                )}
              </div>

              <PairingTip />

              {/* Drop zone */}
              <div
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
                }}
                className={[
                  'rounded-lg border-2 border-dashed px-4 py-8 flex flex-col items-center gap-2 transition-colors',
                  isDragging
                    ? 'border-amber-400 bg-amber-50/70'
                    : 'border-line bg-surface-alt/30 hover:bg-surface-alt/60',
                ].join(' ')}
              >
                <UploadIcon size={22} className="text-ink-muted" />
                <div className="text-sm text-ink-muted text-center">
                  Drop your creatives here, or{' '}
                  <label className="text-amber-700 hover:text-amber-800 font-medium cursor-pointer">
                    pick files
                    <input
                      type="file"
                      multiple
                      accept="image/png,image/jpeg,video/mp4,video/quicktime"
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files) handleFiles(e.target.files);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>
                <div className="text-2xs text-ink-subtle">
                  PNG · JPG · MP4 · MOV. Vass detects aspect from dimensions.
                </div>
              </div>

              {/* Upload progress */}
              {uploading && uploadProgress.size > 0 && (
                <div className="space-y-1">
                  {Array.from(uploadProgress.entries()).map(([id, { name, progress }]) => (
                    <div key={id} className="flex items-center gap-2 text-xs text-ink-muted">
                      <Loader2 size={10} className="animate-spin shrink-0" />
                      <span className="truncate max-w-[200px]">{name}</span>
                      <div className="flex-1 h-1 bg-surface-alt rounded-full overflow-hidden min-w-[60px]">
                        <div
                          className="h-full bg-amber-400 transition-all"
                          style={{ width: `${Math.round(progress * 100)}%` }}
                        />
                      </div>
                      <span className="w-9 text-right">{Math.round(progress * 100)}%</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Ads table */}
              {ads.length > 0 && (
                <AdsTable
                  ads={ads}
                  probedFiles={probedFiles}
                  overrides={overrides}
                  onEdit={(id) => setEditingAdId(id)}
                  onRemoveAd={removeAd}
                  onRemoveFile={removeFileFromAd}
                  onAddFile={handleAddToSlot}
                />
              )}
            </section>
          )}

          {/* 3. Default copy */}
          {ads.length > 0 && (
            <section className="card space-y-4">
              <div className="flex items-center gap-2">
                <h2 className="h-sub text-ink">Default copy</h2>
                <span className="text-xs text-ink-subtle">
                  · applied to every ad unless overridden via Edit
                </span>
              </div>

              <Field label="Primary text">
                <textarea
                  value={primaryText}
                  onChange={(e) => setPrimaryText(e.target.value)}
                  rows={3}
                  className="input"
                  placeholder="What do you want to say?"
                />
              </Field>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Headline (optional)">
                  <input value={headline} onChange={(e) => setHeadline(e.target.value)} className="input" />
                </Field>
                <Field label="Description (optional)">
                  <input value={description} onChange={(e) => setDescription(e.target.value)} className="input" />
                </Field>
              </div>

              <Field label="Destination URL">
                <input
                  type="url"
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  placeholder="https://example.com/page"
                  className="input"
                />
              </Field>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Call to action">
                  <select value={cta} onChange={(e) => setCta(e.target.value)} className="input">
                    {META_CTAS.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                </Field>
                <Field label="UTM / URL tags (optional)">
                  <input
                    value={urlTags}
                    onChange={(e) => setUrlTags(e.target.value)}
                    placeholder="utm_source=fb&utm_campaign={{ad.name}}"
                    className="input font-mono text-xs"
                  />
                </Field>
              </div>
            </section>
          )}

          {/* 4. Naming + status */}
          {ads.length > 0 && (
            <section className="card space-y-4">
              <h2 className="h-sub text-ink">Naming &amp; status</h2>

              <Field label="Batch name (optional)">
                <input
                  value={batchName}
                  onChange={(e) => setBatchName(e.target.value)}
                  placeholder={`Bulk launch ${new Date().toLocaleDateString()}`}
                  className="input"
                />
              </Field>

              <Field label="Ad name template">
                <input
                  value={adNameTemplate}
                  onChange={(e) => setAdNameTemplate(e.target.value)}
                  className="input font-mono text-xs"
                />
                <div className="text-2xs text-ink-subtle mt-1">
                  Placeholders: {AD_NAME_PLACEHOLDERS.map((p) => p.token).join(' · ')}
                </div>
              </Field>

              <Field label="Initial status">
                <div className="flex gap-2">
                  {(['DRAFT', 'ACTIVE'] as DesiredAdStatus[]).map((s) => (
                    <button
                      type="button"
                      key={s}
                      onClick={() => setDesiredStatus(s)}
                      className={[
                        'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                        desiredStatus === s
                          ? 'border-amber-400 bg-amber-50 text-amber-800'
                          : 'border-line text-ink-muted hover:bg-surface-hover',
                      ].join(' ')}
                    >
                      {s === 'DRAFT' ? 'Draft (paused)' : 'Active'}
                    </button>
                  ))}
                </div>
              </Field>
            </section>
          )}
        </div>

        {/* ===== Sticky sidebar ===== */}
        <aside className="lg:sticky lg:top-6 lg:self-start space-y-4">
          <div className="card">
            <div className="text-xs font-medium text-ink-muted uppercase tracking-wider mb-3">Summary</div>
            <SummaryLine label="Account"  value={account?.name  ?? '—'} />
            <SummaryLine label="Campaign" value={campaign?.name ?? '—'} />
            <SummaryLine label="Ad set"   value={adSet?.name    ?? '—'} />
            <SummaryLine label="Status"   value={desiredStatus === 'DRAFT' ? 'Draft' : 'Active'} />
            <div className="border-t border-line mt-3 pt-3">
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-ink-subtle">Total ads</span>
                <span className="text-ink font-bold text-base font-display">{ads.length}</span>
              </div>
              {ads.length > 0 && (
                <AspectBreakdown ads={ads} />
              )}
            </div>
          </div>

          {validation.length > 0 ? (
            <div className="card">
              <div className="text-xs font-medium text-ink-muted uppercase tracking-wider mb-2">
                Before you launch
              </div>
              <ul className="space-y-1 text-xs text-ink-muted">
                {validation.map((v) => (
                  <li key={v} className="flex items-start gap-1.5">
                    <span className="text-warning shrink-0">•</span>
                    <span>{v}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="card flex items-center gap-2 text-xs text-success">
              <CheckCircle2 size={14} />
              Ready to launch
            </div>
          )}

          {submitError && (
            <div className="card flex items-start gap-2 text-xs text-danger">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>{submitError}</span>
            </div>
          )}

          <button
            onClick={handleSubmit}
            disabled={validation.length > 0 || submitting}
            title={validation.length > 0 ? `Before you launch:\n• ${validation.join('\n• ')}` : undefined}
            className="btn-primary w-full justify-center text-base py-3"
            style={{ background: validation.length === 0 ? '#B45309' : undefined }}
          >
            {submitting ? <Loader2 size={16} className="animate-spin" /> : <Rocket size={16} />}
            {submitting
              ? 'Launching…'
              : validation.length > 0
              ? `${validation.length} thing${validation.length === 1 ? '' : 's'} to fix`
              : `Launch ${ads.length} ad${ads.length === 1 ? '' : 's'}`}
          </button>
        </aside>
      </div>

      {/* Edit modal */}
      {editingAdId && ads.find((a) => a.id === editingAdId) && (
        <EditAdModal
          ad={ads.find((a) => a.id === editingAdId)!}
          override={overrides.get(editingAdId) ?? {}}
          defaults={{ message: primaryText, headline, description, linkUrl, callToActionType: cta, urlTags }}
          onClose={() => setEditingAdId(null)}
          onSave={(ovr) => {
            setOverrides((prev) => {
              const next = new Map(prev);
              if (Object.values(ovr).some((v) => v !== undefined && v !== '')) {
                next.set(editingAdId, ovr);
              } else {
                next.delete(editingAdId);
              }
              return next;
            });
            setEditingAdId(null);
          }}
        />
      )}
    </div>
  );
}

// =====================================================================
// Sub-components
// =====================================================================

function PairingTip() {
  return (
    <div className="rounded-lg bg-amber-50/60 border border-amber-200 p-3 flex gap-2 text-xs text-amber-900">
      <Info size={14} className="text-amber-700 shrink-0 mt-0.5" />
      <div>
        <span className="font-medium">Aspect is detected from each file's pixel dimensions.</span>{' '}
        Files sharing a filename stem (after stripping aspect tags) auto-group into one ad with up to four placement slots: 9:16, 4:5, 1:1, and 16:9.
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

function Loading({ text }: { text: string }) {
  return (
    <div className="text-sm text-ink-muted flex items-center gap-1.5">
      <Loader2 size={12} className="animate-spin" /> {text}
    </div>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between text-xs mb-1.5 gap-2">
      <span className="text-ink-subtle shrink-0">{label}</span>
      <span className="text-ink truncate text-right" title={value}>{value}</span>
    </div>
  );
}

/**
 * Mini summary of how many ads carry each aspect. Helps the user see at
 * a glance that they have e.g. 5 ads with both vertical + portrait but
 * 2 ads with only portrait.
 */
function AspectBreakdown({ ads }: { ads: PairedAd[] }) {
  const counts: Record<Aspect, number> = { vertical: 0, portrait: 0, square: 0, landscape: 0 };
  for (const ad of ads) {
    (Object.keys(ad.slots) as Aspect[]).forEach((k) => {
      if (ad.slots[k]) counts[k]++;
    });
  }
  const order: Aspect[] = ['vertical', 'portrait', 'square', 'landscape'];
  const present = order.filter((a) => counts[a] > 0);
  if (present.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {present.map((a) => (
        <span
          key={a}
          className="px-1.5 py-0.5 rounded font-mono text-2xs bg-amber-100 text-amber-800"
          title={`${counts[a]} ad${counts[a] === 1 ? '' : 's'} with ${ASPECT_LABEL[a]}`}
        >
          {counts[a]}× {ASPECT_LABEL[a]}
        </span>
      ))}
    </div>
  );
}

/**
 * Ad list table. One row per ad. Slot column shows up to 4 chips, each
 * filled (with click-to-remove X) or struck-through to indicate which
 * placements this ad covers.
 */
function AdsTable({
  ads, probedFiles, overrides, onEdit, onRemoveAd, onRemoveFile, onAddFile,
}: {
  ads: PairedAd[];
  probedFiles: ProbedFile[];
  overrides: Map<string, Partial<LaunchCopySpec> & { adName?: string }>;
  onEdit: (id: string) => void;
  onRemoveAd: (ad: PairedAd) => void;
  onRemoveFile: (ad: PairedAd, aspect: Aspect) => void;
  onAddFile: (ad: PairedAd, aspect: Aspect, file: File) => void;
}) {
  const probedById = useMemo(() => {
    const m = new Map<string, ProbedFile>();
    for (const f of probedFiles) m.set(f.uploadId, f);
    return m;
  }, [probedFiles]);

  return (
    <div className="-mx-6">
      <div className="px-6 mb-2 text-xs uppercase tracking-wider text-ink-subtle">
        Ads ({ads.length})
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-y border-line bg-surface-alt">
            <th className="text-left font-medium text-ink-muted px-6 py-2 text-xs uppercase tracking-wider">Ad</th>
            <th className="text-left font-medium text-ink-muted px-2 py-2 text-xs uppercase tracking-wider">Placements</th>
            <th className="text-left font-medium text-ink-muted px-2 py-2 text-xs uppercase tracking-wider">Copy</th>
            <th className="text-right font-medium text-ink-muted px-6 py-2 text-xs uppercase tracking-wider"></th>
          </tr>
        </thead>
        <tbody>
          {ads.map((ad) => {
            const ovr = overrides.get(ad.id);
            const hasOverride = !!ovr && Object.values(ovr).some((v) => v !== undefined && v !== '');
            const slotCount = (Object.values(ad.slots).filter(Boolean) as string[]).length;
            return (
              <tr key={ad.id} className="border-b border-line">
                <td className="px-6 py-3">
                  <div className="font-medium text-ink">{ovr?.adName?.trim() || ad.pairKey}</div>
                  {slotCount === 1 && (
                    <div className="text-2xs text-amber-700 mt-0.5 flex items-center gap-1">
                      <AlertTriangle size={10} />
                      One placement only
                    </div>
                  )}
                </td>
                <td className="px-2 py-3">
                  <div className="flex flex-wrap gap-1">
                    {(['vertical', 'portrait', 'square', 'landscape'] as Aspect[]).map((a) => {
                      const uid = ad.slots[a];
                      const probed = uid ? probedById.get(uid) : null;
                      return (
                        <SlotChip
                          key={a}
                          aspect={a}
                          filled={!!uid}
                          dims={probed ? `${probed.width}×${probed.height}` : undefined}
                          filename={probed?.filename}
                          onRemove={() => onRemoveFile(ad, a)}
                          onAdd={(file) => onAddFile(ad, a, file)}
                        />
                      );
                    })}
                  </div>
                </td>
                <td className="px-2 py-3 text-xs text-ink-muted">
                  {hasOverride ? (
                    <span className="inline-flex items-center gap-1 text-amber-700">
                      <Sparkles size={10} /> Customized
                    </span>
                  ) : (
                    <span className="text-ink-subtle">Uses defaults</span>
                  )}
                </td>
                <td className="px-6 py-3 text-right">
                  <div className="flex justify-end gap-1">
                    <button onClick={() => onEdit(ad.id)} className="btn-ghost text-xs" title="Edit this ad's copy">
                      <Edit3 size={11} />
                      Edit
                    </button>
                    <button onClick={() => onRemoveAd(ad)} className="btn-ghost text-xs text-danger hover:text-red-700" title="Remove this ad">
                      <Trash2 size={11} />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SlotChip({
  aspect, filled, dims, filename, onRemove, onAdd,
}: {
  aspect: Aspect;
  filled: boolean;
  dims?: string;
  filename?: string;
  onRemove: () => void;
  onAdd: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  if (!filled) {
    // Empty slot doubles as an "+ Add this format" button. Clicking opens
    // a file picker; the file is uploaded + assigned to THIS slot on
    // THIS ad. Real dimensions still get shown in the chip after upload
    // so the user can spot if they uploaded something off-shape.
    return (
      <>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className={[
            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-2xs',
            'border border-dashed border-line text-ink-subtle',
            'hover:bg-amber-50 hover:border-amber-400 hover:text-amber-800 transition-colors',
          ].join(' ')}
          title={`Add a ${ASPECT_LABEL[aspect]} version to this ad`}
        >
          <span>+</span>
          <span>{ASPECT_LABEL[aspect]}</span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onAdd(f);
            e.target.value = '';
          }}
        />
      </>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-2xs bg-amber-100 text-amber-900 group"
      title={`${filename ?? ''}${dims ? ` · ${dims}` : ''}`}
    >
      <span>{ASPECT_LABEL[aspect]}</span>
      {dims && <span className="text-amber-700/80">{dims}</span>}
      <button
        type="button"
        onClick={onRemove}
        className="opacity-50 hover:opacity-100"
        title="Remove this file"
      >
        <X size={9} />
      </button>
    </span>
  );
}

function EditAdModal({
  ad, override, defaults, onClose, onSave,
}: {
  ad: PairedAd;
  override: Partial<LaunchCopySpec> & { adName?: string };
  defaults: LaunchCopySpec;
  onClose: () => void;
  onSave: (ovr: Partial<LaunchCopySpec> & { adName?: string }) => void;
}) {
  const [adName, setAdName] = useState(override.adName ?? '');
  const [message, setMessage] = useState(override.message ?? '');
  const [headline, setHeadline] = useState(override.headline ?? '');
  const [description, setDescription] = useState(override.description ?? '');
  const [linkUrl, setLinkUrl] = useState(override.linkUrl ?? '');
  const [cta, setCta] = useState(override.callToActionType ?? '');
  const [urlTags, setUrlTags] = useState(override.urlTags ?? '');

  function save() {
    onSave({
      adName:           adName.trim()      || undefined,
      message:          message.trim()     || undefined,
      headline:         headline.trim()    || undefined,
      description:      description.trim() || undefined,
      linkUrl:          linkUrl.trim()     || undefined,
      callToActionType: cta                || undefined,
      urlTags:          urlTags.trim()     || undefined,
    });
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm flex items-start justify-center p-6 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full my-8">
        <div className="flex items-center justify-between p-5 border-b border-line">
          <div>
            <div className="h-sub text-ink">Edit ad</div>
            <div className="text-xs text-ink-muted mt-0.5">{ad.pairKey}</div>
          </div>
          <button onClick={onClose} className="btn-ghost">
            <X size={14} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="text-xs text-ink-muted">
            Leave a field empty to use the default. Anything you fill in here applies only to this ad.
          </div>

          <Field label="Ad name override">
            <input
              value={adName}
              onChange={(e) => setAdName(e.target.value)}
              placeholder={ad.pairKey}
              className="input"
            />
          </Field>

          <Field label="Primary text">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              className="input"
              placeholder={defaults.message}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Headline">
              <input value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder={defaults.headline ?? '—'} className="input" />
            </Field>
            <Field label="Description">
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={defaults.description ?? '—'} className="input" />
            </Field>
          </div>

          <Field label="Destination URL">
            <input type="url" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder={defaults.linkUrl} className="input" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Call to action">
              <select value={cta} onChange={(e) => setCta(e.target.value)} className="input">
                <option value="">— Use default ({defaults.callToActionType ?? DEFAULT_META_CTA})</option>
                {META_CTAS.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </Field>
            <Field label="UTM / URL tags">
              <input
                value={urlTags}
                onChange={(e) => setUrlTags(e.target.value)}
                placeholder={defaults.urlTags ?? '—'}
                className="input font-mono text-xs"
              />
            </Field>
          </div>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-line bg-surface-alt/40 rounded-b-xl">
          <button onClick={onClose} className="btn-secondary text-xs">Cancel</button>
          <button onClick={save} className="btn-primary text-xs" style={{ background: '#B45309' }}>
            Save overrides
          </button>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// Helpers
// =====================================================================

function stripEmpty<T extends Record<string, any>>(obj: T): Partial<T> | undefined {
  const out: any = {};
  let any = false;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}
