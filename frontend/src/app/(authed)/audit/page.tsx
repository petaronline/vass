'use client';

/**
 * Audit page — Patch 2.5b.
 *
 * Lets the user scan existing ads in Meta for enhancement / multi-ad
 * violations of their Vass defaults, then queue fixes to bring them in line.
 *
 * Flow:
 *   1. Pick account → campaign → ad sets (multi-select), same as Launch
 *   2. Click "Start audit" → backend kicks off async scan
 *   3. UI polls status, shows "Scanning N of M…"
 *   4. When scanned: show findings table (ads with violations + their badges)
 *   5. User selects which to fix → "Fix selected"
 *   6. UI polls again to show per-finding fix progress
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Search,
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  Shield,
  Loader2,
} from 'lucide-react';
import {
  adAccounts,
  metaExplore,
  audits,
  AdAccount,
  MetaCampaign,
  MetaAdSet,
  AuditRun,
  AuditFinding,
  MAX_ADS_PER_AUDIT,
  ENHANCEMENT_LABELS,
  type EnhancementKey,
} from '@/lib/api';
import { AdAccountAvatar } from '@/components/AdAccountAvatar';
import {
  getActiveAdAccountIds,
  VASS_ACTIVE_SCOPE_EVENT,
} from '@/components/BrandSelector';
import { PageHeader, PAGE_TINTS } from '@/components/PageHeader';
import { Toggle } from '@/components/Toggle';

/**
 * Selection model: per finding, the set of violation keys the user has
 * chosen to fix. Empty set = no violations selected (finding will not be
 * fixed). Missing entry = finding entirely unselected.
 *
 * When the user clicks the row checkbox to ADD a finding, we pre-populate
 * its set with ALL violations (i.e. fix everything by default). Clicking
 * individual tags toggles them in/out of the set.
 */
type SelectionMap = Map<string, Set<string>>;

export default function AuditPage() {
  // ----- Scope picker state -----
  const [accountsList, setAccountsList] = useState<AdAccount[]>([]);
  const [adAccountId, setAdAccountId] = useState('');
  const [campaigns, setCampaigns] = useState<MetaCampaign[]>([]);
  const [metaCampaignId, setMetaCampaignId] = useState('');
  const [adSetsList, setAdSetsList] = useState<MetaAdSet[]>([]);
  const [selectedAdSetIds, setSelectedAdSetIds] = useState<string[]>([]);
  const [adSetFilter, setAdSetFilter] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [loadingAdSets, setLoadingAdSets] = useState(false);

  // ----- Run state -----
  const [run, setRun] = useState<AuditRun | null>(null);
  const [findings, setFindings] = useState<AuditFinding[]>([]);
  const [selectedViolations, setSelectedViolations] = useState<SelectionMap>(new Map());
  const [creating, setCreating] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ----- Initial: load accounts -----
  useEffect(() => {
    adAccounts
      .list()
      .then((r) => setAccountsList(r.accounts.filter((a) => a.isEnabled)))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load accounts'));
  }, []);

  // ----- Scope → account pre-fill (Patch 4.38.1) -----
  useEffect(() => {
    if (accountsList.length === 0) return;
    const apply = () => {
      const ids = getActiveAdAccountIds(
        accountsList.map((a) => ({ id: a.id, brandId: a.brandId }))
      );
      if (ids && ids.length > 0) {
        setAdAccountId((cur) => (cur && ids.includes(cur) ? cur : ids[0]));
      }
    };
    apply();
    const onChange = () => apply();
    window.addEventListener(VASS_ACTIVE_SCOPE_EVENT, onChange);
    return () => window.removeEventListener(VASS_ACTIVE_SCOPE_EVENT, onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsList]);

  // ----- Reload campaigns when account changes -----
  useEffect(() => {
    if (!adAccountId) {
      setCampaigns([]);
      setMetaCampaignId('');
      return;
    }
    setLoadingCampaigns(true);
    setCampaigns([]);
    metaExplore
      .listCampaigns(adAccountId, activeOnly)
      .then((r) => setCampaigns(r.campaigns))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load campaigns'))
      .finally(() => setLoadingCampaigns(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adAccountId, activeOnly]);

  // ----- Reload ad sets -----
  useEffect(() => {
    if (!metaCampaignId) {
      setAdSetsList([]);
      setSelectedAdSetIds([]);
      return;
    }
    setLoadingAdSets(true);
    setAdSetsList([]);
    metaExplore
      .listAdSets(metaCampaignId, activeOnly)
      .then((r) => setAdSetsList(r.adSets))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load ad sets'))
      .finally(() => setLoadingAdSets(false));
  }, [metaCampaignId, activeOnly]);

  // ----- Poll the run if one is active -----
  useEffect(() => {
    if (!run?.id) return;
    // Stop polling once scanned AND no findings are still queued/fixing.
    // pending_publish is fine to stop polling (user has to manually publish in Meta).
    const isQuiescent =
      run.status === 'scanned' &&
      findings.every((f) => f.fixStatus !== 'queued' && f.fixStatus !== 'fixing');
    if (isQuiescent || run.status === 'failed') return;

    const interval = setInterval(() => {
      audits
        .get(run.id)
        .then((r) => {
          setRun(r.run);
          setFindings(r.findings);
        })
        .catch(() => {/* swallow polling errors */});
    }, 2000);
    return () => clearInterval(interval);
  }, [run?.id, run?.status, findings]);

  // ----- Helpers -----
  function toggleAdSet(id: string) {
    setSelectedAdSetIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  const filteredAdSets = useMemo(() => {
    const f = adSetFilter.trim().toLowerCase();
    return !f ? adSetsList : adSetsList.filter((s) => s.name.toLowerCase().includes(f));
  }, [adSetsList, adSetFilter]);

  // Soft estimate of ads in selected ad sets — Meta doesn't return counts in
  // listAdSets, so we just show a warning when too many ad sets are picked.
  // Real scan-side cap is 2000 ads.
  const tooManyAdSets = selectedAdSetIds.length > 25;

  async function startAudit() {
    if (selectedAdSetIds.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const campaign = campaigns.find((c) => c.id === metaCampaignId);
      const result = await audits.create({
        adAccountId,
        metaCampaignId,
        metaCampaignName: campaign?.name,
        targetAdSetIds: selectedAdSetIds,
        activeOnly,
      });
      const fresh = await audits.get(result.runId);
      setRun(fresh.run);
      setFindings(fresh.findings);
      setSelectedViolations(new Map());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start audit');
    } finally {
      setCreating(false);
    }
  }

  async function fixSelected() {
    if (!run || selectedViolations.size === 0) return;
    setFixing(true);
    setError(null);
    try {
      // Build the per-finding payload. Skip any finding where the user
      // deselected ALL its violations (empty set).
      const findingsToFix: Array<{ id: string; violationKeys: string[] }> = [];
      for (const [findingId, violationSet] of selectedViolations.entries()) {
        if (violationSet.size === 0) continue;
        findingsToFix.push({
          id: findingId,
          violationKeys: Array.from(violationSet),
        });
      }
      if (findingsToFix.length === 0) {
        setError('No violations selected to fix');
        setFixing(false);
        return;
      }
      await audits.fix(run.id, { findings: findingsToFix });
      // Refresh state immediately; polling continues until done
      const fresh = await audits.get(run.id);
      setRun(fresh.run);
      setFindings(fresh.findings);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to queue fixes');
    } finally {
      setFixing(false);
    }
  }

  function resetForNew() {
    setRun(null);
    setFindings([]);
    setSelectedViolations(new Map());
    setSelectedAdSetIds([]);
  }

  const [rescanning, setRescanning] = useState(false);
  async function rescan() {
    if (!run) return;
    setRescanning(true);
    setError(null);
    try {
      await audits.rescan(run.id);
      // Polling effect will pick up the scanning status & update findings
      const fresh = await audits.get(run.id);
      setRun(fresh.run);
      setFindings(fresh.findings);
      // Clear local "marked to turn off" selections since findings may have changed
      setSelectedViolations(new Map());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start re-scan');
    } finally {
      setRescanning(false);
    }
  }

  // ----- Render -----
  return (
    <div className="w-full">
      <PageHeader
        icon={Shield}
        title="Audit"
        description="Scan existing ads for creative enhancements that violate your defaults. Vass turns them off by creating a clean copy of the ad's creative and re-attaching it to the same ad."
        tint={PAGE_TINTS.audit}
        activeOnly={!run ? activeOnly : undefined}
        onActiveOnlyChange={!run ? setActiveOnly : undefined}
      />

      {error && (
        <div className="mb-4 flex items-start gap-2 px-3 py-2 rounded-lg border border-red-100 bg-red-50 text-sm text-danger">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!run ? (
        <ScopePicker
          accountsList={accountsList}
          adAccountId={adAccountId}
          onAccountChange={(v) => {
            setAdAccountId(v);
            setMetaCampaignId('');
            setSelectedAdSetIds([]);
          }}
          campaigns={campaigns}
          loadingCampaigns={loadingCampaigns}
          metaCampaignId={metaCampaignId}
          onCampaignChange={(v) => {
            setMetaCampaignId(v);
            setSelectedAdSetIds([]);
          }}
          adSetsList={adSetsList}
          filteredAdSets={filteredAdSets}
          loadingAdSets={loadingAdSets}
          selectedAdSetIds={selectedAdSetIds}
          adSetFilter={adSetFilter}
          onFilter={setAdSetFilter}
          onToggleAdSet={toggleAdSet}
          onSelectAll={() =>
            setSelectedAdSetIds((prev) =>
              Array.from(new Set([...prev, ...filteredAdSets.map((s) => s.id)]))
            )
          }
          onClearAll={() => setSelectedAdSetIds([])}
          activeOnly={activeOnly}
          tooManyAdSets={tooManyAdSets}
          creating={creating}
          onStart={startAudit}
        />
      ) : (
        <RunView
          run={run}
          findings={findings}
          selectedViolations={selectedViolations}
          onToggleFinding={(finding) => {
            // Row checkbox = bulk "mark all this row's tags to turn off"
            setSelectedViolations((prev) => {
              const next = new Map(prev);
              const current = next.get(finding.id);
              const allMarked =
                current !== undefined && current.size === finding.violations.length;
              if (allMarked) {
                // All marked → unmark all (keep them all on)
                next.delete(finding.id);
              } else {
                // Mark all violations for fix (= all turn strikethrough)
                next.set(finding.id, new Set(finding.violations));
              }
              return next;
            });
          }}
          onToggleViolation={(finding, key) => {
            // Click a single tag: green ↔ strikethrough
            // green = stays on (NOT in the set)
            // strikethrough = will be turned off (IN the set)
            setSelectedViolations((prev) => {
              const next = new Map(prev);
              const current = next.get(finding.id);
              if (current && current.has(key)) {
                // Was marked-to-turn-off → unmark (back to green = stays on)
                const updated = new Set(current);
                updated.delete(key);
                if (updated.size === 0) {
                  next.delete(finding.id);
                } else {
                  next.set(finding.id, updated);
                }
              } else {
                // Was green/staying-on → mark to turn off (becomes strikethrough)
                const updated = new Set(current ?? []);
                updated.add(key);
                next.set(finding.id, updated);
              }
              return next;
            });
          }}
          onSelectAllFixable={() => {
            const map = new Map<string, Set<string>>();
            for (const f of findings) {
              if (f.fixStatus === 'pending' || f.fixStatus === 'failed') {
                map.set(f.id, new Set(f.violations));
              }
            }
            setSelectedViolations(map);
          }}
          onClearSelection={() => setSelectedViolations(new Map())}
          onFix={fixSelected}
          onNewAudit={resetForNew}
          onRescan={rescan}
          rescanning={rescanning}
          fixing={fixing}
        />
      )}
    </div>
  );
}

// ============================================================
// Scope picker
// ============================================================

function ScopePicker({
  accountsList,
  adAccountId,
  onAccountChange,
  campaigns,
  loadingCampaigns,
  metaCampaignId,
  onCampaignChange,
  adSetsList,
  filteredAdSets,
  loadingAdSets,
  selectedAdSetIds,
  adSetFilter,
  onFilter,
  onToggleAdSet,
  onSelectAll,
  onClearAll,
  activeOnly,
  tooManyAdSets,
  creating,
  onStart,
}: {
  accountsList: AdAccount[];
  adAccountId: string;
  onAccountChange: (v: string) => void;
  campaigns: MetaCampaign[];
  loadingCampaigns: boolean;
  metaCampaignId: string;
  onCampaignChange: (v: string) => void;
  adSetsList: MetaAdSet[];
  filteredAdSets: MetaAdSet[];
  loadingAdSets: boolean;
  selectedAdSetIds: string[];
  adSetFilter: string;
  onFilter: (v: string) => void;
  onToggleAdSet: (id: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  activeOnly: boolean;
  tooManyAdSets: boolean;
  creating: boolean;
  onStart: () => void;
}) {
  const selectedAccount = accountsList.find((a) => a.id === adAccountId);

  return (
    <div className="space-y-6">
      <section>
        <h2 className="h-sub text-ink mb-3">1. Where</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Ad account">
            <Select
              value={adAccountId}
              onChange={onAccountChange}
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
              value={metaCampaignId}
              onChange={onCampaignChange}
              placeholder={
                !adAccountId
                  ? 'Pick an account first'
                  : loadingCampaigns
                  ? 'Loading…'
                  : 'Select a campaign…'
              }
              disabled={!adAccountId || loadingCampaigns}
            >
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>
        </div>
      </section>

      <section>
        <h2 className="h-sub text-ink mb-3">
          2. Ad sets to audit
        </h2>
        {!metaCampaignId ? (
          <div className="card py-6 text-center text-sm text-ink-subtle">
            Pick a campaign first.
          </div>
        ) : loadingAdSets ? (
          <div className="card py-6 text-center text-sm text-ink-subtle">Loading…</div>
        ) : adSetsList.length === 0 ? (
          <div className="card py-6 text-center text-sm text-ink-subtle">
            No {activeOnly ? 'active ' : ''}ad sets in this campaign.
          </div>
        ) : (
          <div className="card">
            <div className="flex items-center gap-2 mb-3">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
                <input
                  value={adSetFilter}
                  onChange={(e) => onFilter(e.target.value)}
                  placeholder={`Filter ${adSetsList.length} ad sets…`}
                  className="input w-full text-sm pl-7 py-1.5"
                />
              </div>
              <button
                type="button"
                onClick={
                  filteredAdSets.length > 0 &&
                  filteredAdSets.every((s) => selectedAdSetIds.includes(s.id))
                    ? onClearAll
                    : onSelectAll
                }
                className="text-xs font-medium text-accent hover:underline whitespace-nowrap"
              >
                {filteredAdSets.length > 0 &&
                filteredAdSets.every((s) => selectedAdSetIds.includes(s.id))
                  ? 'Clear all'
                  : 'Select all'}
              </button>
            </div>
            <div className="max-h-[320px] overflow-y-auto -mx-1 px-1 space-y-0.5">
              {filteredAdSets.map((s) => {
                const isSelected = selectedAdSetIds.includes(s.id);
                return (
                  <label
                    key={s.id}
                    className="flex items-center gap-2.5 py-1.5 px-2 rounded hover:bg-surface-hover cursor-pointer text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onToggleAdSet(s.id)}
                      className="accent-accent"
                    />
                    <span className={isSelected ? 'text-ink font-medium' : 'text-ink-muted'}>
                      {s.name}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </section>

      {/* Start row */}
      <section className="flex items-center justify-between gap-4 pt-2">
        <div>
          {tooManyAdSets ? (
            <div className="flex items-start gap-2 text-xs text-warning">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                {selectedAdSetIds.length} ad sets selected. If the total exceeds {MAX_ADS_PER_AUDIT} ads
                the scan will fail — narrow your selection.
              </span>
            </div>
          ) : selectedAdSetIds.length > 0 ? (
            <div className="text-xs text-ink-subtle">
              {selectedAdSetIds.length} ad set{selectedAdSetIds.length === 1 ? '' : 's'} selected.
              Scan will check up to {MAX_ADS_PER_AUDIT} ads.
            </div>
          ) : (
            <div className="text-xs text-ink-subtle">Select at least one ad set to audit.</div>
          )}
        </div>
        <button
          onClick={onStart}
          disabled={selectedAdSetIds.length === 0 || creating}
          className="btn-primary justify-center"
        >
          <Shield size={16} />
          {creating ? 'Starting…' : 'Start audit'}
        </button>
      </section>
    </div>
  );
}

// ============================================================
// Run view (progress + findings + fix)
// ============================================================

function RunView({
  run,
  findings,
  selectedViolations,
  onToggleFinding,
  onToggleViolation,
  onSelectAllFixable,
  onClearSelection,
  onFix,
  onNewAudit,
  onRescan,
  rescanning,
  fixing,
}: {
  run: AuditRun;
  findings: AuditFinding[];
  selectedViolations: SelectionMap;
  onToggleFinding: (f: AuditFinding) => void;
  onToggleViolation: (f: AuditFinding, key: string) => void;
  onSelectAllFixable: () => void;
  onClearSelection: () => void;
  onFix: () => void;
  onNewAudit: () => void;
  onRescan: () => void;
  rescanning: boolean;
  fixing: boolean;
}) {
  const fixableCount = findings.filter(
    (f) => f.fixStatus === 'pending' || f.fixStatus === 'failed'
  ).length;
  const fixedCount = findings.filter((f) => f.fixStatus === 'fixed').length;
  const pendingPublishCount = findings.filter(
    (f) => f.fixStatus === 'pending_publish'
  ).length;
  const inFlightCount = findings.filter(
    (f) => f.fixStatus === 'queued' || f.fixStatus === 'fixing'
  ).length;

  const progress =
    run.adsTotal > 0 ? Math.round((run.adsScanned / run.adsTotal) * 100) : 0;

  // Total tags selected (for the Fix button label)
  let totalTagsSelected = 0;
  for (const set of selectedViolations.values()) totalTagsSelected += set.size;

  return (
    <div className="space-y-6">
      {/* Status card */}
      <div className="card">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="h-sub text-ink mb-1">
              {run.metaCampaignName || 'Audit'} ·{' '}
              {run.targetAdSetIds.length} ad set
              {run.targetAdSetIds.length === 1 ? '' : 's'}
            </div>
            <div className="text-xs text-ink-subtle">
              {run.status === 'pending' && 'Queued, waiting for scan to start…'}
              {run.status === 'scanning' &&
                `Scanning ${run.adsScanned} of ${run.adsTotal} ads…`}
              {run.status === 'scanned' &&
                `Scanned ${run.adsTotal} ads. Found ${run.findingsCount} ad${run.findingsCount === 1 ? '' : 's'} with enhancements on.`}
              {run.status === 'failed' && (
                <span className="text-danger">Scan failed: {run.errorMessage}</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {run.status === 'scanned' && (
              <button
                type="button"
                onClick={onRescan}
                disabled={rescanning}
                className="text-xs font-medium text-accent hover:underline whitespace-nowrap disabled:opacity-50"
                title="Re-scan with the same scope. Use this after publishing changes in Meta Ads Manager to confirm fixes took effect."
              >
                {rescanning ? 'Re-scanning…' : 'Re-scan'}
              </button>
            )}
            <button
              type="button"
              onClick={onNewAudit}
              className="text-xs font-medium text-ink-muted hover:text-ink whitespace-nowrap"
            >
              New audit
            </button>
          </div>
        </div>

        {/* Progress bar during scan */}
        {(run.status === 'scanning' || run.status === 'pending') && (
          <div className="mt-3">
            <div className="h-1.5 bg-line rounded-full overflow-hidden">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${run.adsTotal > 0 ? progress : 5}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Empty success state */}
      {run.status === 'scanned' && findings.length === 0 && (
        <div className="card flex items-center gap-3 text-success">
          <CheckCircle2 size={20} />
          <div>
            <div className="h-sub">No enhancements to disable</div>
            <div className="text-xs text-ink-muted mt-0.5">
              All {run.adsTotal} scanned ads already match your defaults.
            </div>
          </div>
        </div>
      )}

      {/* Pending publish banner — explains the two-step workflow */}
      {pendingPublishCount > 0 && (
        <div className="card border-amber-200 bg-amber-50">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="h-sub text-amber-900">
                {pendingPublishCount} ad{pendingPublishCount === 1 ? '' : 's'} pending publish in Meta
              </div>
              <div className="text-xs text-amber-800 mt-1">
                Vass swapped the creatives, but Meta puts each ad into a draft &quot;Unpublished
                edits&quot; state. Open each ad in Meta Ads Manager and click <b>Publish</b> to
                make the changes live. Then click <b>Re-scan</b> here to confirm.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Findings table + actions */}
      {findings.length > 0 && (
        <>
          <div className="flex items-center justify-between gap-4">
            <div className="text-xs text-ink-muted">
              {fixableCount > 0 && <span>{fixableCount} fixable</span>}
              {fixableCount > 0 && (pendingPublishCount > 0 || fixedCount > 0 || inFlightCount > 0) && <span> · </span>}
              {pendingPublishCount > 0 && (
                <span className="text-amber-700">{pendingPublishCount} pending publish</span>
              )}
              {pendingPublishCount > 0 && (fixedCount > 0 || inFlightCount > 0) && <span> · </span>}
              {fixedCount > 0 && <span className="text-success">{fixedCount} fixed</span>}
              {fixedCount > 0 && inFlightCount > 0 && <span> · </span>}
              {inFlightCount > 0 && (
                <span className="text-accent">{inFlightCount} in progress</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {selectedViolations.size > 0 && (
                <button
                  type="button"
                  onClick={onClearSelection}
                  className="text-xs font-medium text-ink-muted hover:text-ink"
                  title="Reset all tags to green (keep all on)"
                >
                  Reset all
                </button>
              )}
              {fixableCount > 0 && (
                <button
                  type="button"
                  onClick={onSelectAllFixable}
                  className="text-xs font-medium text-accent hover:underline"
                  title="Mark every tag on every fixable ad to be turned off"
                >
                  Turn off all
                </button>
              )}
              <button
                onClick={onFix}
                disabled={selectedViolations.size === 0 || fixing}
                className="btn-primary text-sm"
              >
                {fixing
                  ? 'Queueing…'
                  : totalTagsSelected === 0
                  ? 'Click tags to turn off'
                  : `Turn off ${totalTagsSelected} enhancement${totalTagsSelected === 1 ? '' : 's'} on ${selectedViolations.size} ad${selectedViolations.size === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line text-ink-subtle">
                  <th className="text-left font-medium py-2 pr-3 w-8"></th>
                  <th className="text-left font-medium py-2 pr-3">Ad</th>
                  <th className="text-left font-medium py-2 pr-3">Status</th>
                  <th className="text-left font-medium py-2 pr-3">
                    Enhancements on
                    <div className="text-2xs text-ink-subtle font-normal mt-0.5">
                      Click <span className="text-success">green</span> to turn off
                      (or click <span className="line-through">gray</span> to keep on).
                    </div>
                  </th>
                  <th className="text-left font-medium py-2 pr-3">Fix</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((f) => {
                  const canSelect =
                    f.fixStatus === 'pending' || f.fixStatus === 'failed';
                  // Tags in this set will be turned OFF when Fix is clicked.
                  // Tags NOT in this set are left alone (= stay ON in Meta).
                  const tagsToFix = selectedViolations.get(f.id) ?? new Set<string>();
                  // The row checkbox shows "selected" when ALL tags are marked for fix
                  // (the common case). Indeterminate state is intentionally NOT shown —
                  // checkbox is purely a bulk shortcut here.
                  const allFixed =
                    tagsToFix.size > 0 && tagsToFix.size === f.violations.length;
                  return (
                    <tr
                      key={f.id}
                      className="border-b border-line/50 hover:bg-surface-alt/50"
                    >
                      <td className="py-2 pr-3 align-top">
                        <input
                          type="checkbox"
                          checked={allFixed}
                          disabled={!canSelect}
                          onChange={() => onToggleFinding(f)}
                          className="accent-accent mt-0.5"
                          title={allFixed ? 'All marked to turn off' : 'Mark all to turn off'}
                        />
                      </td>
                      <td className="py-2 pr-3 text-ink font-medium max-w-[280px] truncate align-top" title={f.metaAdName ?? ''}>
                        {f.metaAdName || <span className="text-ink-subtle">(unnamed)</span>}
                      </td>
                      <td className="py-2 pr-3 text-ink-muted align-top">
                        {f.metaAdStatus || '—'}
                      </td>
                      <td className="py-2 pr-3 align-top">
                        <div className="flex flex-wrap gap-1">
                          {f.violations.map((v) => {
                            const willTurnOff = tagsToFix.has(v);
                            return (
                              <button
                                key={v}
                                type="button"
                                disabled={!canSelect}
                                onClick={() => onToggleViolation(f, v)}
                                className={[
                                  'text-2xs font-mono px-1.5 py-0.5 rounded border transition-colors',
                                  !canSelect
                                    ? 'border-line bg-surface-alt text-ink-subtle cursor-not-allowed'
                                    : willTurnOff
                                    ? 'border-line bg-surface-alt text-ink-subtle line-through hover:border-ink-subtle'
                                    : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-400',
                                ].join(' ')}
                                title={
                                  !canSelect
                                    ? humanizeKey(v)
                                    : willTurnOff
                                    ? `${humanizeKey(v)} — will be turned OFF (click to keep on)`
                                    : `${humanizeKey(v)} — currently ON (click to turn off)`
                                }
                              >
                                {humanizeKey(v)}
                              </button>
                            );
                          })}
                        </div>
                      </td>
                      <td className="py-2 pr-3 align-top">
                        <FixStatusBadge
                          status={f.fixStatus}
                          error={f.fixError}
                          newCreativeId={f.newCreativeId}
                          metaAdId={f.metaAdId}
                          metaAdAccountId={run.metaAdAccountId ?? null}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function FixStatusBadge({
  status,
  error,
  newCreativeId,
  metaAdId,
  metaAdAccountId,
}: {
  status: AuditFinding['fixStatus'];
  error: string | null;
  newCreativeId: string | null;
  metaAdId: string;
  metaAdAccountId: string | null;
}) {
  switch (status) {
    case 'pending':
      return <span className="text-ink-subtle">—</span>;
    case 'queued':
      return (
        <span className="text-2xs text-accent font-medium flex items-center gap-1">
          <Loader2 size={11} className="animate-spin" />
          Queued
        </span>
      );
    case 'fixing':
      return (
        <span className="text-2xs text-accent font-medium flex items-center gap-1">
          <Loader2 size={11} className="animate-spin" />
          Fixing…
        </span>
      );
    case 'pending_publish': {
      // Build Meta Ads Manager deep-link. If we don't have the account ID
      // (shouldn't happen normally), fall back to a text badge with no link.
      const metaUrl = metaAdAccountId
        ? `https://adsmanager.facebook.com/adsmanager/manage/ads/edit?act=${encodeURIComponent(metaAdAccountId)}&selected_ad_id=${encodeURIComponent(metaAdId)}`
        : null;
      return (
        <div className="flex flex-col gap-0.5 items-start">
          <span
            className="text-2xs text-amber-700 font-medium flex items-center gap-1"
            title={
              newCreativeId
                ? `Creative was swapped (new ID: ${newCreativeId}). Open the ad in Meta and click Publish to make the change live.`
                : 'Open the ad in Meta and click Publish to make the change live.'
            }
          >
            <AlertTriangle size={11} />
            Pending publish
          </span>
          {metaUrl && (
            <a
              href={metaUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-2xs text-accent hover:underline"
            >
              Open in Meta ↗
            </a>
          )}
        </div>
      );
    }
    case 'fixed':
      return (
        <span
          className="text-2xs text-success font-medium flex items-center gap-1"
          title={
            newCreativeId
              ? `Replaced creative (new ID: ${newCreativeId}) and re-scan confirms enhancements are now off`
              : 'Fixed'
          }
        >
          <CheckCircle2 size={11} />
          Fixed
        </span>
      );
    case 'failed':
      return (
        <span
          className="text-2xs text-danger font-medium flex items-center gap-1"
          title={error ?? 'Unknown error'}
        >
          <AlertCircle size={11} />
          Failed
        </span>
      );
    case 'skipped':
      return <span className="text-2xs text-ink-subtle">Skipped</span>;
    default:
      return null;
  }
}

/**
 * Render a friendly label for a violation key. For enhancement keys we use
 * the shared ENHANCEMENT_LABELS map (Meta UI labels). For the special
 * multi_advertiser_ads key, hardcode a friendly label.
 */
function humanizeKey(key: string): string {
  if (key === 'multi_advertiser_ads') return 'Multi-advertiser ads';
  const label = ENHANCEMENT_LABELS[key as EnhancementKey]?.label;
  return label ?? key.replace(/_/g, ' ');
}

// ============================================================
// Tiny shared UI
// ============================================================

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
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
