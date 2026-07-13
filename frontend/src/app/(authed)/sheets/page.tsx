'use client';

/**
 * /sheets — Sheet launcher (Patch 4)
 *
 * Flow:
 *   1. Pick account + campaign (active-only toggle mirrors Launch tab)
 *   2. Import: paste a sheet URL (Google / OneDrive / SharePoint) or upload .xlsx/.csv
 *   3. (If multi-tab) pick the sheet tab to use
 *   4. (If columns weren't auto-detected) map your columns to Vass fields
 *   5. Review + launch
 */
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2,
  Upload as UploadIcon,
  AlertCircle,
  CheckCircle2,
  Table2,
  ArrowRight,
  Link2,
  FileSpreadsheet,
  X,
  Pencil,
  RotateCcw,
} from 'lucide-react';
import {
  adAccounts,
  metaExplore,
  sheetImports,
  launches,
  AdAccount,
  MetaCampaign,
  MetaAdSet,
  SheetRow,
  ParsedSheet,
  InspectedSource,
  VassField,
  VASS_FIELD_LABELS,
  VASS_FIELDS_ORDERED,
  DesiredAdStatus,
  Upload,
  META_CTAS,
  DEFAULT_META_CTA,
  ctasForObjective,
  defaultCtaForObjective,
  api,
} from '@/lib/api';
import { AdAccountAvatar } from '@/components/AdAccountAvatar';
import {
  getActiveAdAccountIds,
  VASS_ACTIVE_SCOPE_EVENT,
} from '@/components/BrandSelector';
import { PageHeader, PAGE_TINTS } from '@/components/PageHeader';
import { Toggle } from '@/components/Toggle';
import { NewAdSetForm } from '@/components/NewAdSetForm';

// ============================================================
// Types
// ============================================================

/**
 * One per parsed row. Tracks the creative(s) attached to that row.
 * - `status` is the current state of the PRIMARY (main) creative.
 * - `uploads` holds all uploads attached to this row. The first one is the
 *   "main"; subsequent ones (typically a 9:16) are additional aspect-ratio
 *   variants, matching how Launch tab groups creatives.
 */
interface RowUpload {
  uploadId: string;
  filename: string;
  kind: 'image' | 'video';
  aspectBucket: string | null; // '1_1' | '4_5' | '9_16' | etc.
}

interface RowResolution {
  status: 'pending' | 'downloading' | 'ready' | 'needs_upload' | 'error';
  uploads: RowUpload[];
  error?: string;
}

type AdSetResolution =
  | { kind: 'existing'; adSetId: string }
  | { kind: 'new'; adSetId: string }
  | { kind: 'unresolved' };

// ============================================================
// Page
// ============================================================

// Mirror of backend COLUMN_ALIASES — keep in sync with sheet-parser.ts.
// Used when the user picks a different header row than Vass did, so we can
// re-suggest field mappings client-side.
function clientFieldFromHeader(header: string): VassField | null {
  const k = header.trim().toLowerCase();
  const aliases: Record<string, VassField> = {
    'creative': 'creative', 'image': 'creative', 'video': 'creative',
    'media': 'creative', 'creative url': 'creative', 'asset': 'creative',
    'asset link': 'creative', 'asset url': 'creative',
    'primary text': 'primaryText', 'primary': 'primaryText', 'body': 'primaryText',
    'text': 'primaryText', 'copy': 'primaryText', 'message': 'primaryText',
    'caption': 'primaryText', 'post text': 'primaryText',
    'headline': 'headline', 'title': 'headline',
    'description': 'description', 'link description': 'description',
    'cta': 'cta', 'call to action': 'cta', 'button': 'cta', 'cta type': 'cta',
    'url': 'linkUrl', 'link': 'linkUrl', 'link url': 'linkUrl',
    'website url': 'linkUrl', 'destination': 'linkUrl',
    'destination url': 'linkUrl', 'landing page': 'linkUrl',
    'landing url': 'linkUrl',
    'ad name': 'adName', 'name': 'adName',
    'media format': 'mediaFormat', 'format': 'mediaFormat',
    'ad format': 'mediaFormat', 'ad type': 'mediaFormat', 'type': 'mediaFormat',
  };
  return aliases[k] ?? null;
}

/**
 * Coerce a user-typed destination into the https:// URL the backend requires.
 * Bare domains ("stagestep.com") get an https:// prefix; http:// is upgraded
 * to https://. Empty stays empty (the caller decides if that's an error).
 * Mirrors the backend's linkUrl rule in routes/launches.ts.
 */
function normalizeLinkUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  if (/^https:\/\//i.test(t)) return t;
  if (/^http:\/\//i.test(t)) return t.replace(/^http:\/\//i, 'https://');
  return `https://${t}`;
}

export default function SheetsPage() {
  const router = useRouter();

  // ---- Top: account + campaign ----
  const [activeOnly, setActiveOnly] = useState(true);
  const [accounts, setAccounts] = useState<AdAccount[]>([]);
  const [accountId, setAccountId] = useState('');
  const [campaigns, setCampaigns] = useState<MetaCampaign[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [adSetsList, setAdSetsList] = useState<MetaAdSet[]>([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [loadingAdSets, setLoadingAdSets] = useState(false);

  /**
   * Campaign objective (e.g. "OUTCOME_LEADS", "OUTCOME_SALES"). Fetched from
   * Meta whenever a campaign is selected. Used to filter the per-ad CTA
   * dropdown so users don't pick a CTA Meta will reject at launch time.
   * `null` means: unknown / not yet loaded / no campaign picked.
   */
  const [campaignObjective, setCampaignObjective] = useState<string | null>(null);

  // ---- Sheet import inputs ----
  const [sheetUrl, setSheetUrl] = useState('');
  const [sheetFile, setSheetFile] = useState<File | null>(null);

  // ---- Inspection step ----
  const [inspected, setInspected] = useState<InspectedSource | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState<string>('');

  // ---- Column mapping step ----
  const [columnMap, setColumnMap] = useState<Partial<Record<number, VassField>>>({});
  /** User's override for which row is the header. -1 means "use Vass's guess". */
  const [userHeaderRowIdx, setUserHeaderRowIdx] = useState<number>(-1);

  // ---- Final parse step ----
  const [parsed, setParsed] = useState<ParsedSheet | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  /**
   * Snapshot of the inputs that produced the current `parsed` state. If the
   * user changes tab / header / column mapping after parsing, this no longer
   * matches the live state, and we surface a "Re-parse" hint instead of the
   * stale review.
   */
  const [lastParseInputs, setLastParseInputs] = useState<string | null>(null);

  // ---- Per-row creative resolution ----
  const [resolutions, setResolutions] = useState<Record<number, RowResolution>>({});
  const [resolving, setResolving] = useState(false);

  /**
   * Per-row include checkbox. If a row's index is in this Set, it'll launch.
   * Default: every parsed row is included.
   */
  const [includedRows, setIncludedRows] = useState<Set<number>>(new Set());

  /**
   * Per-row copy overrides (typed by the user via the Edit panel).
   * If a field is undefined, the sheet's value is used.
   */
  const [rowOverrides, setRowOverrides] = useState<Record<number, Partial<{
    primaryText: string;
    headline: string;
    description: string;
    cta: string;
    linkUrl: string;
    adName: string;
    urlTags: string;
    mediaFormat: 'image' | 'video';
  }>>>({});

  /** Which rows currently have their Edit panel expanded. */
  const [editingRows, setEditingRows] = useState<Set<number>>(new Set());

  // ---- Per-ad-set-name resolution ----
  const [adSetMapping, setAdSetMapping] = useState<Record<string, AdSetResolution>>({});
  const [creatingForGroup, setCreatingForGroup] = useState<string | null>(null);

  // ---- Launch state ----
  const [desiredStatus, setDesiredStatus] = useState<DesiredAdStatus>('PAUSED');
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  // ---- Load accounts ----
  useEffect(() => {
    adAccounts.list().then((r) => setAccounts(r.accounts.filter((a) => a.isEnabled)));
  }, []);

  // ---- Scope → account pre-fill (Patch 4.38.1) ----
  useEffect(() => {
    if (accounts.length === 0) return;
    const apply = () => {
      const ids = getActiveAdAccountIds(
        accounts.map((a) => ({ id: a.id, brandId: a.brandId }))
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
  }, [accounts]);

  // ---- Load campaigns when account or activeOnly changes ----
  useEffect(() => {
    setCampaigns([]);
    if (!accountId) return;
    setLoadingCampaigns(true);
    metaExplore
      .listCampaigns(accountId, activeOnly)
      .then((r) => setCampaigns(r.campaigns))
      .catch(() => setCampaigns([]))
      .finally(() => setLoadingCampaigns(false));
  }, [accountId, activeOnly]);

  // Clear campaign selection if it's not in the new list
  useEffect(() => {
    if (!campaignId) return;
    if (campaigns.length > 0 && !campaigns.some((c) => c.id === campaignId)) {
      setCampaignId('');
    }
  }, [campaigns, campaignId]);

  // ---- Load ad sets when campaign changes ----
  useEffect(() => {
    setAdSetsList([]);
    if (!campaignId) return;
    setLoadingAdSets(true);
    metaExplore
      .listAdSets(campaignId, activeOnly)
      .then((r) => setAdSetsList(r.adSets))
      .catch(() => setAdSetsList([]))
      .finally(() => setLoadingAdSets(false));
  }, [campaignId, activeOnly]);

  /**
   * Load the campaign objective whenever the campaign changes. Used to filter
   * the per-ad CTA dropdown to only CTAs Meta accepts for that objective.
   * Doesn't depend on `activeOnly` — objective is a property of the campaign.
   */
  useEffect(() => {
    setCampaignObjective(null);
    if (!campaignId) return;
    let cancelled = false;
    metaExplore
      .getCampaignObjective(campaignId)
      .then((r) => {
        if (!cancelled) setCampaignObjective(r.objective);
      })
      .catch(() => {
        // Silent fallback: objective stays null, full CTA list is shown
      });
    return () => { cancelled = true; };
  }, [campaignId]);

  // ---- Auto-map ad set names to existing ad sets when both are known ----
  useEffect(() => {
    if (!parsed || adSetsList.length === 0) return;
    const next: Record<string, AdSetResolution> = {};
    const uniqueNames = Array.from(new Set(parsed.rows.map((r) => r.adSetName)));
    for (const name of uniqueNames) {
      const exact = adSetsList.find((s) => s.name === name);
      const ci = exact ?? adSetsList.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (ci) {
        next[name] = { kind: 'existing', adSetId: ci.id };
      } else {
        next[name] = adSetMapping[name] ?? { kind: 'unresolved' };
      }
    }
    setAdSetMapping(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, adSetsList]);

  // ---- Derived ----
  const selectedAccount = accounts.find((a) => a.id === accountId);

  const adSetGroups = useMemo(() => {
    if (!parsed) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of parsed.rows) {
      if (!seen.has(row.adSetName)) {
        seen.add(row.adSetName);
        out.push(row.adSetName);
      }
    }
    return out;
  }, [parsed]);

  const totalRows = parsed?.rows.length ?? 0;
  const includedCount = includedRows.size;

  /**
   * Per-objective CTA filter. When a campaign is selected and its objective
   * is known, only CTAs Meta accepts for that objective are shown in the
   * per-ad dropdown. Falls back to the full list when objective is unknown.
   */
  const allowedCtas = useMemo(
    () => ctasForObjective(campaignObjective),
    [campaignObjective]
  );
  /** Default CTA value to pre-select when a row doesn't specify one. */
  const ctaDefault = useMemo(
    () => defaultCtaForObjective(campaignObjective),
    [campaignObjective]
  );

  // Only included rows need to be ready
  const includedReadyCount = useMemo(() => {
    let n = 0;
    for (const idx of includedRows) {
      if (resolutions[idx]?.status === 'ready') n++;
    }
    return n;
  }, [includedRows, resolutions]);

  // Ad set groups that have at least one INCLUDED row
  const activeGroups = useMemo(() => {
    if (!parsed) return [] as string[];
    const groups = new Set<string>();
    for (const idx of includedRows) {
      const r = parsed.rows[idx];
      if (r) groups.add(r.adSetName);
    }
    return Array.from(groups);
  }, [parsed, includedRows]);

  // Both display: total ads ready, and constraint: included rows all ready
  const readyRows = Object.values(resolutions).filter((r) => r.status === 'ready').length;
  const allAdSetsResolved =
    activeGroups.length > 0 &&
    activeGroups.every((name) => {
      const r = adSetMapping[name];
      return r && r.kind !== 'unresolved';
    });
  const allIncludedReady = includedCount > 0 && includedReadyCount === includedCount;
  const canLaunch = allAdSetsResolved && allIncludedReady && !launching;

  // ---- Inspection (Step 1 of import) ----
  async function inspectSheet() {
    setInspectError(null);
    setInspected(null);
    setParsed(null);
    setColumnMap({});
    setUserHeaderRowIdx(-1);
    setSelectedTab('');
    setInspecting(true);
    try {
      let result: InspectedSource;
      if (sheetFile) {
        result = await sheetImports.inspectFile(sheetFile);
      } else if (sheetUrl.trim()) {
        result = await sheetImports.inspectUrl(sheetUrl.trim());
      } else {
        throw new Error('Paste a sheet URL or upload a file');
      }
      setInspected(result);
      setSelectedTab(result.defaultTab);
    } catch (err) {
      setInspectError(err instanceof Error ? err.message : 'Failed to read sheet');
    } finally {
      setInspecting(false);
    }
  }

  // ---- Parse using the chosen tab + column map ----
  async function parseSheetFinal() {
    if (!inspected || !selectedTab) return;
    setParseError(null);
    setParsing(true);
    try {
      const overrides: Partial<Record<number, VassField>> = { ...effectiveColumnMap };
      const headerOverride =
        userHeaderRowIdx >= 0 ? userHeaderRowIdx : undefined;

      // Snapshot the exact inputs so we can detect "dirty" mapping later
      const signature = JSON.stringify({
        tab: selectedTab,
        headerOverride,
        overrides,
      });

      let result: ParsedSheet;
      if (sheetFile) {
        result = await sheetImports.parseFile(sheetFile, selectedTab, overrides, headerOverride);
      } else {
        result = await sheetImports.parseUrl(sheetUrl.trim(), selectedTab, overrides, headerOverride);
      }
      setParsed(result);
      setLastParseInputs(signature);
      setIncludedRows(new Set(result.rows.map((_, idx) => idx)));
      setRowOverrides({});
      setEditingRows(new Set());
      kickOffCreativeResolution(result);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Failed to parse sheet');
    } finally {
      setParsing(false);
    }
  }

  async function kickOffCreativeResolution(p: ParsedSheet) {
    const initial: Record<number, RowResolution> = {};
    const creatives: string[] = [];
    for (let i = 0; i < p.rows.length; i++) {
      const c = p.rows[i].creative?.trim() ?? '';
      creatives.push(c);
      if (!c) {
        initial[i] = { status: 'needs_upload', uploads: [], error: 'No creative in sheet' };
      } else if (!/^https?:\/\//i.test(c)) {
        initial[i] = { status: 'needs_upload', uploads: [], error: 'Not a fetchable URL' };
      } else {
        initial[i] = { status: 'downloading', uploads: [] };
      }
    }
    setResolutions(initial);

    setResolving(true);
    try {
      const r = await sheetImports.resolveCreatives(creatives);
      setResolutions((prev) => {
        const next = { ...prev };
        for (const res of r.results) {
          if (res.ok && res.uploadId) {
            next[res.index] = {
              status: 'ready',
              uploads: [
                {
                  uploadId: res.uploadId,
                  filename: p.rows[res.index].creative ?? 'creative',
                  kind: (res.kind ?? 'image') as 'image' | 'video',
                  aspectBucket: res.aspectBucket ?? null,
                },
              ],
            };
          } else {
            next[res.index] = {
              status: 'needs_upload',
              uploads: [],
              error: res.error ?? 'Download failed',
            };
          }
        }
        return next;
      });
    } catch (err) {
      setResolutions((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(next)) {
          if (next[Number(k)].status === 'downloading') {
            next[Number(k)] = { status: 'needs_upload', uploads: [], error: 'Resolution request failed' };
          }
        }
        return next;
      });
    } finally {
      setResolving(false);
    }
  }

  /**
   * Upload a file for a row.
   * - mode='replace' replaces the row's main creative (preserves any 9:16 attached)
   * - mode='add' appends an additional aspect ratio variant (e.g., 9:16)
   */
  async function handleManualUpload(
    rowIndex: number,
    file: File,
    mode: 'replace' | 'add' = 'replace'
  ) {
    setResolutions((prev) => {
      const existing = prev[rowIndex];
      return {
        ...prev,
        [rowIndex]: {
          status: 'downloading',
          uploads: existing?.uploads ?? [],
        },
      };
    });
    try {
      const r = await api.upload<{ upload: Upload }>('/uploads', file);
      const newUpload: RowUpload = {
        uploadId: r.upload.id,
        filename: r.upload.filename,
        kind: r.upload.kind as 'image' | 'video',
        aspectBucket: r.upload.aspectBucket,
      };
      setResolutions((prev) => {
        const existing = prev[rowIndex];
        const existingUploads = existing?.uploads ?? [];
        const nextUploads =
          mode === 'add'
            ? [...existingUploads, newUpload]
            : // Replace: keep any non-main (9:16) uploads if present, swap main
              existingUploads.length > 1
              ? [newUpload, ...existingUploads.slice(1)]
              : [newUpload];
        return {
          ...prev,
          [rowIndex]: {
            status: 'ready',
            uploads: nextUploads,
          },
        };
      });
    } catch (err) {
      setResolutions((prev) => {
        const existing = prev[rowIndex];
        return {
          ...prev,
          [rowIndex]: {
            status: existing?.uploads.length ? 'ready' : 'needs_upload',
            uploads: existing?.uploads ?? [],
            error: err instanceof Error ? err.message : 'Upload failed',
          },
        };
      });
    }
  }

  /** Remove one upload from a row (by uploadId). Row reverts to needs_upload if empty. */
  function handleRemoveUpload(rowIndex: number, uploadId: string) {
    setResolutions((prev) => {
      const existing = prev[rowIndex];
      if (!existing) return prev;
      const nextUploads = existing.uploads.filter((u) => u.uploadId !== uploadId);
      return {
        ...prev,
        [rowIndex]: {
          status: nextUploads.length > 0 ? 'ready' : 'needs_upload',
          uploads: nextUploads,
          error: nextUploads.length === 0 ? 'Removed — upload a new creative' : undefined,
        },
      };
    });
  }

  function handleNewAdSetForGroup(groupName: string) {
    setCreatingForGroup(groupName);
  }
  function handleAdSetCreated(
    groupName: string,
    newAdSet: { id: string; name: string; status: 'ACTIVE' | 'PAUSED' }
  ) {
    setAdSetMapping((prev) => ({
      ...prev,
      [groupName]: { kind: 'new', adSetId: newAdSet.id },
    }));
    setCreatingForGroup(null);
    setAdSetsList((prev) =>
      prev.some((s) => s.id === newAdSet.id)
        ? prev
        : [
            ...prev,
            {
              id: newAdSet.id,
              name: newAdSet.name,
              status: newAdSet.status,
              effective_status: newAdSet.status,
              campaign_id: campaignId,
            },
          ]
    );
  }

  async function doLaunch() {
    if (!canLaunch || !parsed || !accountId) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      // Group by adSetName, but ONLY rows the user has included
      const byGroup = new Map<string, Array<{ row: SheetRow; idx: number }>>();
      for (let idx = 0; idx < parsed.rows.length; idx++) {
        if (!includedRows.has(idx)) continue;
        const row = parsed.rows[idx];
        if (!byGroup.has(row.adSetName)) byGroup.set(row.adSetName, []);
        byGroup.get(row.adSetName)!.push({ row, idx });
      }

      const batchIds: string[] = [];
      for (const [groupName, items] of byGroup.entries()) {
        const resolution = adSetMapping[groupName];
        if (!resolution || resolution.kind === 'unresolved') continue;

        // Effective per-row values: override wins over sheet, sheet wins over nothing
        const eff = (item: { row: SheetRow; idx: number }) => {
          const o = rowOverrides[item.idx] ?? {};
          const primaryText = o.primaryText ?? item.row.primaryText ?? '';
          return {
            adName: o.adName ?? item.row.adName ?? '',
            primaryText,
            headline: o.headline ?? item.row.headline ?? '',
            // Description defaults to primary text when not explicitly set
            description: o.description ?? item.row.description ?? primaryText,
            cta: o.cta ?? item.row.cta ?? '',
            linkUrl: normalizeLinkUrl(o.linkUrl ?? item.row.linkUrl ?? ''),
            urlTags: o.urlTags ?? '',
          };
        };
        const firstEff = eff(items[0]);
        const creativesForGroup = items
          .map((item, n) => {
            const res = resolutions[item.idx];
            if (!res || res.status !== 'ready' || res.uploads.length === 0) return null;
            const v = eff(item);
            return {
              // Include ALL uploads attached to this row (main + 9:16 if added)
              uploadIds: res.uploads.map((u) => u.uploadId),
              creativeName: v.adName || `${groupName || 'Ad'} ${n + 1}`,
              copyOverride: {
                message: v.primaryText || undefined,
                headline: v.headline || undefined,
                description: v.description || undefined,
                linkUrl: v.linkUrl || undefined,
                callToActionType: v.cta || ctaDefault,
                urlTags: v.urlTags || undefined,
              },
            };
          })
          .filter((c): c is NonNullable<typeof c> => c !== null);

        if (creativesForGroup.length === 0) continue;

        const displayGroupName = groupName || '(unassigned)';
        const result = await launches.create({
          adAccountId: accountId,
          batchName: parsed.campaignLabel
            ? `${parsed.campaignLabel} — ${displayGroupName}`
            : displayGroupName,
          desiredAdStatus: desiredStatus,
          adSets: [
            { adSetId: resolution.adSetId, adSetName: displayGroupName },
          ],
          creatives: creativesForGroup,
          copy: {
            message: firstEff.primaryText || '',
            headline: firstEff.headline || undefined,
            description: firstEff.description || undefined,
            linkUrl: firstEff.linkUrl || '',
            callToActionType: firstEff.cta || ctaDefault,
            urlTags: firstEff.urlTags || undefined,
          },
        });
        batchIds.push(result.batchId);
      }

      if (batchIds.length === 0) {
        throw new Error('Nothing to launch — no included rows had a resolved ad set');
      }
      if (batchIds.length === 1) {
        router.push(`/launches/${batchIds[0]}`);
      } else {
        router.push('/launches');
      }
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : 'Launch failed');
    } finally {
      setLaunching(false);
    }
  }

  // ============================================================
  // Derived flow state
  // ============================================================
  const currentTabInfo = inspected?.tabHeaders[selectedTab];
  const showTabPicker = inspected && inspected.tabs.length > 1;

  // Determine the row index the user is effectively pointing at (their override
  // or Vass's auto-pick). Used for the column mapping UI.
  const effectiveHeaderRowIdx = useMemo(() => {
    if (!currentTabInfo) return -1;
    return userHeaderRowIdx >= 0 ? userHeaderRowIdx : currentTabInfo.headerRowIdx;
  }, [currentTabInfo, userHeaderRowIdx]);

  // Build effective headers & auto-detection FROM the chosen header row.
  // If the user overrides, we re-run alias matching on that row's cells.
  const effectiveHeaders = useMemo(() => {
    if (!currentTabInfo || effectiveHeaderRowIdx < 0) return [];
    const row = currentTabInfo.preview[effectiveHeaderRowIdx] ?? [];
    return row.map((c) => String(c ?? '').trim());
  }, [currentTabInfo, effectiveHeaderRowIdx]);

  const effectiveAutoMap = useMemo<Array<VassField | null>>(() => {
    if (!currentTabInfo || effectiveHeaderRowIdx < 0) return [];
    // If user picked the same row Vass picked, reuse backend's autoMap (more authoritative).
    if (effectiveHeaderRowIdx === currentTabInfo.headerRowIdx) {
      return currentTabInfo.autoMap;
    }
    // Otherwise, client-side detection on the chosen row's cells using the
    // same alias map as the backend. Mirrors backend COLUMN_ALIASES — keep in sync.
    return effectiveHeaders.map((h) => clientFieldFromHeader(h));
  }, [currentTabInfo, effectiveHeaderRowIdx, effectiveHeaders]);

  // Combined map for the column mapping UI: auto + overrides
  const effectiveColumnMap: Partial<Record<number, VassField>> = useMemo(() => {
    const out: Partial<Record<number, VassField>> = {};
    effectiveAutoMap.forEach((f, i) => {
      if (f) out[i] = f;
    });
    for (const [k, v] of Object.entries(columnMap)) {
      if (v) out[Number(k)] = v;
    }
    return out;
  }, [effectiveAutoMap, columnMap]);

  /**
   * Parse can proceed as long as at least one Vass field is mapped to a
   * column. Ad set is detected from section-divider rows, not from columns —
   * so there's no required column.
   */
  const hasAnyMapping = useMemo(() => {
    return Object.values(effectiveColumnMap).some((v) => !!v);
  }, [effectiveColumnMap]);

  /**
   * Signature of what we'd send to /parse RIGHT NOW. Compared against
   * `lastParseInputs` to detect when the user changed something after parsing.
   */
  const currentParseSignature = useMemo(() => {
    if (!inspected || !selectedTab) return '';
    const headerOverride =
      userHeaderRowIdx >= 0 ? userHeaderRowIdx : undefined;
    return JSON.stringify({
      tab: selectedTab,
      headerOverride,
      overrides: effectiveColumnMap,
    });
  }, [inspected, selectedTab, userHeaderRowIdx, effectiveColumnMap]);

  /**
   * True when mapping/header/tab changed since the last parse. While dirty,
   * the review step is hidden so users don't act on stale data.
   */
  const isMappingDirty =
    !!parsed && !!lastParseInputs && currentParseSignature !== lastParseInputs;

  /**
   * Show the mapping UI:
   *   - before first parse (always — user needs to confirm mappings)
   *   - after parse if mapping became dirty (so user can re-parse)
   */
  const showColumnMapUI = inspected && currentTabInfo && (!parsed || isMappingDirty);

  // ============================================================
  // Render
  // ============================================================

  return (
    <div className="w-full space-y-6">
      <PageHeader
        icon={Table2}
        title="Sheet launcher"
        description="Bulk-launch ads from a spreadsheet. Supports Google Sheets, OneDrive, SharePoint, and direct .xlsx/.csv uploads."
        tint={PAGE_TINTS.sheets}
        activeOnly={activeOnly}
        onActiveOnlyChange={setActiveOnly}
      />

      {/* ---- 1. Account + Campaign ---- */}
      <Section title="1. Where to launch">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Ad account">
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="input w-full text-sm bg-surface"
            >
              <option value="">Pick an account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            {selectedAccount && (
              <div className="mt-1.5 flex items-center gap-1.5 text-2xs text-ink-subtle">
                <AdAccountAvatar
                  name={selectedAccount.name}
                  pictureUrl={selectedAccount.pictureUrl}
                  size={14}
                />
                <span>{selectedAccount.metaAccountId}</span>
              </div>
            )}
          </Field>
          <Field label="Campaign">
            <select
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
              disabled={!accountId || loadingCampaigns}
              className="input w-full text-sm bg-surface disabled:opacity-60"
            >
              <option value="">
                {!accountId
                  ? 'Pick an account first'
                  : loadingCampaigns
                  ? 'Loading…'
                  : 'Pick a campaign…'}
              </option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
        </div>
      </Section>

      {/* ---- 2. Import sheet ---- */}
      <Section title="2. Import sheet">
        {!inspected ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-3 items-end">
              <Field label="Sheet URL (Google Sheets, OneDrive, or SharePoint)">
                <div className="relative">
                  <Link2 size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
                  <input
                    type="text"
                    value={sheetUrl}
                    onChange={(e) => {
                      setSheetUrl(e.target.value);
                      if (e.target.value) setSheetFile(null);
                    }}
                    placeholder="https://… (must be 'Anyone with link can view')"
                    className="input w-full text-sm pl-8"
                    disabled={!!sheetFile}
                  />
                </div>
              </Field>
              <div className="text-2xs text-ink-subtle text-center md:pb-2.5">or</div>
              <Field label="Upload .xlsx or .csv">
                <label className="flex items-center gap-2 input cursor-pointer hover:border-accent transition-colors text-sm">
                  <FileSpreadsheet size={14} className="text-ink-subtle" />
                  <span className="flex-1 truncate text-ink-muted">
                    {sheetFile ? sheetFile.name : 'Choose a file…'}
                  </span>
                  {sheetFile && (
                    <button
                      type="button"
                      onClick={(e) => { e.preventDefault(); setSheetFile(null); }}
                      className="text-ink-subtle hover:text-danger"
                    >
                      <X size={14} />
                    </button>
                  )}
                  <input
                    type="file"
                    accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) {
                        setSheetFile(f);
                        setSheetUrl('');
                      }
                    }}
                    className="hidden"
                  />
                </label>
              </Field>
            </div>
            {inspectError && (
              <div className="text-xs text-danger flex items-start gap-1.5">
                <AlertCircle size={12} className="mt-0.5 shrink-0" /> {inspectError}
              </div>
            )}
            <button
              type="button"
              onClick={inspectSheet}
              disabled={inspecting || (!sheetUrl && !sheetFile)}
              className="btn-primary text-sm"
            >
              {inspecting ? (
                <><Loader2 size={14} className="animate-spin" /> Reading…</>
              ) : (
                <>Read sheet <ArrowRight size={14} /></>
              )}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs text-ink-muted">
                Source: <b>{sheetFile ? sheetFile.name : sheetUrl.slice(0, 50) + (sheetUrl.length > 50 ? '…' : '')}</b>
                {' · '}
                {inspected.tabs.length} sheet{inspected.tabs.length === 1 ? '' : 's'} found
              </div>
              <button
                type="button"
                onClick={() => {
                  setInspected(null);
                  setParsed(null);
                  setResolutions({});
                  setAdSetMapping({});
                  setColumnMap({});
                  setUserHeaderRowIdx(-1);
                  setSheetFile(null);
                  setSheetUrl('');
                  setSelectedTab('');
                }}
                className="text-xs text-ink-muted hover:text-ink"
              >
                Re-import
              </button>
            </div>

            {/* Tab picker — ALWAYS shown (Vass shouldn't hide which sheet was picked) */}
            <Field
              label={
                inspected.tabs.length === 1
                  ? 'Sheet'
                  : `Which sheet has the ads? (${inspected.tabs.length} sheets in this file)`
              }
            >
              <select
                value={selectedTab}
                onChange={(e) => {
                  setSelectedTab(e.target.value);
                  setColumnMap({}); // reset overrides for new tab
                  setUserHeaderRowIdx(-1);
                  setParsed(null);
                }}
                className="input w-full md:w-96 text-sm bg-surface"
              >
                {inspected.tabs.map((t) => {
                  const info = inspected.tabHeaders[t];
                  const ok = info?.autoComplete;
                  return (
                    <option key={t} value={t}>
                      {t}
                      {info ? ` · ${info.approxDataRows} rows${ok ? ' · auto-detected' : ''}` : ''}
                    </option>
                  );
                })}
              </select>
            </Field>

            {/* Sheet preview — click any row to mark it as the header */}
            {currentTabInfo && currentTabInfo.preview.length > 0 && (
              <Field label="Sheet preview — click the row that holds your column headers">
                <div className="border border-line rounded overflow-x-auto bg-surface">
                  <table className="text-xs w-full">
                    <tbody>
                      {currentTabInfo.preview.map((row, rIdx) => {
                        const effectiveHeaderIdx =
                          userHeaderRowIdx >= 0 ? userHeaderRowIdx : currentTabInfo.headerRowIdx;
                        const isHeader = rIdx === effectiveHeaderIdx;
                        return (
                          <tr
                            key={rIdx}
                            onClick={() => {
                              setUserHeaderRowIdx(rIdx);
                              setColumnMap({});
                            }}
                            className={`cursor-pointer transition-colors border-b border-line/50 ${
                              isHeader ? 'bg-accent text-white' : 'hover:bg-surface-hover'
                            }`}
                          >
                            <td
                              className={`px-2 py-1 font-mono shrink-0 ${
                                isHeader ? 'text-white/70' : 'text-ink-subtle'
                              }`}
                            >
                              {rIdx + 1}
                            </td>
                            {row.slice(0, 12).map((cell, cIdx) => (
                              <td
                                key={cIdx}
                                className={`px-2 py-1 max-w-[140px] truncate ${
                                  isHeader ? 'font-bold' : ''
                                }`}
                                title={cell}
                              >
                                {cell || (
                                  <span className={isHeader ? 'text-white/40' : 'text-ink-subtle'}>—</span>
                                )}
                              </td>
                            ))}
                            {row.length > 12 && (
                              <td
                                className={`px-2 py-1 italic ${
                                  isHeader ? 'text-white/60' : 'text-ink-subtle'
                                }`}
                              >
                                +{row.length - 12} more
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="text-2xs text-ink-subtle mt-1.5">
                  Vass auto-picked row {currentTabInfo.headerRowIdx + 1}
                  {userHeaderRowIdx >= 0 && userHeaderRowIdx !== currentTabInfo.headerRowIdx && (
                    <> — overridden to row {userHeaderRowIdx + 1}</>
                  )}
                  . Click a different row above to change.
                </div>
              </Field>
            )}

            {/* Column mapping — direction: Vass field ← your column */}
            {showColumnMapUI && currentTabInfo && (
              <div className="card border-amber-200 bg-amber-50 space-y-3">
                <div>
                  <div className="h-sub text-amber-900">
                    Map Vass fields to your columns
                  </div>
                  <div className="text-xs text-amber-800 mt-0.5">
                    For each Vass field, pick the column in your sheet that
                    holds that value. Each column can only be used once.
                  </div>
                </div>
                <div className="space-y-1.5">
                  {VASS_FIELDS_ORDERED.map((f) => {
                    // Which sheet column (if any) is currently assigned to this Vass field?
                    const ownerEntry = Object.entries(effectiveColumnMap).find(
                      ([, v]) => v === f.key
                    );
                    const ownerColIdx = ownerEntry ? Number(ownerEntry[0]) : null;
                    return (
                      <div key={f.key} className="flex items-center gap-2 text-xs">
                        <div className="font-medium text-amber-900 shrink-0 min-w-[140px]">
                          {VASS_FIELD_LABELS[f.key]}
                        </div>
                        <span className="text-ink-subtle">←</span>
                        <select
                          value={ownerColIdx ?? ''}
                          onChange={(e) => {
                            const newColIdxRaw = e.target.value;
                            setColumnMap((prev) => {
                              const next = { ...prev };
                              // Clear any column currently mapped to this Vass field
                              for (const [k, v] of Object.entries(next)) {
                                if (v === f.key) delete next[Number(k)];
                              }
                              if (newColIdxRaw === '') return next;
                              const newColIdx = Number(newColIdxRaw);
                              // Steal: if the chosen column is currently mapped to
                              // a DIFFERENT Vass field, clear that mapping
                              if (next[newColIdx] && next[newColIdx] !== f.key) {
                                delete next[newColIdx];
                              }
                              next[newColIdx] = f.key;
                              return next;
                            });
                          }}
                          className="input text-xs bg-surface flex-1 max-w-[280px]"
                        >
                          <option value="">— None —</option>
                          {effectiveHeaders.map((h, idx) => {
                            if (!h) return null;
                            // Which Vass field (if any) currently owns THIS column?
                            const ownedBy = effectiveColumnMap[idx];
                            const ownedByOther = ownedBy && ownedBy !== f.key;
                            return (
                              <option key={idx} value={idx} disabled={!!ownedByOther}>
                                {h}
                                {ownedByOther && ` — used by ${VASS_FIELD_LABELS[ownedBy as VassField]}`}
                              </option>
                            );
                          })}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {parseError && (
              <div className="text-xs text-danger flex items-start gap-1.5">
                <AlertCircle size={12} className="mt-0.5 shrink-0" /> {parseError}
              </div>
            )}

            {/* Confirm mapping + Parse button. Always visible after a tab is
                picked. Label changes based on parse state. */}
            <button
              type="button"
              onClick={parseSheetFinal}
              disabled={parsing || !selectedTab || !hasAnyMapping}
              className="btn-primary text-sm"
            >
              {parsing ? (
                <><Loader2 size={14} className="animate-spin" /> Parsing…</>
              ) : !parsed ? (
                <>Confirm mapping & parse <ArrowRight size={14} /></>
              ) : isMappingDirty ? (
                <><RotateCcw size={14} /> Re-parse with new mapping</>
              ) : (
                <>Re-parse <RotateCcw size={14} /></>
              )}
            </button>

            {parsed && !isMappingDirty && (
              <div className="text-xs text-ink-muted">
                <b>{parsed.rows.length} ad{parsed.rows.length === 1 ? '' : 's'}</b> across{' '}
                <b>{adSetGroups.length} ad set{adSetGroups.length === 1 ? '' : 's'}</b>
                {parsed.campaignLabel && (
                  <span className="text-ink-subtle"> · Sheet label: &quot;{parsed.campaignLabel}&quot;</span>
                )}
              </div>
            )}

            {isMappingDirty && (
              <div className="card border-amber-200 bg-amber-50 text-xs text-amber-900">
                Mapping changed — click <b>Re-parse with new mapping</b> above to
                update the ads list. The current review is from your previous mapping.
              </div>
            )}

            {parsed && parsed.warnings.length > 0 && (
              <div className="card border-amber-200 bg-amber-50 text-xs space-y-1">
                <div className="font-medium text-amber-900">Warnings:</div>
                {parsed.warnings.map((w, i) => (
                  <div key={i} className="text-amber-800">• {w}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </Section>

      {/* ---- 3. Review + launch ---- */}
      {parsed && campaignId && !isMappingDirty && (
        <Section
          title="3. Review and launch"
          subtitle={
            <>
              {includedRows.size} of {totalRows} ads selected ·{' '}
              {readyRows} of {totalRows} creative{totalRows === 1 ? '' : 's'} ready ·{' '}
              {adSetGroups.filter((n) => adSetMapping[n]?.kind !== 'unresolved').length} of {adSetGroups.length} ad sets mapped
              {resolving && <span className="text-accent"> · Resolving creatives…</span>}
            </>
          }
        >
          <div className="space-y-4">
            {/* Bulk select toolbar */}
            <div className="flex items-center gap-3 text-xs text-ink-muted">
              <button
                type="button"
                onClick={() => {
                  if (!parsed) return;
                  setIncludedRows(new Set(parsed.rows.map((_, i) => i)));
                }}
                className="px-2 py-1 rounded border border-line hover:border-accent hover:text-accent transition-colors"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => setIncludedRows(new Set())}
                className="px-2 py-1 rounded border border-line hover:border-accent hover:text-accent transition-colors"
              >
                Deselect all
              </button>
              <span className="ml-auto">
                {includedRows.size} of {totalRows} selected
              </span>
            </div>

            {adSetGroups.map((groupName) => {
              const groupRows = parsed.rows
                .map((r, i) => ({ row: r, idx: i }))
                .filter(({ row }) => row.adSetName === groupName);
              const resolution = adSetMapping[groupName];
              const isCreating = creatingForGroup === groupName;

              return (
                <div key={groupName} className="card space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="h-sub text-ink">
                        {groupName || (
                          <span className="italic text-ink-muted">
                            No ad set name in sheet
                          </span>
                        )}
                      </div>
                      <div className="text-2xs text-ink-subtle mt-0.5">
                        {groupRows.length} ad{groupRows.length === 1 ? '' : 's'} in this group
                        {!groupName && <> · pick an existing ad set or create a new one</>}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <select
                        value={
                          resolution?.kind === 'existing' || resolution?.kind === 'new'
                            ? resolution.adSetId
                            : ''
                        }
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === '__new__') {
                            handleNewAdSetForGroup(groupName);
                          } else if (v) {
                            setAdSetMapping((prev) => ({
                              ...prev,
                              [groupName]: { kind: 'existing', adSetId: v },
                            }));
                          } else {
                            setAdSetMapping((prev) => ({
                              ...prev,
                              [groupName]: { kind: 'unresolved' },
                            }));
                          }
                        }}
                        disabled={loadingAdSets}
                        className="input text-xs bg-surface min-w-[200px]"
                      >
                        <option value="">Pick an ad set…</option>
                        {adSetsList.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} {s.effective_status !== 'ACTIVE' && `(${s.effective_status})`}
                          </option>
                        ))}
                        <option value="__new__">+ Create new ad set</option>
                      </select>
                    </div>
                  </div>

                  {isCreating && selectedAccount && (
                    <NewAdSetForm
                      adAccountId={accountId}
                      metaCampaignId={campaignId}
                      accountPageId={selectedAccount.pageId ?? null}
                      defaultCurrency={selectedAccount.currency ?? 'USD'}
                      onCreated={(ad) => handleAdSetCreated(groupName, ad)}
                      onCancel={() => setCreatingForGroup(null)}
                    />
                  )}

                  {/* Per-group UTM cascade. Applies a UTM string to every row
                      in this ad-set group at once. Individual rows can still
                      override their own value via the per-ad Edit panel. */}
                  <GroupUtmInput
                    groupRowIndices={groupRows.map(({ idx }) => idx)}
                    onApply={(utm) => {
                      setRowOverrides((prev) => {
                        const next = { ...prev };
                        for (const { idx } of groupRows) {
                          next[idx] = { ...(next[idx] ?? {}), urlTags: utm };
                        }
                        return next;
                      });
                    }}
                  />

                  <div className="space-y-1.5">
                    {groupRows.map(({ row, idx }) => {
                      const res = resolutions[idx];
                      const included = includedRows.has(idx);
                      const editing = editingRows.has(idx);
                      const overrides = rowOverrides[idx] ?? {};
                      return (
                        <RowItem
                          key={idx}
                          row={row}
                          rowIdx={idx}
                          resolution={res}
                          included={included}
                          editing={editing}
                          overrides={overrides}
                          onToggleInclude={() => {
                            setIncludedRows((prev) => {
                              const next = new Set(prev);
                              if (next.has(idx)) next.delete(idx);
                              else next.add(idx);
                              return next;
                            });
                          }}
                          onToggleEdit={() => {
                            setEditingRows((prev) => {
                              const next = new Set(prev);
                              if (next.has(idx)) next.delete(idx);
                              else next.add(idx);
                              return next;
                            });
                          }}
                          onUpdateOverride={(field, value) => {
                            setRowOverrides((prev) => ({
                              ...prev,
                              [idx]: { ...(prev[idx] ?? {}), [field]: value },
                            }));
                          }}
                          onUpload={(file) => handleManualUpload(idx, file, 'replace')}
                          onUploadAdditional={(file) => handleManualUpload(idx, file, 'add')}
                          onRemoveUpload={(uploadId) => handleRemoveUpload(idx, uploadId)}
                          allowedCtas={allowedCtas}
                          ctaDefault={ctaDefault}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}

            <div className="card flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-ink-muted">Launch ads as</span>
                <select
                  value={desiredStatus}
                  onChange={(e) => setDesiredStatus(e.target.value as DesiredAdStatus)}
                  className="input text-sm bg-surface"
                >
                  <option value="PAUSED">Paused (safe)</option>
                  <option value="ACTIVE">Active (live)</option>
                </select>
              </div>
              {launchError && (
                <div className="text-xs text-danger flex items-center gap-1.5">
                  <AlertCircle size={12} /> {launchError}
                </div>
              )}
              <button
                type="button"
                onClick={doLaunch}
                disabled={!canLaunch}
                className="btn-primary text-sm"
              >
                {launching ? (
                  <><Loader2 size={14} className="animate-spin" /> Launching…</>
                ) : (
                  <>Launch {includedCount} ad{includedCount === 1 ? '' : 's'} <ArrowRight size={14} /></>
                )}
              </button>
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}

// ============================================================
// Subcomponents
// ============================================================

function RowItem({
  row,
  rowIdx,
  resolution,
  included,
  editing,
  overrides,
  onToggleInclude,
  onToggleEdit,
  onUpdateOverride,
  onUpload,
  onUploadAdditional,
  onRemoveUpload,
  allowedCtas,
  ctaDefault,
}: {
  row: SheetRow;
  rowIdx: number;
  resolution: RowResolution | undefined;
  included: boolean;
  editing: boolean;
  overrides: Partial<{
    primaryText: string;
    headline: string;
    description: string;
    cta: string;
    linkUrl: string;
    adName: string;
    urlTags: string;
    mediaFormat: 'image' | 'video';
  }>;
  onToggleInclude: () => void;
  onToggleEdit: () => void;
  onUpdateOverride: (field: keyof typeof overrides, value: string) => void;
  onUpload: (file: File) => void;
  onUploadAdditional: (file: File) => void;
  onRemoveUpload: (uploadId: string) => void;
  /** Filtered list of CTAs Meta accepts for the current campaign's objective. */
  allowedCtas: Array<{ value: string; label: string }>;
  /** Default CTA when the row doesn't specify one. */
  ctaDefault: string;
}) {
  const status = resolution?.status ?? 'pending';
  const uploads = resolution?.uploads ?? [];
  const mainUpload = uploads[0];

  // Effective values: override wins over sheet value. Description defaults
  // to primary text when not explicitly set anywhere. UTM has no sheet
  // fallback — it's Vass-only state set via the per-row or per-group input.
  const eff = {
    adName: overrides.adName ?? row.adName ?? '',
    primaryText: overrides.primaryText ?? row.primaryText ?? '',
    headline: overrides.headline ?? row.headline ?? '',
    description: overrides.description ?? row.description ?? '',
    cta: overrides.cta ?? row.cta ?? '',
    linkUrl: overrides.linkUrl ?? row.linkUrl ?? '',
    urlTags: overrides.urlTags ?? '',
    mediaFormat: (overrides.mediaFormat ?? row.mediaFormat ?? null) as 'image' | 'video' | null,
  };
  // Effective description: if user hasn't set it AND sheet didn't, use primary
  // text as the placeholder/default
  const descPlaceholder = !eff.description && eff.primaryText ? eff.primaryText : '';

  // Aspect coverage: do we have a feed (1:1 / 4:5) AND a story (9:16)?
  const buckets = new Set(uploads.map((u) => u.aspectBucket));
  const hasFeed = buckets.has('1_1') || buckets.has('4_5') || buckets.has('feed');
  const hasStory = buckets.has('9_16') || buckets.has('story');
  // Suggest the missing one (mirrors Launch tab logic)
  const suggestedRatio: '4:5' | '9:16' | null =
    !uploads.length ? null
      : hasFeed && hasStory ? null
      : hasStory ? '4:5'
      : '9:16';

  return (
    <div
      className={`rounded border ${
        included ? 'border-line bg-surface-alt/40' : 'border-line/50 bg-surface-alt/20 opacity-60'
      } transition-opacity`}
    >
      {/* Summary row */}
      <div className="flex items-center gap-3 px-2.5 py-2">
        {/* Include checkbox */}
        <input
          type="checkbox"
          checked={included}
          onChange={onToggleInclude}
          className="shrink-0 w-3.5 h-3.5 accent-accent cursor-pointer"
          title={included ? 'Click to skip this ad' : 'Click to include this ad'}
        />

        {/* Status indicator */}
        <div className="shrink-0 w-5 h-5 flex items-center justify-center">
          {status === 'downloading' && <Loader2 size={14} className="animate-spin text-accent" />}
          {status === 'ready' && <CheckCircle2 size={14} className="text-success" />}
          {(status === 'needs_upload' || status === 'error') && (
            <AlertCircle size={14} className="text-amber-500" />
          )}
        </div>

        {/* Thumbnail strip (small) */}
        <div className="shrink-0 flex gap-1">
          {uploads.length > 0 ? (
            uploads.slice(0, 2).map((u) => (
              <CreativeThumb key={u.uploadId} upload={u} small />
            ))
          ) : (
            <div className="w-8 h-8 rounded bg-surface-alt border border-line/60" />
          )}
        </div>

        {/* Row info */}
        <div className="flex-1 min-w-0">
          <div className="text-xs text-ink truncate">
            <span className="text-ink-subtle font-mono mr-2">r{row.rowIndex}</span>
            {eff.adName ? (
              <span className="text-ink">{eff.adName}</span>
            ) : eff.headline ? (
              <span className="text-ink-muted truncate">{eff.headline}</span>
            ) : (
              <span className="text-ink-subtle italic">unnamed</span>
            )}
          </div>
          <div className="text-2xs text-ink-subtle truncate mt-0.5">
            {status === 'ready' && mainUpload && (
              <>{mainUpload.filename} · {mainUpload.kind}
                {uploads.length > 1 && ` · +${uploads.length - 1} more`}</>
            )}
            {status === 'downloading' && 'Downloading…'}
            {status === 'needs_upload' && (resolution?.error ?? 'No creative')}
            {status === 'error' && (resolution?.error ?? 'Failed')}
          </div>
        </div>

        {/* Upload button if creative missing */}
        {(status === 'needs_upload' || status === 'error') && (
          <label className="cursor-pointer text-xs font-medium px-2 py-1 rounded border border-line hover:border-accent hover:text-accent transition-colors flex items-center gap-1.5">
            <UploadIcon size={12} />
            Upload
            <input
              type="file"
              accept="image/*,video/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUpload(f);
              }}
            />
          </label>
        )}

        {/* Edit toggle */}
        <button
          type="button"
          onClick={onToggleEdit}
          className={`text-xs font-medium px-2 py-1 rounded border transition-colors flex items-center gap-1.5 ${
            editing
              ? 'border-accent text-accent bg-accent/5'
              : 'border-line hover:border-accent hover:text-accent'
          }`}
        >
          <Pencil size={12} />
          {editing ? 'Close' : 'Edit'}
        </button>
      </div>

      {/* Edit panel — preview on left, fields on right */}
      {editing && (
        <div className="border-t border-line/50 px-3 py-3 bg-surface">
          <div className="flex gap-4">
            {/* LEFT: creative preview + upload buttons */}
            <div className="shrink-0 w-32 space-y-2">
              <div className="text-2xs font-medium text-ink-muted">Creatives</div>
              <div className="flex flex-col gap-1.5">
                {uploads.length === 0 ? (
                  <div className="w-32 h-40 rounded border border-dashed border-line/80 bg-surface-alt/40 flex items-center justify-center text-2xs text-ink-subtle">
                    No creative
                  </div>
                ) : (
                  uploads.map((u) => (
                    <CreativeThumb
                      key={u.uploadId}
                      upload={u}
                      onRemove={() => onRemoveUpload(u.uploadId)}
                    />
                  ))
                )}
              </div>

              {/* Upload first creative (only when none) */}
              {uploads.length === 0 && (
                <label className="flex items-center justify-center gap-1.5 cursor-pointer text-2xs font-medium px-2 py-1.5 rounded border border-line hover:border-accent hover:text-accent transition-colors">
                  <UploadIcon size={11} />
                  Upload
                  <input
                    type="file"
                    accept="image/*,video/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onUpload(f);
                    }}
                  />
                </label>
              )}

              {/* Add another aspect ratio. Suggests 9:16 if feed-only, 4:5 if story-only,
                  or "+ Add another" if both are present (advanced cases). */}
              {uploads.length > 0 && (
                <label className="flex items-center justify-center gap-1.5 cursor-pointer text-2xs font-medium px-2 py-1.5 rounded border border-dashed border-accent/50 text-accent hover:bg-accent/5 transition-colors">
                  {suggestedRatio ? `+ Add ${suggestedRatio}` : '+ Add another'}
                  <input
                    type="file"
                    accept="image/*,video/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onUploadAdditional(f);
                    }}
                  />
                </label>
              )}

              {/* Media format radio */}
              <div className="pt-1.5 border-t border-line/40">
                <div className="text-2xs font-medium text-ink-muted mb-1">Format</div>
                <div className="flex gap-1">
                  {(['image', 'video'] as const).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => onUpdateOverride('mediaFormat', kind)}
                      className={`flex-1 text-2xs px-1.5 py-1 rounded border transition-colors ${
                        eff.mediaFormat === kind
                          ? 'border-accent text-accent bg-accent/5'
                          : 'border-line text-ink-muted hover:border-accent'
                      }`}
                    >
                      {kind === 'image' ? 'Image' : 'Video'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* RIGHT: copy fields */}
            <div className="flex-1 space-y-2.5">
              <SmallField label="Ad name">
                <input
                  type="text"
                  value={eff.adName}
                  onChange={(e) => onUpdateOverride('adName', e.target.value)}
                  className="input w-full text-xs"
                  placeholder="Auto-generated if left blank"
                />
              </SmallField>
              <SmallField label="Primary text (body)">
                <textarea
                  value={eff.primaryText}
                  onChange={(e) => onUpdateOverride('primaryText', e.target.value)}
                  rows={3}
                  className="input w-full text-xs resize-y"
                />
              </SmallField>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <SmallField label="Headline">
                  <input
                    type="text"
                    value={eff.headline}
                    onChange={(e) => onUpdateOverride('headline', e.target.value)}
                    className="input w-full text-xs"
                  />
                </SmallField>
                <SmallField label="Description (defaults to primary text)">
                  <input
                    type="text"
                    value={eff.description}
                    onChange={(e) => onUpdateOverride('description', e.target.value)}
                    className="input w-full text-xs"
                    placeholder={descPlaceholder ? descPlaceholder.slice(0, 50) + (descPlaceholder.length > 50 ? '…' : '') : ''}
                  />
                </SmallField>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <SmallField label="CTA (required)">
                  <select
                    value={eff.cta || ctaDefault}
                    onChange={(e) => onUpdateOverride('cta', e.target.value)}
                    className="input w-full text-xs bg-surface"
                  >
                    {allowedCtas.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                    {/* If the row's current CTA isn't in the allowed list for
                        the campaign's objective, still show it so the user can
                        see what's there — but flag it as risky. They can pick
                        from the supported list above. */}
                    {eff.cta && !allowedCtas.some((c) => c.value === eff.cta) && (
                      <option value={eff.cta}>
                        ⚠ {eff.cta} — may be rejected by Meta
                      </option>
                    )}
                  </select>
                </SmallField>
                <SmallField label="Link URL">
                  <input
                    type="url"
                    value={eff.linkUrl}
                    onChange={(e) => onUpdateOverride('linkUrl', e.target.value)}
                    className="input w-full text-xs"
                    placeholder="https://"
                  />
                </SmallField>
              </div>
              <SmallField label="URL parameters (UTM tracking, optional)">
                <input
                  type="text"
                  value={eff.urlTags}
                  onChange={(e) => onUpdateOverride('urlTags', e.target.value)}
                  className="input w-full text-xs font-mono"
                  placeholder="utm_source=fb&utm_medium=cpc&utm_campaign=spring"
                />
                <div className="text-2xs text-ink-subtle mt-1 leading-relaxed">
                  Meta appends these to the destination URL on click. Leave
                  blank to skip. Supports tokens like {`{{ad.name}}`}, {`{{campaign.name}}`}.
                </div>
              </SmallField>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Small inline thumbnail for an upload. Pulls from /uploads/{id}/file which
 * streams the bytes. Videos render as a black box with "VIDEO" label since
 * full <video> previews here would be heavy.
 */
function CreativeThumb({
  upload,
  small,
  onRemove,
}: {
  upload: RowUpload;
  small?: boolean;
  onRemove?: () => void;
}) {
  const sz = small ? 'w-8 h-8' : 'w-32 h-40';
  const labelSz = small ? 'text-[8px]' : 'text-2xs';
  const isVideo = upload.kind === 'video';
  return (
    <div
      className={`${sz} rounded overflow-hidden bg-surface-alt border border-line/60 flex items-center justify-center relative group`}
      title={`${upload.filename} (${upload.aspectBucket ?? '?'})`}
    >
      {isVideo ? (
        <div className={`${labelSz} font-medium text-ink-muted`}>VIDEO</div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/uploads/${upload.uploadId}/file`}
          alt={upload.filename}
          className="w-full h-full object-cover"
        />
      )}
      {!small && upload.aspectBucket && (
        <div className={`absolute bottom-0 right-0 ${labelSz} bg-black/60 text-white px-1`}>
          {upload.aspectBucket.replace('_', ':')}
        </div>
      )}
      {/* Remove ✕ — only shown when onRemove is provided. Visible on hover; for
          mobile/touch it stays visible always when present. */}
      {onRemove && !small && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
          className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 text-white flex items-center justify-center hover:bg-red-600 transition-colors opacity-0 group-hover:opacity-100"
          aria-label="Remove this creative"
          title="Remove this creative"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

function SmallField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-2xs font-medium text-ink-muted mb-1">{label}</div>
      {children}
    </label>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="h-sub text-ink">{title}</h2>
        {subtitle && <div className="text-xs text-ink-muted mt-0.5">{subtitle}</div>}
      </div>
      {children}
    </section>
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
 * Per-group UTM input.
 *
 * Sits in the header area of each ad-set group on the Review step. User types
 * a URL-params string (e.g., "utm_source=fb&utm_medium=cpc&utm_campaign=spring")
 * and clicks Apply to push it onto every row in the group at once. Individual
 * rows can still override the value via their own Edit panel.
 *
 * Collapsed by default so the section doesn't get noisy when UTM isn't needed.
 */
function GroupUtmInput({
  groupRowIndices,
  onApply,
}: {
  groupRowIndices: number[];
  onApply: (utm: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState('');

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="text-2xs font-medium text-ink-muted hover:text-accent transition-colors flex items-center gap-1"
      >
        + URL parameters for this group
      </button>
    );
  }

  return (
    <div className="flex items-stretch gap-2 px-3 py-2.5 rounded border border-line bg-surface-alt/50">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="utm_source=fb&utm_medium=cpc&utm_campaign=…"
        className="input flex-1 text-xs font-mono"
      />
      <button
        type="button"
        onClick={() => {
          onApply(value.trim());
          setExpanded(false);
        }}
        disabled={!value.trim()}
        className="btn-primary text-xs px-3 py-1.5 shrink-0"
        title={`Apply to all ${groupRowIndices.length} ads in this group`}
      >
        Apply to {groupRowIndices.length} ad{groupRowIndices.length === 1 ? '' : 's'}
      </button>
      <button
        type="button"
        onClick={() => { setExpanded(false); setValue(''); }}
        className="btn-ghost text-xs px-2 py-1.5 shrink-0"
      >
        Cancel
      </button>
    </div>
  );
}
