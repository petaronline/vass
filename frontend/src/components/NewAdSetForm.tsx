'use client';

/**
 * NewAdSetForm — inline expansion that lets users create a new ad set
 * directly from the Launch builder without leaving the page.
 *
 * Patch 3.3 — basic field set covering 90% of launches:
 *   - Name, Status
 *   - Budget (daily or lifetime) + amount
 *   - Schedule (start time always; end time required for lifetime)
 *   - Optimization goal (filtered by campaign objective)
 *   - Targeting: countries, age, gender
 *   - Placements: automatic or manual (FB/IG/Messenger/AN)
 *   - Promoted object: pixel + event (for conversion goals) or page
 *
 * Power-user fields (interest targeting, dayparting, custom audiences,
 * lookalikes) are intentionally NOT exposed — link out to Meta for those.
 *
 * Usage:
 *   <NewAdSetForm
 *     adAccountId={uuid}
 *     metaCampaignId={id}
 *     accountPageId={accountPageId}    // for objectives that need a page
 *     accountPixelId={accountDefaultPixelId}  // initial pixel selection
 *     accountPixelEvent={...}
 *     defaultCurrency="USD"
 *     onCreated={(newAdSet) => {...}}  // called after successful create
 *     onCancel={() => {...}}
 *   />
 */
import { useEffect, useMemo, useState } from 'react';
import { Loader2, AlertCircle, Plus } from 'lucide-react';
import {
  metaExplore,
  MetaPixel,
  CampaignObjective,
  CreateAdSetSpec,
  OPTIMIZATION_GOAL_LABELS,
  OPTIMIZATION_GOALS_BY_OBJECTIVE,
  GOALS_REQUIRING_PIXEL,
  GOALS_REQUIRING_PAGE,
  CUSTOM_EVENT_TYPES,
} from '@/lib/api';

/**
 * Default billing_event for each optimization_goal. Meta requires
 * `billing_event` for nearly every goal; if missing, the create call
 * fails with subcode 1815161. We pick the most universally-accepted
 * option (IMPRESSIONS works for almost everything; LINK_CLICKS / THRUPLAY
 * / APP_INSTALLS allow themselves as a billing event too).
 */
const DEFAULT_BILLING_EVENT: Record<string, string> = {
  REACH:                'IMPRESSIONS',
  IMPRESSIONS:          'IMPRESSIONS',
  AD_RECALL_LIFT:       'IMPRESSIONS',
  THRUPLAY:             'IMPRESSIONS',
  LINK_CLICKS:          'IMPRESSIONS',
  LANDING_PAGE_VIEWS:   'IMPRESSIONS',
  QUALITY_CALL:         'IMPRESSIONS',
  POST_ENGAGEMENT:      'IMPRESSIONS',
  CONVERSATIONS:        'IMPRESSIONS',
  REPLIES:              'IMPRESSIONS',
  PAGE_LIKES:           'IMPRESSIONS',
  EVENT_RESPONSES:      'IMPRESSIONS',
  LEAD_GENERATION:      'IMPRESSIONS',
  QUALITY_LEAD:         'IMPRESSIONS',
  OFFSITE_CONVERSIONS:  'IMPRESSIONS',
  APP_INSTALLS:         'IMPRESSIONS',
  VALUE:                'IMPRESSIONS',
};

// A short list of common countries up top, then the rest alphabetical.
// Avoids forcing users to scroll past every country to find "US".
const COMMON_COUNTRIES = ['US', 'CA', 'GB', 'AU', 'DE', 'FR', 'IT', 'ES', 'NL', 'SE'];
const ALL_COUNTRIES: Array<[string, string]> = [
  ['US', 'United States'], ['CA', 'Canada'], ['GB', 'United Kingdom'],
  ['AU', 'Australia'], ['DE', 'Germany'], ['FR', 'France'], ['IT', 'Italy'],
  ['ES', 'Spain'], ['NL', 'Netherlands'], ['SE', 'Sweden'], ['NO', 'Norway'],
  ['DK', 'Denmark'], ['FI', 'Finland'], ['IE', 'Ireland'], ['BE', 'Belgium'],
  ['AT', 'Austria'], ['CH', 'Switzerland'], ['PT', 'Portugal'], ['GR', 'Greece'],
  ['PL', 'Poland'], ['CZ', 'Czech Republic'], ['SK', 'Slovakia'], ['HU', 'Hungary'],
  ['RO', 'Romania'], ['BG', 'Bulgaria'], ['HR', 'Croatia'], ['SI', 'Slovenia'],
  ['RS', 'Serbia'], ['UA', 'Ukraine'], ['NZ', 'New Zealand'], ['SG', 'Singapore'],
  ['HK', 'Hong Kong'], ['JP', 'Japan'], ['KR', 'South Korea'], ['IN', 'India'],
  ['ID', 'Indonesia'], ['MY', 'Malaysia'], ['TH', 'Thailand'], ['PH', 'Philippines'],
  ['VN', 'Vietnam'], ['AE', 'UAE'], ['SA', 'Saudi Arabia'], ['IL', 'Israel'],
  ['TR', 'Turkey'], ['ZA', 'South Africa'], ['EG', 'Egypt'], ['NG', 'Nigeria'],
  ['KE', 'Kenya'], ['BR', 'Brazil'], ['MX', 'Mexico'], ['AR', 'Argentina'],
  ['CL', 'Chile'], ['CO', 'Colombia'], ['PE', 'Peru'],
];

interface Props {
  adAccountId: string;
  metaCampaignId: string;
  accountPageId?: string | null;
  defaultCurrency?: string;
  /**
   * Called after Meta returns the new ad set id. The full new ad set summary
   * is passed so the parent can:
   *   1. Optimistically inject it into the local ad sets list (no extra fetch)
   *   2. Detect if it's PAUSED and turn off the "active only" filter so it shows
   */
  onCreated: (newAdSet: { id: string; name: string; status: 'ACTIVE' | 'PAUSED' }) => void;
  onCancel: () => void;
}

export function NewAdSetForm({
  adAccountId,
  metaCampaignId,
  accountPageId,
  defaultCurrency = 'USD',
  onCreated,
  onCancel,
}: Props) {
  // ---- Fetched on mount ----
  const [objective, setObjective] = useState<CampaignObjective | null>(null);
  const [cboEnabled, setCboEnabled] = useState(false);
  const [objectiveError, setObjectiveError] = useState<string | null>(null);
  const [pixels, setPixels] = useState<MetaPixel[]>([]);
  const [loadingObjective, setLoadingObjective] = useState(true);
  const [loadingPixels, setLoadingPixels] = useState(true);

  // ---- Form state ----
  const [name, setName] = useState('');
  const [status, setStatus] = useState<'ACTIVE' | 'PAUSED'>('PAUSED');
  const [budgetMode, setBudgetMode] = useState<'daily' | 'lifetime'>('daily');
  const [budgetMajor, setBudgetMajor] = useState('20'); // in dollars (major units)
  const [startTime, setStartTime] = useState(''); // empty = "now" (Meta default)
  const [endTime, setEndTime] = useState('');
  const [optimizationGoal, setOptimizationGoal] = useState('');
  const [countries, setCountries] = useState<string[]>(['US']);
  const [ageMin, setAgeMin] = useState(18);
  const [ageMax, setAgeMax] = useState(65);
  const [gender, setGender] = useState<'all' | 'male' | 'female'>('all');
  const [placementsAuto, setPlacementsAuto] = useState(true);
  const [publisherPlatforms, setPublisherPlatforms] = useState<
    Array<'facebook' | 'instagram' | 'messenger' | 'audience_network'>
  >(['facebook', 'instagram']);
  const [pixelId, setPixelId] = useState('');
  const [customEventType, setCustomEventType] = useState('PURCHASE');

  // ---- Submit state ----
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- Load campaign objective + pixels in parallel ----
  useEffect(() => {
    setLoadingObjective(true);
    metaExplore
      .getCampaignObjective(metaCampaignId)
      .then((r) => {
        const obj = r.objective as CampaignObjective | null;
        setObjective(obj);
        setCboEnabled(r.cboEnabled);
        // Pre-select the recommended (first) optimization goal for this objective
        if (obj && OPTIMIZATION_GOALS_BY_OBJECTIVE[obj]?.length > 0) {
          setOptimizationGoal(OPTIMIZATION_GOALS_BY_OBJECTIVE[obj][0]);
        }
      })
      .catch((err) => setObjectiveError(err instanceof Error ? err.message : 'Failed to read objective'))
      .finally(() => setLoadingObjective(false));

    setLoadingPixels(true);
    metaExplore
      .listPixels(adAccountId)
      .then((r) => setPixels(r.pixels))
      .catch(() => setPixels([]))
      .finally(() => setLoadingPixels(false));
  }, [adAccountId, metaCampaignId]);

  // ---- Derived ----
  const allowedGoals = objective
    ? OPTIMIZATION_GOALS_BY_OBJECTIVE[objective] ?? []
    : [];
  const needsPixel = GOALS_REQUIRING_PIXEL.has(optimizationGoal);
  const needsPage = GOALS_REQUIRING_PAGE.has(optimizationGoal);

  // ---- Validation ----
  const validation = useMemo(() => {
    const issues: string[] = [];
    if (!name.trim()) issues.push('Name is required');
    if (!optimizationGoal) issues.push('Pick an optimization goal');
    if (!cboEnabled) {
      const budget = parseFloat(budgetMajor);
      if (isNaN(budget) || budget <= 0) issues.push('Budget must be a positive number');
      if (budgetMode === 'lifetime' && !endTime) {
        issues.push('Lifetime budget requires an end date');
      }
    }
    if (countries.length === 0) issues.push('Pick at least one country');
    if (ageMin > ageMax) issues.push('Age min must be ≤ age max');
    if (!placementsAuto && publisherPlatforms.length === 0) {
      issues.push('Pick at least one placement (or switch to Automatic)');
    }
    if (needsPixel && !pixelId) {
      issues.push('Pick a pixel');
    }
    if (needsPage && !accountPageId) {
      issues.push('This goal needs a Page set on the ad account');
    }
    return issues;
  }, [
    name, optimizationGoal, budgetMajor, countries, ageMin, ageMax,
    placementsAuto, publisherPlatforms, budgetMode, endTime, cboEnabled,
    needsPixel, pixelId, needsPage, accountPageId,
  ]);

  // ---- Submit ----
  async function submit() {
    if (validation.length > 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const budgetMinor = cboEnabled ? 0 : Math.round(parseFloat(budgetMajor) * 100);
      const spec: CreateAdSetSpec = {
        metaCampaignId,
        name: name.trim(),
        status,
        budgetMode,
        budgetAmountMinorUnits: budgetMinor || 1, // Zod requires positive int even if backend ignores
        cboEnabled,
        startTime: startTime ? new Date(startTime).toISOString() : undefined,
        endTime: endTime ? new Date(endTime).toISOString() : undefined,
        optimizationGoal,
        // Meta requires billing_event for nearly every goal — default it from
        // the goal so users don't get cryptic 1815161 errors.
        billingEvent: DEFAULT_BILLING_EVENT[optimizationGoal] ?? 'IMPRESSIONS',
        countries,
        ageMin,
        ageMax,
        gender,
        placementsAuto,
        publisherPlatforms: placementsAuto ? undefined : publisherPlatforms,
        pixelId: needsPixel ? pixelId : undefined,
        customEventType: needsPixel ? customEventType : undefined,
        pageId: needsPage && accountPageId ? accountPageId : undefined,
      };
      const result = await metaExplore.createAdSet(adAccountId, spec);
      onCreated({
        id: result.id,
        name: name.trim(),
        status,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create ad set');
    } finally {
      setSubmitting(false);
    }
  }

  function togglePlatform(p: typeof publisherPlatforms[number]) {
    setPublisherPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );
  }
  function toggleCountry(code: string) {
    setCountries((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  }

  if (loadingObjective) {
    return (
      <div className="card text-center text-sm text-ink-subtle py-4">
        <Loader2 size={14} className="inline-block animate-spin mr-1" />
        Loading campaign objective…
      </div>
    );
  }

  if (objectiveError || !objective) {
    return (
      <div className="card border-red-100 bg-red-50">
        <div className="flex items-start gap-2 text-sm text-danger">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>
            {objectiveError ??
              'Could not detect this campaign\'s objective. Try a different campaign or create the ad set in Meta.'}
          </span>
        </div>
        <button onClick={onCancel} className="mt-3 text-xs text-ink-muted hover:underline">
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="card space-y-4 border-accent/30 bg-accent-subtle/30">
      <div className="flex items-baseline justify-between">
        <div className="h-sub text-ink">New ad set</div>
        <div className="text-2xs text-ink-subtle">Objective: {objective.replace('OUTCOME_', '')}</div>
      </div>

      {/* Name + Status */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_140px] gap-3">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. US 18-34 — Lookalike"
            className="input w-full text-sm"
            autoFocus
          />
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(v) => setStatus(v as 'ACTIVE' | 'PAUSED')}>
            <option value="PAUSED">Paused</option>
            <option value="ACTIVE">Active</option>
          </Select>
        </Field>
      </div>

      {/* Optimization goal */}
      <Field label="Optimization goal">
        <Select value={optimizationGoal} onChange={setOptimizationGoal}>
          {allowedGoals.map((g) => (
            <option key={g} value={g}>
              {OPTIMIZATION_GOAL_LABELS[g] ?? g}
            </option>
          ))}
        </Select>
      </Field>

      {/* Pixel + event (only for conversion goals) */}
      {needsPixel && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Pixel">
            <Select
              value={pixelId}
              onChange={setPixelId}
              placeholder={loadingPixels ? 'Loading…' : pixels.length === 0 ? 'No pixels found' : 'Select pixel…'}
              disabled={loadingPixels || pixels.length === 0}
            >
              {pixels.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Conversion event">
            <Select
              value={customEventType}
              onChange={setCustomEventType}
              placeholder="Select event…"
            >
              {CUSTOM_EVENT_TYPES.map((e) => (
                <option key={e.value} value={e.value}>{e.label}</option>
              ))}
            </Select>
          </Field>
        </div>
      )}

      {needsPage && !accountPageId && (
        <div className="text-2xs text-warning bg-amber-50 border border-amber-100 rounded px-2 py-1.5">
          This goal needs a Page set on the ad account. Configure it in Settings → Ad accounts first.
        </div>
      )}

      {optimizationGoal === 'VALUE' && (
        <div className="text-2xs text-ink-muted bg-surface-alt border border-line rounded px-2 py-1.5">
          <b>Note:</b> Value optimization requires a pixel configured for value-based events
          (purchase amount tracked). If your pixel isn&apos;t set up for this, Meta will reject —
          try <b>Conversions (pixel)</b> instead.
        </div>
      )}

      {/* Budget */}
      <div>
        <div className="text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
          Budget
        </div>
        {cboEnabled ? (
          <div className="text-xs text-ink-muted bg-surface-alt rounded px-3 py-2 border border-line">
            This campaign uses <b>Campaign Budget Optimization</b> — budget is
            managed at the campaign level and shared across all ad sets. No
            per-ad-set budget needed.
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-2">
              <ToggleButton active={budgetMode === 'daily'} onClick={() => setBudgetMode('daily')}>
                Daily
              </ToggleButton>
              <ToggleButton active={budgetMode === 'lifetime'} onClick={() => setBudgetMode('lifetime')}>
                Lifetime
              </ToggleButton>
            </div>
            <div className="relative w-48">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-ink-subtle">
                {defaultCurrency === 'USD' ? '$' : ''}
              </span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={budgetMajor}
                onChange={(e) => setBudgetMajor(e.target.value)}
                className="input w-full text-sm pl-7"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-subtle">
                {defaultCurrency} {budgetMode === 'daily' ? '/ day' : 'total'}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Schedule */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label={`Start time ${budgetMode === 'lifetime' ? '(optional)' : '(optional, default: now)'}`}>
          <input
            type="datetime-local"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            className="input w-full text-sm"
          />
        </Field>
        <Field
          label={`End time ${budgetMode === 'lifetime' ? '(required)' : '(optional)'}`}
        >
          <input
            type="datetime-local"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            className="input w-full text-sm"
          />
        </Field>
      </div>

      {/* Targeting */}
      <div>
        <div className="text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
          Audience
        </div>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto_auto] gap-3 items-end">
          <Field label="Countries">
            <details className="relative">
              <summary className="input w-full text-sm cursor-pointer list-none">
                {countries.length === 0
                  ? 'Pick countries…'
                  : countries.length <= 3
                  ? countries.join(', ')
                  : `${countries.slice(0, 3).join(', ')} +${countries.length - 3}`}
              </summary>
              <div className="absolute z-10 mt-1 max-h-64 overflow-y-auto bg-surface border border-line rounded-lg shadow-lg w-72 p-2 space-y-0.5">
                {ALL_COUNTRIES.map(([code, label]) => (
                  <label
                    key={code}
                    className="flex items-center gap-2 px-1.5 py-1 text-sm hover:bg-surface-hover rounded cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={countries.includes(code)}
                      onChange={() => toggleCountry(code)}
                      className="accent-accent"
                    />
                    <span className="text-ink-muted font-mono text-xs w-6">{code}</span>
                    <span className="text-ink">{label}</span>
                  </label>
                ))}
              </div>
            </details>
          </Field>
          <Field label="Age min">
            <input
              type="number"
              min={13}
              max={65}
              value={ageMin}
              onChange={(e) => setAgeMin(parseInt(e.target.value, 10) || 13)}
              className="input w-20 text-sm"
            />
          </Field>
          <Field label="Age max">
            <input
              type="number"
              min={13}
              max={65}
              value={ageMax}
              onChange={(e) => setAgeMax(parseInt(e.target.value, 10) || 65)}
              className="input w-20 text-sm"
            />
          </Field>
          <Field label="Gender">
            <Select value={gender} onChange={(v) => setGender(v as 'all' | 'male' | 'female')}>
              <option value="all">All</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </Select>
          </Field>
        </div>
      </div>

      {/* Placements */}
      <div>
        <div className="text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
          Placements
        </div>
        <div className="flex items-center gap-2 mb-2">
          <ToggleButton active={placementsAuto} onClick={() => setPlacementsAuto(true)}>
            Advantage+ (auto)
          </ToggleButton>
          <ToggleButton active={!placementsAuto} onClick={() => setPlacementsAuto(false)}>
            Manual
          </ToggleButton>
        </div>
        {!placementsAuto && (
          <div className="flex flex-wrap gap-1.5">
            {(['facebook', 'instagram', 'messenger', 'audience_network'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => togglePlatform(p)}
                className={[
                  'text-xs font-medium px-2 py-1 rounded border transition-colors capitalize',
                  publisherPlatforms.includes(p)
                    ? 'border-accent bg-accent-subtle text-accent'
                    : 'border-line text-ink-muted hover:bg-surface-hover',
                ].join(' ')}
              >
                {p.replace('_', ' ')}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Validation + error */}
      {(validation.length > 0 || error) && (
        <div className="text-xs space-y-1">
          {error && (
            <div className="flex items-start gap-1.5 text-danger">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {validation.map((v) => (
            <div key={v} className="text-ink-subtle pl-1">• {v}</div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-2 border-t border-line">
        <button
          type="button"
          onClick={onCancel}
          className="text-xs font-medium text-ink-muted hover:text-ink px-3 py-1.5"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={validation.length > 0 || submitting}
          className="btn-primary text-sm"
        >
          {submitting ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              Creating…
            </>
          ) : (
            <>
              <Plus size={14} />
              Create ad set
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// ---- Small shared UI ----

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
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="input w-full text-sm bg-surface disabled:opacity-60 disabled:cursor-not-allowed"
    >
      {placeholder && <option value="">{placeholder}</option>}
      {children}
    </select>
  );
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'text-xs font-medium px-3 py-1.5 rounded border transition-colors',
        active
          ? 'border-accent bg-accent-subtle text-accent'
          : 'border-line text-ink-muted hover:bg-surface-hover',
      ].join(' ')}
    >
      {children}
    </button>
  );
}
