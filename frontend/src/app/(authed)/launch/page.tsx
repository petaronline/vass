'use client';

/**
 * Launch builder — Patch 3.1 matrix launching.
 *
 * From "1 creative → 1 ad set = 1 ad" to "M creatives × N ad sets = M×N ads",
 * with per-creative copy overrides and ad name templating.
 *
 * Sections:
 *   1. Where           — account + campaign
 *   2. Ad sets         — multi-select with checkboxes, search
 *   3. Creatives       — drag/drop multiple images or videos, per-creative editor
 *   4. Copy            — base copy applied to every ad (overridable per creative)
 *   5. Naming & status — batch name, ad name template with placeholder pills,
 *                        DRAFT/ACTIVE toggle
 *   6. Review          — preview of every ad that will be created (M×N table)
 *
 * Right rail (sticky): running matrix size + validation issues + Launch button.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Rocket,
  Upload as UploadIcon,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  X,
  ImageIcon,
  Video as VideoIcon,
  Search,
  Edit3,
  Eye,
  EyeOff,
} from 'lucide-react';
import {
  adAccounts,
  metaExplore,
  uploads as uploadsApi,
  launches,
  launchDefaults,
  AdAccount,
  MetaCampaign,
  MetaAdSet,
  Upload,
  DesiredAdStatus,
  LaunchCopySpec,
  CampaignObjective,
  META_CTAS,
  AD_NAME_PLACEHOLDERS,
  DEFAULT_AD_NAME_TEMPLATE,
} from '@/lib/api';
import { AdAccountAvatar } from '@/components/AdAccountAvatar';
import { PageHeader, PAGE_TINTS } from '@/components/PageHeader';
import {
  getActiveAdAccountIds,
  VASS_ACTIVE_SCOPE_EVENT,
} from '@/components/BrandSelector';
import { Toggle } from '@/components/Toggle';
import { NewAdSetForm } from '@/components/NewAdSetForm';
import { NewCampaignForm } from '@/components/NewCampaignForm';
import {
  autoGroupUploads,
  summarizePlacements,
  aspectBadge,
  type CreativeGroup,
} from '@/lib/creative-grouping';

// ============================================================
// State shapes
// ============================================================

/**
 * A creative "group" in the launch builder — one or more uploads that
 * together form ONE ad. In Patch 3.1 every group had exactly 1 upload.
 * In Patch 3.2, multiple uploads of different aspect ratios pair into
 * one multi-placement creative.
 */
interface CreativeItem {
  /** Stable client-side id (for React keys + drag-drop). */
  id: string;
  /** 1+ uploads in this group. */
  uploads: Upload[];
  /** Editable display name (auto-derived from common filename stem). */
  creativeName: string;
  /** Whether the user has expanded the per-creative copy override editor. */
  overrideOpen: boolean;
  /** Optional override fields. Empty/undefined = use the base copy. */
  copyOverride: Partial<LaunchCopySpec>;
}

interface FormState {
  adAccountId: string;
  metaCampaignId: string;
  selectedAdSetIds: string[];     // set of Meta IDs
  batchName: string;
  adNameTemplate: string;
  desiredAdStatus: DesiredAdStatus;
  copy: LaunchCopySpec;
}

const EMPTY_COPY: LaunchCopySpec = {
  message: '',
  headline: '',
  description: '',
  linkUrl: '',
  callToActionType: 'LEARN_MORE',
  urlTags: '',
};

const EMPTY_FORM: FormState = {
  adAccountId: '',
  metaCampaignId: '',
  selectedAdSetIds: [],
  batchName: '',
  adNameTemplate: DEFAULT_AD_NAME_TEMPLATE,
  desiredAdStatus: 'DRAFT',
  copy: { ...EMPTY_COPY },
};

// ============================================================
// Page
// ============================================================

export default function LaunchPage() {
  const router = useRouter();

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [creatives, setCreatives] = useState<CreativeItem[]>([]);
  const [accountsList, setAccountsList] = useState<AdAccount[]>([]);
  const [campaigns, setCampaigns] = useState<MetaCampaign[]>([]);
  const [adSetsList, setAdSetsList] = useState<MetaAdSet[]>([]);
  const [adSetFilter, setAdSetFilter] = useState('');
  /** Whether the inline new-ad-set form is open. */
  const [showNewAdSet, setShowNewAdSet] = useState(false);
  /** Whether the inline new-campaign form is open. */
  const [showNewCampaign, setShowNewCampaign] = useState(false);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [loadingAdSets, setLoadingAdSets] = useState(false);
  const [uploading, setUploading] = useState(false);
  /**
   * Per-file upload progress. Key is the File's name+size pair (Files don't
   * have stable IDs). Value is { fraction, filename, sizeBytes } so the UI
   * can show a friendly status line and progress bar per in-flight upload.
   */
  const [uploadProgress, setUploadProgress] = useState<Record<string, {
    filename: string;
    sizeBytes: number;
    fraction: number;
  }>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [activeOnly, setActiveOnly] = useState<boolean>(true);

  // ---- Initial loads ----
  useEffect(() => {
    adAccounts
      .list()
      .then((r) => setAccountsList(r.accounts.filter((a) => a.isEnabled)))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load accounts'));
    launchDefaults
      .getGlobal()
      .then((r) => {
        if (typeof r.config?.show_active_only_default === 'boolean') {
          setActiveOnly(r.config.show_active_only_default);
        }
      })
      .catch(() => {/* fall back */});
  }, []);

  // ---- Scope → ad account pre-fill (Patch 4.38.0) ----
  // The shared selector persists a brand/ad-account scope across the
  // whole app. When the user lands on Launch with a scope that
  // resolves to exactly one ad account (a brand with one ad account,
  // or a directly-picked ad account), pre-select it. We never
  // override a choice the user has already made on this page.
  useEffect(() => {
    if (accountsList.length === 0) return;
    const applyScope = () => {
      const ids = getActiveAdAccountIds(
        accountsList.map((a) => ({ id: a.id, brandId: a.brandId }))
      );
      if (ids && ids.length > 0) {
        // Only auto-fill if the current selection isn't already one of
        // the scoped accounts (don't fight the user).
        setForm((f) => {
          if (f.adAccountId && ids.includes(f.adAccountId)) return f;
          return { ...f, adAccountId: ids[0] };
        });
      }
    };
    applyScope();
    const onChange = () => applyScope();
    window.addEventListener(VASS_ACTIVE_SCOPE_EVENT, onChange);
    return () => window.removeEventListener(VASS_ACTIVE_SCOPE_EVENT, onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsList]);

  // ---- Reload campaigns when account or activeOnly changes ----
  useEffect(() => {
    if (!form.adAccountId) {
      setCampaigns([]);
      setAdSetsList([]);
      return;
    }
    setLoadingCampaigns(true);
    setCampaigns([]);
    setAdSetsList([]);
    metaExplore
      .listCampaigns(form.adAccountId, activeOnly)
      .then((r) => {
        setCampaigns(r.campaigns);
        // If the currently-selected campaign isn't in the new list anymore
        // (e.g. user toggled "active only" and the previously-picked
        // campaign is paused), clear the selection so the UI is honest.
        if (form.metaCampaignId && !r.campaigns.some((c) => c.id === form.metaCampaignId)) {
          setField('metaCampaignId', '');
          setField('selectedAdSetIds', []);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load campaigns'))
      .finally(() => setLoadingCampaigns(false));
    // form.metaCampaignId intentionally excluded — we don't want this effect
    // to re-run when the campaign itself changes, only the account/activeOnly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.adAccountId, activeOnly]);

  // ---- Reload ad sets when campaign or activeOnly changes ----
  useEffect(() => {
    if (!form.metaCampaignId) {
      setAdSetsList([]);
      return;
    }
    setLoadingAdSets(true);
    setAdSetsList([]);
    metaExplore
      .listAdSets(form.metaCampaignId, activeOnly)
      .then((r) => {
        setAdSetsList(r.adSets);
        // Drop any selected ad set IDs that are no longer in the list
        const validIds = new Set(r.adSets.map((s) => s.id));
        const stillValid = form.selectedAdSetIds.filter((id) => validIds.has(id));
        if (stillValid.length !== form.selectedAdSetIds.length) {
          setField('selectedAdSetIds', stillValid);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load ad sets'))
      .finally(() => setLoadingAdSets(false));
    // form.selectedAdSetIds intentionally excluded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.metaCampaignId, activeOnly]);

  // ---- File uploads (multi) ----
  //
  // After upload, files are auto-grouped by filename stem + aspect bucket.
  // For example "ad_1_4_5.jpg" and "ad_1_9_16.jpg" become ONE group.
  // The grouping logic lives in lib/creative-grouping.ts; this handler just
  // re-runs it whenever the upload set changes, merging with existing groups.
  async function handleFiles(files: File[]) {
    setError(null);
    setUploading(true);
    try {
      const newUploads: Upload[] = [];
      for (const file of files) {
        const key = `${file.name}::${file.size}`;
        // Initialize progress for this file
        setUploadProgress((prev) => ({
          ...prev,
          [key]: { filename: file.name, sizeBytes: file.size, fraction: 0 },
        }));
        try {
          const r = await uploadsApi.upload(file, (fraction) => {
            setUploadProgress((prev) => ({
              ...prev,
              [key]: { filename: file.name, sizeBytes: file.size, fraction },
            }));
          });
          newUploads.push(r.upload);
        } catch (err) {
          setError(`${file.name}: ${err instanceof Error ? err.message : 'upload failed'}`);
        } finally {
          // Remove this file's progress entry after it finishes (success or fail)
          setUploadProgress((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          });
        }
      }
      if (newUploads.length === 0) return;

      // Take everything we already have + the new uploads, re-group from scratch.
      // This is simpler than incremental merging and gives the user consistent
      // groupings even when uploads arrive out of order.
      setCreatives((prev) => {
        // Collect all currently-tracked uploads (flatten from groups)
        const existingUploads = prev.flatMap((g) => g.uploads);
        const all = [...existingUploads, ...newUploads];
        const groups = autoGroupUploads(all);

        // Preserve per-group customization (name, override, expanded state) when
        // a group's upload IDs match an existing group's IDs (same set).
        return groups.map((g) => {
          const ids = new Set(g.uploads.map((u) => u.id));
          const matching = prev.find(
            (oldG) =>
              oldG.uploads.length === g.uploads.length &&
              oldG.uploads.every((u) => ids.has(u.id))
          );
          if (matching) {
            // Preserve user customization
            return {
              id: matching.id,
              uploads: g.uploads,
              creativeName: matching.creativeName,
              overrideOpen: matching.overrideOpen,
              copyOverride: matching.copyOverride,
            };
          }
          return {
            id: g.id,
            uploads: g.uploads,
            creativeName: g.name,
            overrideOpen: false,
            copyOverride: {},
          };
        });
      });
    } finally {
      setUploading(false);
    }
  }

  function removeCreative(groupId: string) {
    setCreatives((prev) => prev.filter((g) => g.id !== groupId));
  }
  function removeUploadFromGroup(groupId: string, uploadId: string) {
    setCreatives((prev) => {
      // Drop the upload; if the group becomes empty, drop the group too
      return prev.flatMap((g) => {
        if (g.id !== groupId) return [g];
        const remaining = g.uploads.filter((u) => u.id !== uploadId);
        if (remaining.length === 0) return [];
        return [{ ...g, uploads: remaining }];
      });
    });
  }
  function updateCreative(groupId: string, patch: Partial<CreativeItem>) {
    setCreatives((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, ...patch } : g))
    );
  }
  function updateCreativeOverride(groupId: string, key: keyof LaunchCopySpec, value: string) {
    setCreatives((prev) =>
      prev.map((g) => {
        if (g.id !== groupId) return g;
        const override = { ...g.copyOverride };
        if (value === '') {
          delete override[key];
        } else {
          override[key] = value;
        }
        return { ...g, copyOverride: override };
      })
    );
  }

  /**
   * Add a file to a specific creative group (bypassing auto-grouping).
   * Used by the "+ Add 9:16" / "+ Add 4:5" buttons on single-asset groups.
   *
   * The file uploads normally (with progress), then the resulting Upload
   * is appended to the target group's `uploads` array — regardless of
   * filename. The user explicitly chose this pairing.
   */
  async function addUploadToGroup(groupId: string, file: File) {
    setError(null);
    const key = `${file.name}::${file.size}`;
    setUploadProgress((prev) => ({
      ...prev,
      [key]: { filename: file.name, sizeBytes: file.size, fraction: 0 },
    }));
    try {
      const r = await uploadsApi.upload(file, (fraction) => {
        setUploadProgress((prev) => ({
          ...prev,
          [key]: { filename: file.name, sizeBytes: file.size, fraction },
        }));
      });
      setCreatives((prev) =>
        prev.map((g) =>
          g.id === groupId ? { ...g, uploads: [...g.uploads, r.upload] } : g
        )
      );
    } catch (err) {
      setError(`${file.name}: ${err instanceof Error ? err.message : 'upload failed'}`);
    } finally {
      setUploadProgress((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  }

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  function setCopy(key: keyof LaunchCopySpec, value: string) {
    setForm((f) => ({ ...f, copy: { ...f.copy, [key]: value } }));
  }

  function toggleAdSet(id: string) {
    setForm((f) =>
      f.selectedAdSetIds.includes(id)
        ? { ...f, selectedAdSetIds: f.selectedAdSetIds.filter((x) => x !== id) }
        : { ...f, selectedAdSetIds: [...f.selectedAdSetIds, id] }
    );
  }
  function selectAllAdSets(ids: string[]) {
    setForm((f) => {
      const set = new Set([...f.selectedAdSetIds, ...ids]);
      return { ...f, selectedAdSetIds: Array.from(set) };
    });
  }
  function clearAllAdSets() {
    setForm((f) => ({ ...f, selectedAdSetIds: [] }));
  }

  /**
   * Called after NewAdSetForm successfully creates an ad set in Meta.
   *
   * Three things have to happen for the user to "see" their new ad set:
   *
   *   1. Optimistic local insert — Meta's API has eventual consistency
   *      (sometimes 5-30 seconds before a freshly created ad set appears
   *      in /{campaign}/adsets), so we add it to the list directly with the
   *      data we already know, no network roundtrip.
   *
   *   2. Auto-flip "Active only" toggle off if the new ad set is PAUSED.
   *      Otherwise the filter (effective_status=ACTIVE) would hide it from
   *      the list — making the form look broken even though the create
   *      succeeded.
   *
   *   3. Auto-select it so it's already checked for the launch.
   */
  async function handleNewAdSetCreated(newAdSet: {
    id: string;
    name: string;
    status: 'ACTIVE' | 'PAUSED';
  }) {
    setShowNewAdSet(false);

    // 1. Optimistic insert (dedupe in case Meta's eventual fetch returns it too)
    setAdSetsList((prev) => {
      if (prev.some((s) => s.id === newAdSet.id)) return prev;
      return [
        ...prev,
        {
          id: newAdSet.id,
          name: newAdSet.name,
          status: newAdSet.status,
          effective_status: newAdSet.status,
          campaign_id: form.metaCampaignId,
        },
      ];
    });

    // 2. If paused and active-only is on, turn it off so the new one shows
    if (newAdSet.status === 'PAUSED' && activeOnly) {
      setActiveOnly(false);
    }

    // 3. Auto-select
    setForm((f) => ({
      ...f,
      selectedAdSetIds: Array.from(new Set([...f.selectedAdSetIds, newAdSet.id])),
    }));

    // Background refresh — picks up real-state from Meta once eventually consistent.
    // We don't await it; the optimistic insert is already showing.
    if (form.metaCampaignId) {
      metaExplore
        .listAdSets(
          form.metaCampaignId,
          // Use the (possibly just-flipped) filter state — if we turned off
          // activeOnly above, fetch unfiltered
          newAdSet.status === 'PAUSED' ? false : activeOnly
        )
        .then((r) => {
          // Merge: replace our list with Meta's truth, but if our just-created
          // ad set isn't in Meta's response yet (eventual consistency), keep
          // it in the local list.
          setAdSetsList((prev) => {
            const fromMeta = r.adSets;
            const stillMissing = !fromMeta.some((s) => s.id === newAdSet.id);
            if (stillMissing) {
              const local = prev.find((s) => s.id === newAdSet.id);
              return local ? [...fromMeta, local] : fromMeta;
            }
            return fromMeta;
          });
        })
        .catch((err) => {
          console.warn('[launch] post-create ad sets refresh failed:', err);
        });
    }
  }

  /**
   * Called after NewCampaignForm successfully creates a campaign on Meta.
   *
   * Mirrors handleNewAdSetCreated's logic — optimistic insert, auto-toggle
   * Active-only filter off if paused, auto-select. After this, the user
   * naturally moves to creating an ad set inside the brand-new campaign
   * (which has zero ad sets yet, so the next click is "+ New ad set").
   */
  async function handleNewCampaignCreated(newCampaign: {
    id: string;
    name: string;
    objective: CampaignObjective;
    status: 'ACTIVE' | 'PAUSED';
  }) {
    setShowNewCampaign(false);

    // 1. Optimistic insert
    setCampaigns((prev) => {
      if (prev.some((c) => c.id === newCampaign.id)) return prev;
      return [
        ...prev,
        {
          id: newCampaign.id,
          name: newCampaign.name,
          objective: newCampaign.objective,
          status: newCampaign.status,
          effective_status: newCampaign.status,
        },
      ];
    });

    // 2. If paused and active-only is on, turn it off so the new one shows
    if (newCampaign.status === 'PAUSED' && activeOnly) {
      setActiveOnly(false);
    }

    // 3. Auto-select the new campaign (clears ad set selection — fresh campaign has none)
    setField('metaCampaignId', newCampaign.id);
    setField('selectedAdSetIds', []);

    // Background refresh — picks up canonical Meta state (eventual consistency safe)
    if (form.adAccountId) {
      metaExplore
        .listCampaigns(
          form.adAccountId,
          newCampaign.status === 'PAUSED' ? false : activeOnly
        )
        .then((r) => {
          setCampaigns((prev) => {
            const fromMeta = r.campaigns;
            const stillMissing = !fromMeta.some((c) => c.id === newCampaign.id);
            if (stillMissing) {
              const local = prev.find((c) => c.id === newCampaign.id);
              return local ? [...fromMeta, local] : fromMeta;
            }
            return fromMeta;
          });
        })
        .catch((err) => {
          console.warn('[launch] post-create campaigns refresh failed:', err);
        });
    }
  }

  // ---- Derived ----
  const selectedAccount = accountsList.find((a) => a.id === form.adAccountId);
  const selectedAdSets = useMemo(
    () => adSetsList.filter((s) => form.selectedAdSetIds.includes(s.id)),
    [adSetsList, form.selectedAdSetIds]
  );
  const filteredAdSetsList = useMemo(() => {
    const f = adSetFilter.trim().toLowerCase();
    if (!f) return adSetsList;
    return adSetsList.filter((s) => s.name.toLowerCase().includes(f));
  }, [adSetsList, adSetFilter]);

  const matrixCount = creatives.length * selectedAdSets.length;

  // ---- Validation ----
  const issues: string[] = [];
  if (!form.adAccountId) issues.push('Choose an ad account');
  if (!form.metaCampaignId) issues.push('Choose a campaign');
  if (selectedAdSets.length === 0) issues.push('Select at least one ad set');
  if (creatives.length === 0) issues.push('Add at least one creative');
  if (!form.copy.message.trim()) issues.push('Primary text is required');
  if (!form.copy.linkUrl.trim()) issues.push('Destination URL is required');
  else if (!/^https:\/\//i.test(form.copy.linkUrl)) issues.push('Destination URL must start with https://');
  if (matrixCount > 200) issues.push(`Matrix too large (${matrixCount} ads). Reduce creatives or ad sets.`);

  // ---- Submit ----
  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await launches.create({
        adAccountId: form.adAccountId,
        batchName: form.batchName || `Launch ${new Date().toLocaleString()}`,
        desiredAdStatus: form.desiredAdStatus,
        adSets: selectedAdSets.map((s) => ({ adSetId: s.id, adSetName: s.name })),
        creatives: creatives.map((c) => ({
          uploadIds: c.uploads.map((u) => u.id),
          creativeName: c.creativeName,
          copyOverride: Object.keys(c.copyOverride).length > 0 ? c.copyOverride : undefined,
        })),
        copy: {
          message: form.copy.message,
          headline: form.copy.headline || undefined,
          description: form.copy.description || undefined,
          linkUrl: form.copy.linkUrl,
          callToActionType: form.copy.callToActionType || undefined,
          urlTags: form.copy.urlTags?.trim() || undefined,
        },
        adNameTemplate: form.adNameTemplate.trim() || undefined,
      });
      router.push(`/launches/${result.batchId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Launch failed');
      setSubmitting(false);
    }
  }

  return (
    <div className="w-full">
      <PageHeader
        icon={Rocket}
        title="Launch"
        description="Add creatives and ad sets — Vass launches every creative into every selected ad set."
        tint={PAGE_TINTS.launch}
        activeOnly={activeOnly}
        onActiveOnlyChange={setActiveOnly}
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-8">
        <div className="space-y-8">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-red-100 bg-red-50 text-sm text-danger">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* ---- 1. Where ---- */}
          <Section title="1. Where" subtitle="Choose the account and campaign you're launching into.">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Ad account">
                <Select
                  value={form.adAccountId}
                  onChange={(v) => {
                    setField('adAccountId', v);
                    setField('metaCampaignId', '');
                    setField('selectedAdSetIds', []);
                  }}
                  placeholder="Select an account…"
                >
                  {accountsList.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </Select>
                {selectedAccount && (
                  <div className="mt-2 flex items-center gap-2 text-xs">
                    <AdAccountAvatar
                      name={selectedAccount.name}
                      pictureUrl={selectedAccount.pictureUrl}
                      size={20}
                    />
                    <span className="text-ink-subtle">{selectedAccount.metaAccountId}</span>
                  </div>
                )}
              </Field>

              <Field label="Campaign">
                <Select
                  value={form.metaCampaignId}
                  onChange={(v) => {
                    setField('metaCampaignId', v);
                    setField('selectedAdSetIds', []);
                  }}
                  placeholder={
                    !form.adAccountId
                      ? 'Pick an account first'
                      : loadingCampaigns
                      ? 'Loading…'
                      : 'Select a campaign…'
                  }
                  disabled={!form.adAccountId || loadingCampaigns}
                >
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </Select>
              </Field>
            </div>

            {/* ---- Inline "+ New campaign" button + form ---- */}
            {form.adAccountId && !loadingCampaigns && (
              <div className="mt-3">
                {!showNewCampaign ? (
                  <button
                    type="button"
                    onClick={() => setShowNewCampaign(true)}
                    className="text-xs font-medium px-2.5 py-1.5 rounded border border-dashed border-line text-ink-muted hover:border-accent hover:bg-accent-subtle hover:text-accent transition-colors flex items-center gap-1"
                  >
                    <span className="text-base leading-none">+</span> New campaign in this account
                  </button>
                ) : (
                  <NewCampaignForm
                    adAccountId={form.adAccountId}
                    defaultCurrency={selectedAccount?.currency ?? 'USD'}
                    onCreated={handleNewCampaignCreated}
                    onCancel={() => setShowNewCampaign(false)}
                  />
                )}
              </div>
            )}
          </Section>

          {/* ---- 2. Ad sets ---- */}
          <Section
            title="2. Ad sets"
            subtitle={
              !form.metaCampaignId
                ? 'Pick a campaign first.'
                : `Select one or more ad sets. ${selectedAdSets.length} of ${adSetsList.length} selected.`
            }
          >
            {!form.metaCampaignId ? (
              <div className="card py-6 text-center text-sm text-ink-subtle">
                Pick a campaign above to see its ad sets.
              </div>
            ) : loadingAdSets ? (
              <div className="card py-6 text-center text-sm text-ink-subtle">Loading…</div>
            ) : adSetsList.length === 0 ? (
              <div className="card py-6 text-center text-sm text-ink-subtle">
                No {activeOnly ? 'active ' : ''}ad sets in this campaign.
              </div>
            ) : (
              <AdSetSelector
                adSets={filteredAdSetsList}
                allAdSets={adSetsList}
                selectedIds={form.selectedAdSetIds}
                filter={adSetFilter}
                onFilter={setAdSetFilter}
                onToggle={toggleAdSet}
                onSelectAll={() => selectAllAdSets(filteredAdSetsList.map((s) => s.id))}
                onClearAll={clearAllAdSets}
              />
            )}

            {/* ---- Inline "+ New ad set" button + form ---- */}
            {form.metaCampaignId && !loadingAdSets && (
              <div className="mt-3">
                {!showNewAdSet ? (
                  <button
                    type="button"
                    onClick={() => setShowNewAdSet(true)}
                    className="text-xs font-medium px-2.5 py-1.5 rounded border border-dashed border-line text-ink-muted hover:border-accent hover:bg-accent-subtle hover:text-accent transition-colors flex items-center gap-1"
                  >
                    <span className="text-base leading-none">+</span> New ad set in this campaign
                  </button>
                ) : (
                  <NewAdSetForm
                    adAccountId={form.adAccountId}
                    metaCampaignId={form.metaCampaignId}
                    accountPageId={selectedAccount?.pageId ?? null}
                    defaultCurrency={selectedAccount?.currency ?? 'USD'}
                    onCreated={handleNewAdSetCreated}
                    onCancel={() => setShowNewAdSet(false)}
                  />
                )}
              </div>
            )}
          </Section>

          {/* ---- 3. Creatives ---- */}
          <Section
            title="3. Creatives"
            subtitle={`Add one or more images or videos. ${creatives.length} added.`}
          >
            <div className="space-y-3">
              {creatives.length > 0 && (
                <div className="space-y-2">
                  {creatives.map((c) => (
                    <CreativeRow
                      key={c.id}
                      item={c}
                      onRemove={() => removeCreative(c.id)}
                      onRemoveUpload={(uploadId) => removeUploadFromGroup(c.id, uploadId)}
                      onAddSize={(file) => addUploadToGroup(c.id, file)}
                      onRename={(name) => updateCreative(c.id, { creativeName: name })}
                      onToggleOverride={() =>
                        updateCreative(c.id, { overrideOpen: !c.overrideOpen })
                      }
                      onOverrideChange={(key, value) =>
                        updateCreativeOverride(c.id, key, value)
                      }
                      baseCopy={form.copy}
                    />
                  ))}
                </div>
              )}
              <UploadProgressList progress={uploadProgress} />
              <FileDrop onFiles={handleFiles} uploading={uploading} hasExisting={creatives.length > 0} />
            </div>
          </Section>

          {/* ---- 4. Copy ---- */}
          <Section
            title="4. Copy"
            subtitle="Applied to every ad. Override per-creative above if needed."
          >
            <CopyEditor
              copy={form.copy}
              onChange={(key, value) => setCopy(key, value)}
            />
          </Section>

          {/* ---- 5. Naming & status ---- */}
          <Section title="5. Naming & status" subtitle="How the ads are named in Meta and whether they start running.">
            <div className="space-y-4">
              <Field label="Batch name (Vass-only)">
                <input
                  className="input w-full text-sm"
                  value={form.batchName}
                  onChange={(e) => setField('batchName', e.target.value)}
                  placeholder="Optional — e.g. Spring Sale Round 1"
                />
              </Field>

              <Field label="Ad name template">
                <input
                  className="input w-full text-sm font-mono"
                  value={form.adNameTemplate}
                  onChange={(e) => setField('adNameTemplate', e.target.value)}
                  placeholder={DEFAULT_AD_NAME_TEMPLATE}
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {AD_NAME_PLACEHOLDERS.map((p) => (
                    <button
                      key={p.token}
                      type="button"
                      onClick={() =>
                        setField('adNameTemplate', form.adNameTemplate + p.token)
                      }
                      className="text-2xs font-mono px-1.5 py-0.5 rounded border border-line bg-surface-alt hover:bg-surface-hover text-ink-muted"
                      title={p.label}
                    >
                      {p.token}
                    </button>
                  ))}
                </div>
                <div className="text-2xs text-ink-subtle mt-1.5">
                  Each ad gets this name with placeholders filled in.
                </div>
              </Field>

              <Field label="Launch as">
                <div className="flex gap-2">
                  {(['DRAFT', 'ACTIVE'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setField('desiredAdStatus', s)}
                      className={[
                        'px-3 py-1.5 text-xs font-medium rounded-lg border',
                        form.desiredAdStatus === s
                          ? 'border-accent bg-accent-subtle text-accent'
                          : 'border-line text-ink-muted hover:bg-surface-hover',
                      ].join(' ')}
                    >
                      {s === 'DRAFT' ? 'Draft (paused)' : 'Active (live)'}
                    </button>
                  ))}
                </div>
                <div className="text-2xs text-ink-subtle mt-1.5">
                  {form.desiredAdStatus === 'DRAFT'
                    ? 'Ads are created in PAUSED state. You can sanity-check in Meta before going live.'
                    : 'Ads immediately start spending (if the ad set is active).'}
                </div>
              </Field>
            </div>
          </Section>

          {/* ---- 6. Review ---- */}
          <Section
            title="6. Review"
            subtitle={`Preview every ad before launching. ${matrixCount} ad${matrixCount === 1 ? '' : 's'} planned.`}
          >
            <button
              type="button"
              onClick={() => setReviewOpen((v) => !v)}
              className="card w-full flex items-center justify-between text-left hover:bg-surface-hover transition-colors"
            >
              <div className="flex items-center gap-2 text-sm">
                {reviewOpen ? <EyeOff size={14} /> : <Eye size={14} />}
                <span className="text-ink">
                  {reviewOpen ? 'Hide review table' : 'Show review table'}
                </span>
              </div>
              <span className="text-xs text-ink-muted">
                {matrixCount} ad{matrixCount === 1 ? '' : 's'}
              </span>
            </button>
            {reviewOpen && matrixCount > 0 && (
              <div className="mt-3">
                <ReviewMatrix
                  creatives={creatives}
                  adSets={selectedAdSets}
                  baseCopy={form.copy}
                  adNameTemplate={form.adNameTemplate}
                  accountName={selectedAccount?.name ?? ''}
                  batchName={form.batchName}
                />
              </div>
            )}
          </Section>
        </div>

        {/* Sticky right rail */}
        <aside className="lg:sticky lg:top-6 lg:self-start space-y-4">
          <div className="card">
            <div className="text-xs font-medium text-ink-muted uppercase tracking-wider mb-3">Summary</div>
            <SummaryLine label="Account" value={selectedAccount?.name ?? '—'} />
            <SummaryLine label="Campaign" value={campaigns.find((c) => c.id === form.metaCampaignId)?.name ?? '—'} />
            <SummaryLine label="Ad sets" value={selectedAdSets.length === 0 ? '—' : `${selectedAdSets.length} selected`} />
            <SummaryLine label="Creatives" value={creatives.length === 0 ? '—' : `${creatives.length} added`} />
            <SummaryLine label="Status" value={form.desiredAdStatus === 'DRAFT' ? 'Draft' : 'Active'} />
            <div className="border-t border-line mt-3 pt-3">
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-ink-subtle">Total ads</span>
                <span className="text-ink font-bold text-base font-display">{matrixCount}</span>
              </div>
            </div>
          </div>

          {issues.length > 0 ? (
            <div className="card">
              <div className="text-xs font-medium text-ink-muted uppercase tracking-wider mb-2">
                Before you launch
              </div>
              <ul className="space-y-1 text-xs text-ink-muted">
                {issues.map((i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <span className="text-warning shrink-0">•</span>
                    <span>{i}</span>
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

          <button
            onClick={submit}
            disabled={issues.length > 0 || submitting}
            title={issues.length > 0 ? `Before you launch:\n• ${issues.join('\n• ')}` : undefined}
            className="btn-primary w-full justify-center text-base py-3"
          >
            <Rocket size={16} />
            {submitting
              ? 'Launching…'
              : issues.length > 0
              ? `${issues.length} thing${issues.length === 1 ? '' : 's'} to fix`
              : `Launch ${matrixCount} ad${matrixCount === 1 ? '' : 's'}`}
          </button>
        </aside>
      </div>
    </div>
  );
}

// ============================================================
// Components (split below so the page reads top-down)
// ============================================================

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="h-sub text-ink">{title}</h2>
        {subtitle && <p className="text-xs text-ink-subtle mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={['block', className].filter(Boolean).join(' ')}>
      <div className="text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
        {label}
      </div>
      {children}
    </label>
  );
}

function Select({
  value,
  onChange,
  children,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full appearance-none pr-9 pl-3 py-2 rounded-lg border border-line bg-surface text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {placeholder && <option value="">{placeholder}</option>}
        {children}
      </select>
      <ChevronDown
        size={16}
        className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-ink-muted"
      />
    </div>
  );
}

function SummaryLine({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-baseline gap-2 py-1 text-xs">
      <div className="text-ink-subtle min-w-[64px] shrink-0">{label}</div>
      <div className="text-ink min-w-0 truncate">{value}</div>
    </div>
  );
}

// ============================================================
// Ad set multi-selector
// ============================================================

function AdSetSelector({
  adSets,
  allAdSets,
  selectedIds,
  filter,
  onFilter,
  onToggle,
  onSelectAll,
  onClearAll,
}: {
  adSets: MetaAdSet[];          // post-filter
  allAdSets: MetaAdSet[];       // pre-filter (for "select all visible")
  selectedIds: string[];
  filter: string;
  onFilter: (v: string) => void;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
}) {
  const allVisibleSelected =
    adSets.length > 0 && adSets.every((s) => selectedIds.includes(s.id));
  return (
    <div className="card">
      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
          <input
            value={filter}
            onChange={(e) => onFilter(e.target.value)}
            placeholder={`Filter ${allAdSets.length} ad sets…`}
            className="input w-full text-sm pl-7 py-1.5"
          />
        </div>
        <button
          type="button"
          onClick={allVisibleSelected ? onClearAll : onSelectAll}
          className="text-xs font-medium text-accent hover:underline whitespace-nowrap"
        >
          {allVisibleSelected ? 'Clear all' : 'Select all'}
        </button>
      </div>

      {/* List */}
      <div className="max-h-[320px] overflow-y-auto -mx-1 px-1 space-y-0.5">
        {adSets.length === 0 ? (
          <div className="text-xs text-ink-subtle py-2 px-2">No matches.</div>
        ) : (
          adSets.map((s) => {
            const isSelected = selectedIds.includes(s.id);
            return (
              <label
                key={s.id}
                className="flex items-center gap-2.5 py-1.5 px-2 rounded hover:bg-surface-hover cursor-pointer text-sm"
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggle(s.id)}
                  className="accent-accent"
                />
                <span className={isSelected ? 'text-ink font-medium' : 'text-ink-muted'}>
                  {s.name}
                </span>
                <span className="ml-auto text-2xs text-ink-subtle font-mono">{s.id}</span>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}

// ============================================================
// Per-creative editor row
// ============================================================

function CreativeRow({
  item,
  onRemove,
  onRemoveUpload,
  onAddSize,
  onRename,
  onToggleOverride,
  onOverrideChange,
  baseCopy,
}: {
  item: CreativeItem;
  onRemove: () => void;
  onRemoveUpload: (uploadId: string) => void;
  onAddSize: (file: File) => void;
  onRename: (name: string) => void;
  onToggleOverride: () => void;
  onOverrideChange: (key: keyof LaunchCopySpec, value: string) => void;
  baseCopy: LaunchCopySpec;
}) {
  const addSizeInputRef = useRef<HTMLInputElement>(null);
  const overrideCount = Object.keys(item.copyOverride).length;
  const placementSummary = summarizePlacements({
    id: item.id,
    name: item.creativeName,
    uploads: item.uploads,
  } as CreativeGroup);
  const totalKB = item.uploads
    .reduce((sum, u) => sum + u.sizeBytes, 0) / 1024;

  // Determine which ratio the group is missing so we can suggest the right one.
  // If the group already has feed (1:1 or 4:5) AND story (9:16) coverage, no
  // suggestion. If it has feed only, suggest 9:16. If it has story only,
  // suggest 4:5 (the default feed ratio).
  const buckets = new Set(item.uploads.map((u) => u.aspectBucket));
  const hasFeed = buckets.has('1_1') || buckets.has('4_5');
  const hasStory = buckets.has('9_16');
  const suggestedRatio: '4:5' | '9:16' | null =
    hasFeed && hasStory ? null : hasStory ? '4:5' : !hasFeed ? null : '9:16';

  return (
    <div className="card relative">
      {/* Top-right remove X — absolute positioned, subtle by default, prominent on hover */}
      <button
        type="button"
        onClick={onRemove}
        className="absolute top-2.5 right-2.5 w-7 h-7 flex items-center justify-center rounded-lg border border-red-200 text-red-400 hover:border-red-400 hover:bg-red-50 hover:text-red-500 transition-colors"
        aria-label="Remove creative group"
        title="Remove this creative"
      >
        <X size={14} />
      </button>

      {/* pr-12 to leave room under the absolute X */}
      <div className="flex items-start gap-3 pr-12">
        {/* Asset thumbnails — one per upload in the group */}
        <div className="flex gap-1.5 shrink-0">
          {item.uploads.map((u) => {
            const isVideo = u.kind === 'video';
            const bucket = u.aspectBucket;
            return (
              <div
                key={u.id}
                className="relative group"
                title={`${u.filename} (${aspectBadge(bucket)})`}
              >
                <div className="w-14 h-14 rounded overflow-hidden bg-surface-alt flex items-center justify-center">
                  {isVideo ? (
                    <VideoIcon size={18} className="text-ink-muted" />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={uploadsApi.fileUrl(u.id)}
                      alt={u.filename}
                      className="w-full h-full object-cover"
                    />
                  )}
                </div>
                {/* Bucket badge */}
                <div className="absolute -bottom-1 -right-1 text-[9px] font-mono font-bold px-1 rounded bg-ink text-white">
                  {aspectBadge(bucket)}
                </div>
                {/* Per-asset remove — only show if there's more than 1 asset in group */}
                {item.uploads.length > 1 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveUpload(u.id);
                    }}
                    className="absolute -top-1 -right-1 bg-white border border-line rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label="Remove this asset from group"
                  >
                    <X size={10} className="text-ink-subtle" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Name + meta */}
        <div className="flex-1 min-w-0">
          <input
            className="input w-full text-sm"
            value={item.creativeName}
            onChange={(e) => onRename(e.target.value)}
            placeholder="Creative name"
          />
          <div className="mt-1 text-2xs text-ink-subtle flex items-center gap-2 flex-wrap">
            <span className="shrink-0">{item.uploads.length} asset{item.uploads.length === 1 ? '' : 's'}</span>
            <span className="shrink-0">· {totalKB.toFixed(0)} KB</span>
            <span className="shrink-0 px-1.5 py-0.5 rounded bg-accent-subtle text-accent font-medium">
              {placementSummary}
            </span>
            {suggestedRatio && (
              <>
                <button
                  type="button"
                  onClick={() => addSizeInputRef.current?.click()}
                  className="shrink-0 text-2xs font-medium px-1.5 py-0.5 rounded border border-dashed border-line text-ink-muted hover:bg-surface-hover hover:border-accent hover:text-accent transition-colors"
                  title={`Add a ${suggestedRatio} version to this creative for ${suggestedRatio === '9:16' ? 'Stories/Reels' : 'Feed'} placements`}
                >
                  + Add {suggestedRatio}
                </button>
                <input
                  ref={addSizeInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onAddSize(f);
                    e.target.value = '';
                  }}
                />
              </>
            )}
          </div>
        </div>

        {/* Actions — Override copy only (X moved to absolute top-right) */}
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onToggleOverride}
            className={[
              'text-2xs font-medium px-2 py-1 rounded border flex items-center gap-1 whitespace-nowrap',
              overrideCount > 0
                ? 'border-accent text-accent bg-accent-subtle'
                : 'border-line text-ink-muted hover:bg-surface-hover',
            ].join(' ')}
            title={overrideCount > 0 ? `${overrideCount} field${overrideCount === 1 ? '' : 's'} overridden` : 'Override copy for this creative'}
          >
            <Edit3 size={11} />
            {item.overrideOpen ? 'Hide copy' : overrideCount > 0 ? `Override (${overrideCount})` : 'Override copy'}
          </button>
        </div>
      </div>

      {/* Override editor — collapsible */}
      {item.overrideOpen && (
        <div className="mt-4 pt-4 border-t border-line space-y-3">
          <p className="text-xs text-ink-subtle">
            Leave a field blank to use the base copy below. Fill it in to override.
          </p>
          <OverrideRow
            label="Primary text"
            placeholder={baseCopy.message || '(base copy)'}
            value={item.copyOverride.message ?? ''}
            onChange={(v) => onOverrideChange('message', v)}
            multiline
            maxLength={2000}
          />
          <OverrideRow
            label="Headline"
            placeholder={baseCopy.headline || '(base copy)'}
            value={item.copyOverride.headline ?? ''}
            onChange={(v) => onOverrideChange('headline', v)}
            maxLength={200}
          />
          <OverrideRow
            label="Description"
            placeholder={baseCopy.description || '(base copy)'}
            value={item.copyOverride.description ?? ''}
            onChange={(v) => onOverrideChange('description', v)}
            maxLength={200}
          />
          <OverrideRow
            label="Destination URL"
            placeholder={baseCopy.linkUrl || '(base copy)'}
            value={item.copyOverride.linkUrl ?? ''}
            onChange={(v) => onOverrideChange('linkUrl', v)}
          />
        </div>
      )}
    </div>
  );
}

function OverrideRow({
  label,
  placeholder,
  value,
  onChange,
  multiline,
  maxLength,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  maxLength?: number;
}) {
  return (
    <Field label={label}>
      {multiline ? (
        <textarea
          className="input w-full text-sm min-h-[64px]"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={maxLength}
          placeholder={placeholder}
        />
      ) : (
        <input
          className="input w-full text-sm"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={maxLength}
          placeholder={placeholder}
        />
      )}
    </Field>
  );
}

// ============================================================
// Base copy editor
// ============================================================

function CopyEditor({
  copy,
  onChange,
}: {
  copy: LaunchCopySpec;
  onChange: (key: keyof LaunchCopySpec, value: string) => void;
}) {
  return (
    <div className="space-y-3">
      <Field label="Primary text">
        <textarea
          className="input w-full text-sm min-h-[88px]"
          value={copy.message}
          onChange={(e) => onChange('message', e.target.value)}
          maxLength={2000}
          placeholder="The main body of the ad"
        />
        <div className="text-2xs text-ink-subtle mt-1 text-right">
          {copy.message.length}/2000
        </div>
      </Field>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Headline">
          <input
            className="input w-full text-sm"
            value={copy.headline ?? ''}
            onChange={(e) => onChange('headline', e.target.value)}
            maxLength={200}
            placeholder="Optional"
          />
        </Field>
        <Field label="Description">
          <input
            className="input w-full text-sm"
            value={copy.description ?? ''}
            onChange={(e) => onChange('description', e.target.value)}
            maxLength={200}
            placeholder="Optional"
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_180px] gap-3">
        <Field label="Destination URL">
          <input
            className="input w-full text-sm"
            value={copy.linkUrl}
            onChange={(e) => onChange('linkUrl', e.target.value)}
            placeholder="https://example.com/page"
          />
        </Field>
        <Field label="Call to action">
          <Select
            value={copy.callToActionType ?? 'LEARN_MORE'}
            onChange={(v) => onChange('callToActionType', v)}
          >
            {META_CTAS.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label="URL parameters (UTM tracking, optional)">
        <input
          className="input w-full text-sm font-mono"
          value={copy.urlTags ?? ''}
          onChange={(e) => onChange('urlTags', e.target.value)}
          placeholder="utm_source=fb&utm_medium=cpc&utm_campaign=spring"
          maxLength={500}
        />
        <div className="text-2xs text-ink-subtle mt-1 leading-relaxed">
          Meta appends these to the destination URL on click. Leave blank to
          skip. Supports tokens like {`{{ad.name}}`}, {`{{campaign.name}}`}.
        </div>
      </Field>
    </div>
  );
}

// ============================================================
// Multi-file dropzone
// ============================================================

function UploadProgressList({
  progress,
}: {
  progress: Record<string, { filename: string; sizeBytes: number; fraction: number }>;
}) {
  const entries = Object.entries(progress);
  if (entries.length === 0) return null;
  return (
    <div className="card space-y-2">
      {entries.map(([key, p]) => {
        const pct = Math.round(p.fraction * 100);
        const sizeLabel =
          p.sizeBytes >= 1024 * 1024
            ? `${(p.sizeBytes / 1024 / 1024).toFixed(1)} MB`
            : `${(p.sizeBytes / 1024).toFixed(0)} KB`;
        return (
          <div key={key}>
            <div className="flex items-baseline justify-between text-xs mb-1">
              <span className="text-ink-muted truncate flex-1 mr-2">{p.filename}</span>
              <span className="text-ink-subtle shrink-0 font-mono tabular-nums">
                {pct}% · {sizeLabel}
              </span>
            </div>
            <div className="h-1.5 bg-line rounded-full overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-150"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FileDrop({
  onFiles,
  uploading,
  hasExisting,
}: {
  onFiles: (files: File[]) => void;
  uploading: boolean;
  hasExisting: boolean;
}) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <label
      htmlFor="creative-file-input"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length > 0) onFiles(files);
      }}
      className={[
        'card flex flex-col items-center justify-center cursor-pointer transition-colors',
        hasExisting ? 'py-6' : 'py-10',
        dragOver ? 'border-accent bg-accent-subtle' : 'border-dashed border-line hover:bg-surface-hover',
      ].join(' ')}
    >
      <input
        id="creative-file-input"
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) onFiles(files);
          // Allow re-uploading the same file later
          e.target.value = '';
        }}
        disabled={uploading}
      />
      {uploading ? (
        <>
          <UploadIcon size={20} className="text-accent animate-pulse mb-2" />
          <div className="text-sm text-ink">Uploading…</div>
        </>
      ) : (
        <>
          <ImageIcon size={20} className="text-ink-muted mb-2" />
          <div className="text-sm text-ink">
            {hasExisting ? 'Add more creatives' : 'Drop images or videos here, or click to choose'}
          </div>
          <div className="text-xs text-ink-subtle mt-1">
            Images (JPG, PNG, WebP, GIF) or videos (MP4, MOV, WebM) up to 250 MB
          </div>
          {!hasExisting && (
            <div className="text-2xs text-ink-subtle mt-2 text-center max-w-md">
              Tip: name files like <code className="text-ink">name_4_5.jpg</code> and{' '}
              <code className="text-ink">name_9_16.mp4</code> to auto-pair them as one
              multi-placement ad.
            </div>
          )}
        </>
      )}
    </label>
  );
}

// ============================================================
// Review matrix — preview every ad before launch
// ============================================================

function ReviewMatrix({
  creatives,
  adSets,
  baseCopy,
  adNameTemplate,
  accountName,
  batchName,
}: {
  creatives: CreativeItem[];
  adSets: MetaAdSet[];
  baseCopy: LaunchCopySpec;
  adNameTemplate: string;
  accountName: string;
  batchName: string;
}) {
  // Build the matrix client-side so the review is instant.
  // Server uses the same logic — see backend/ad-name-template.ts.
  const rows: Array<{
    key: string;
    creative: CreativeItem;
    adSet: MetaAdSet;
    adName: string;
    effective: LaunchCopySpec;
  }> = [];
  let i = 0;
  const template = adNameTemplate.trim() || DEFAULT_AD_NAME_TEMPLATE;
  for (const c of creatives) {
    for (const a of adSets) {
      i++;
      rows.push({
        key: `${c.id}::${a.id}`,
        creative: c,
        adSet: a,
        adName: expandAdNameTemplateClient(template, {
          creativeName: c.creativeName,
          adSetName: a.name,
          accountName,
          batchName,
          index: i,
        }),
        effective: { ...baseCopy, ...c.copyOverride },
      });
    }
  }

  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-line text-ink-subtle">
            <th className="text-left font-medium py-2 pr-3">#</th>
            <th className="text-left font-medium py-2 pr-3">Ad name</th>
            <th className="text-left font-medium py-2 pr-3">Creative</th>
            <th className="text-left font-medium py-2 pr-3">Ad set</th>
            <th className="text-left font-medium py-2 pr-3">Headline</th>
            <th className="text-left font-medium py-2 pr-3">Primary text</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={r.key} className="border-b border-line/50 hover:bg-surface-alt/50">
              <td className="py-2 pr-3 text-ink-subtle">{idx + 1}</td>
              <td className="py-2 pr-3 text-ink font-medium max-w-[260px] truncate" title={r.adName}>
                {r.adName}
              </td>
              <td className="py-2 pr-3 text-ink-muted">{r.creative.creativeName}</td>
              <td className="py-2 pr-3 text-ink-muted max-w-[160px] truncate" title={r.adSet.name}>
                {r.adSet.name}
              </td>
              <td className="py-2 pr-3 text-ink-muted max-w-[180px] truncate" title={r.effective.headline}>
                {r.effective.headline || <span className="text-ink-subtle">—</span>}
              </td>
              <td className="py-2 pr-3 text-ink-muted max-w-[260px] truncate" title={r.effective.message}>
                {r.effective.message || <span className="text-ink-subtle">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Mirror of the backend's `expandAdNameTemplate`. Used for the review preview.
 * Kept in sync with backend/src/services/ad-name-template.ts.
 */
function expandAdNameTemplateClient(
  template: string,
  vars: {
    creativeName: string;
    adSetName: string;
    accountName: string;
    batchName?: string;
    index?: number;
    date?: Date;
  }
): string {
  const d = vars.date ?? new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');

  const subs: Record<string, string | undefined> = {
    creative_name: vars.creativeName,
    creative: vars.creativeName,
    ad_set_name: vars.adSetName,
    ad_set: vars.adSetName,
    adset_name: vars.adSetName,
    adset: vars.adSetName,
    account_name: vars.accountName,
    account: vars.accountName,
    date: `${yyyy}-${mm}-${dd}`,
    date_short: `${mm}/${dd}`,
    batch_name: vars.batchName,
    index: vars.index !== undefined ? String(vars.index) : undefined,
  };

  let result = template.replace(/\{([a-z_]+)\}/gi, (match, rawKey) => {
    const key = String(rawKey).toLowerCase();
    const v = subs[key];
    return v !== undefined && v !== '' ? v : match;
  });
  result = result.replace(/\s{2,}/g, ' ').trim();
  return result || `${vars.creativeName} · ${vars.adSetName}`;
}
