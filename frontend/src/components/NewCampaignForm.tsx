'use client';

/**
 * NewCampaignForm — inline expansion that lets users create a new campaign
 * directly from the Launch builder without leaving the page.
 *
 * Patch 3.4 — minimal field set:
 *   - Name
 *   - Objective (the 6 ODAX values)
 *   - Status (default Paused)
 *   - Optional CBO toggle. When on:
 *       - Daily/Lifetime budget choice + amount input
 *       - All ad sets under this campaign will share this budget
 *
 * Hardcoded:
 *   - special_ad_categories: []   (commercial campaigns only)
 *   - buying_type: AUCTION         (the normal type)
 *   - bid_strategy: LOWEST_COST_WITHOUT_CAP (only relevant with CBO)
 *
 * On success, the parent is notified with the new campaign's summary so
 * it can optimistically inject + auto-select.
 */
import { useMemo, useState } from 'react';
import { Loader2, AlertCircle, Plus } from 'lucide-react';
import {
  metaExplore,
  CampaignObjective,
  CreateCampaignSpec,
} from '@/lib/api';

/** Display labels for objectives — match Meta Ads Manager wording. */
const OBJECTIVE_LABELS: Record<CampaignObjective, string> = {
  OUTCOME_AWARENESS:    'Awareness',
  OUTCOME_TRAFFIC:      'Traffic',
  OUTCOME_ENGAGEMENT:   'Engagement',
  OUTCOME_LEADS:        'Leads',
  OUTCOME_APP_PROMOTION: 'App promotion',
  OUTCOME_SALES:        'Sales',
};

const OBJECTIVES: CampaignObjective[] = [
  'OUTCOME_SALES',
  'OUTCOME_LEADS',
  'OUTCOME_TRAFFIC',
  'OUTCOME_ENGAGEMENT',
  'OUTCOME_AWARENESS',
  'OUTCOME_APP_PROMOTION',
];

interface Props {
  adAccountId: string;
  defaultCurrency?: string;
  /**
   * Called after Meta returns the new campaign id. Full summary is
   * passed so the parent can optimistic-insert and auto-select.
   */
  onCreated: (newCampaign: {
    id: string;
    name: string;
    objective: CampaignObjective;
    status: 'ACTIVE' | 'PAUSED';
  }) => void;
  onCancel: () => void;
}

export function NewCampaignForm({
  adAccountId,
  defaultCurrency = 'USD',
  onCreated,
  onCancel,
}: Props) {
  // ---- Form state ----
  const [name, setName] = useState('');
  const [objective, setObjective] = useState<CampaignObjective>('OUTCOME_SALES');
  const [status, setStatus] = useState<'ACTIVE' | 'PAUSED'>('PAUSED');
  const [cboEnabled, setCboEnabled] = useState(false);
  const [budgetMode, setBudgetMode] = useState<'daily' | 'lifetime'>('daily');
  const [budgetMajor, setBudgetMajor] = useState('50');

  // ---- Submit state ----
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- Validation ----
  const validation = useMemo(() => {
    const issues: string[] = [];
    if (!name.trim()) issues.push('Name is required');
    if (cboEnabled) {
      const budget = parseFloat(budgetMajor);
      if (isNaN(budget) || budget <= 0) issues.push('Budget must be a positive number');
    }
    return issues;
  }, [name, cboEnabled, budgetMajor]);

  // ---- Submit ----
  async function submit() {
    if (validation.length > 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const spec: CreateCampaignSpec = {
        name: name.trim(),
        objective,
        status,
        cboEnabled,
      };
      if (cboEnabled) {
        spec.budgetMode = budgetMode;
        spec.budgetAmountMinorUnits = Math.round(parseFloat(budgetMajor) * 100);
      }
      const result = await metaExplore.createCampaign(adAccountId, spec);
      onCreated({
        id: result.id,
        name: name.trim(),
        objective,
        status,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create campaign');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card space-y-4 border-accent/30 bg-accent-subtle/30">
      <div className="h-sub text-ink">New campaign</div>

      {/* Name + Status */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_140px] gap-3">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. BOF | Sales | Q3 push"
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

      {/* Objective */}
      <Field label="Objective">
        <Select value={objective} onChange={(v) => setObjective(v as CampaignObjective)}>
          {OBJECTIVES.map((o) => (
            <option key={o} value={o}>{OBJECTIVE_LABELS[o]}</option>
          ))}
        </Select>
      </Field>

      {/* CBO toggle */}
      <div>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={cboEnabled}
            onChange={(e) => setCboEnabled(e.target.checked)}
            className="accent-accent"
          />
          <span className="text-sm text-ink">
            <b>Campaign Budget Optimization (CBO)</b>
          </span>
        </label>
        <div className="text-2xs text-ink-subtle mt-1 ml-6">
          {cboEnabled ? (
            <>Meta distributes the budget across all ad sets in this campaign. Ad sets in this campaign won&apos;t have their own budgets.</>
          ) : (
            <>Each ad set in this campaign will have its own budget (ABO mode).</>
          )}
        </div>
      </div>

      {/* CBO budget (only when CBO is on) */}
      {cboEnabled && (
        <div>
          <div className="text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
            Campaign budget
          </div>
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
        </div>
      )}

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
              Create campaign
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// ---- Small shared UI (same as NewAdSetForm) ----

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
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="input w-full text-sm bg-surface"
    >
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
