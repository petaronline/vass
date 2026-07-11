'use client';

/**
 * Settings → Launch defaults.
 *
 * Layout:
 *   1. Header: title + scope callout ("future Vass launches only,
 *      existing ads on Meta are unaffected").
 *   2. Global default section — always visible at top.
 *   3. Per-account overrides section — dropdown selector below, controls
 *      appear when an account is picked.
 *
 * Both scopes share the same controls:
 *   - Master toggle: disable all enhancements
 *   - Expandable "Individual enhancements" with 13 tri-state toggles (Off / Auto / On)
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Sliders,
  ChevronDown,
  ChevronRight,
  Save,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  Info,
} from 'lucide-react';
import {
  auth,
  launchDefaults,
  adAccounts,
  CurrentUser,
  AdAccount,
  LaunchDefaultsConfig,
  EnhancementKey,
  ENHANCEMENT_KEYS,
  ENHANCEMENT_LABELS,
} from '@/lib/api';
import { AdAccountAvatar } from '@/components/AdAccountAvatar';
import { Toggle } from '@/components/Toggle';

type Scope = 'global' | string; // 'global' or an ad_account.id

interface ScopeState {
  loading: boolean;
  hasOverride: boolean;
  config: LaunchDefaultsConfig;
  effective: Record<EnhancementKey, boolean>;
}

const EMPTY_STATE: ScopeState = {
  loading: true,
  hasOverride: false,
  config: {
    disable_enhancements: true,
    granular_overrides: {},
    disable_multi_advertiser_ads: true,
    show_active_only_default: true,
  },
  effective: {} as Record<EnhancementKey, boolean>,
};

export default function LaunchDefaultsPage() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [accountsList, setAccountsList] = useState<AdAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | ''>('');
  const [pageLoading, setPageLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  const [scopeState, setScopeState] = useState<Record<Scope, ScopeState>>({});
  const [savingScope, setSavingScope] = useState<Scope | null>(null);
  const [savedScopeAt, setSavedScopeAt] = useState<{ scope: Scope; at: number } | null>(null);

  const isAdmin = user?.role === 'admin';

  const loadScope = useCallback(async (scope: Scope) => {
    setScopeState((prev) => ({ ...prev, [scope]: { ...EMPTY_STATE, loading: true } }));
    try {
      if (scope === 'global') {
        const data = await launchDefaults.getGlobal();
        setScopeState((prev) => ({
          ...prev,
          global: {
            loading: false,
            hasOverride: true,
            config: data.config,
            effective: data.effective,
          },
        }));
      } else {
        const data = await launchDefaults.getAccount(scope);
        setScopeState((prev) => ({
          ...prev,
          [scope]: {
            loading: false,
            hasOverride: data.hasOverride,
            config: data.config,
            effective: data.effective,
          },
        }));
      }
    } catch (err) {
      setPageError(err instanceof Error ? err.message : 'Failed to load settings');
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [me, accs] = await Promise.all([auth.me(), adAccounts.list()]);
        setUser(me.user);
        setAccountsList(accs.accounts.filter((a) => a.isEnabled));
        loadScope('global');
      } catch (err) {
        setPageError(err instanceof Error ? err.message : 'Failed to load page');
      } finally {
        setPageLoading(false);
      }
    })();
  }, [loadScope]);

  useEffect(() => {
    if (selectedAccountId && !scopeState[selectedAccountId]) {
      loadScope(selectedAccountId);
    }
  }, [selectedAccountId, scopeState, loadScope]);

  function updateScopeConfig(scope: Scope, updater: (c: LaunchDefaultsConfig) => LaunchDefaultsConfig) {
    setScopeState((prev) => {
      const cur = prev[scope];
      if (!cur) return prev;
      return { ...prev, [scope]: { ...cur, config: updater(cur.config) } };
    });
  }

  async function save(scope: Scope) {
    const cur = scopeState[scope];
    if (!cur) return;
    setSavingScope(scope);
    setPageError(null);
    try {
      if (scope === 'global') {
        const updated = await launchDefaults.setGlobal(cur.config);
        setScopeState((p) => ({
          ...p,
          global: { loading: false, hasOverride: true, ...updated },
        }));
      } else {
        const updated = await launchDefaults.setAccount(scope, cur.config);
        setScopeState((p) => ({
          ...p,
          [scope]: { loading: false, ...updated },
        }));
      }
      setSavedScopeAt({ scope, at: Date.now() });
    } catch (err) {
      setPageError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSavingScope(null);
    }
  }

  async function clearOverride(scope: Scope) {
    if (scope === 'global') return;
    setSavingScope(scope);
    try {
      const updated = await launchDefaults.clearAccount(scope);
      setScopeState((p) => ({
        ...p,
        [scope]: { loading: false, ...updated },
      }));
      setSavedScopeAt({ scope, at: Date.now() });
    } catch (err) {
      setPageError(err instanceof Error ? err.message : 'Failed to clear override');
    } finally {
      setSavingScope(null);
    }
  }

  const globalState = scopeState['global'];
  const selectedAccount = useMemo(
    () => accountsList.find((a) => a.id === selectedAccountId) ?? null,
    [accountsList, selectedAccountId]
  );
  const accountState = selectedAccountId ? scopeState[selectedAccountId] : null;

  if (pageLoading) {
    return <div className="text-sm text-ink-muted">Loading…</div>;
  }

  return (
    <div className="space-y-10">
      {/* Header */}
      <div>
        <h2 className="h-section text-ink mb-1">Launch defaults</h2>
        <p className="text-sm text-ink-muted leading-relaxed max-w-3xl">
          Decide which of Meta&apos;s creative enhancements get applied when you launch ads through
          Vass. Set a default for all accounts, then override per-account if a specific brand
          needs different settings.
        </p>

        <div className="mt-4 flex items-start gap-2.5 px-3.5 py-3 rounded-lg border border-line bg-surface-alt text-sm text-ink-muted max-w-3xl">
          <Info size={16} className="mt-0.5 shrink-0 text-accent" />
          <div className="leading-relaxed">
            <span className="text-ink font-medium">These settings apply to future Vass launches only.</span>{' '}
            They don&apos;t modify ads that already exist on Meta.
          </div>
        </div>

        {pageError && (
          <div className="mt-4 flex items-start gap-2 px-3 py-2 rounded-lg border border-red-100 bg-red-50 text-sm text-danger">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{pageError}</span>
          </div>
        )}
      </div>

      {/* Global default section */}
      <section className="space-y-4">
        <div className="flex items-baseline justify-between gap-4 border-b border-line pb-3">
          <div>
            <h3 className="h-sub text-ink">Global default</h3>
            <p className="text-xs text-ink-subtle mt-0.5">Applies to every account unless overridden below.</p>
          </div>
          {globalState && !globalState.loading && (
            <SaveStatus
              isSaving={savingScope === 'global'}
              savedAt={savedScopeAt?.scope === 'global' ? savedScopeAt.at : null}
            />
          )}
        </div>

        {!globalState || globalState.loading ? (
          <div className="text-sm text-ink-muted">Loading global default…</div>
        ) : (
          <ScopeEditor
            state={globalState}
            onUpdate={(updater) => updateScopeConfig('global', updater)}
            onSave={() => save('global')}
            isSaving={savingScope === 'global'}
            isAdmin={!!isAdmin}
            saveLabel="Save global default"
            showRemoveOverride={false}
          />
        )}
      </section>

      {/* Per-account overrides */}
      <section className="space-y-4">
        <div className="border-b border-line pb-3">
          <h3 className="h-sub text-ink">Per-account overrides</h3>
          <p className="text-xs text-ink-subtle mt-0.5">
            Pick an ad account to give it custom defaults. Accounts without overrides use the global default above.
          </p>
        </div>

        <div className="max-w-md">
          <label className="block text-xs font-medium text-ink-muted uppercase tracking-wider mb-2">
            Ad account
          </label>
          <div className="relative">
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className="w-full appearance-none pr-9 pl-3 py-2 rounded-lg border border-line bg-surface text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">Select an account…</option>
              {accountsList.map((a) => {
                const hasCustom = scopeState[a.id]?.hasOverride;
                return (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {hasCustom ? '  •  Custom' : ''}
                  </option>
                );
              })}
            </select>
            <ChevronDown
              size={16}
              className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-ink-muted"
            />
          </div>

          {selectedAccount && (
            <div className="mt-3 flex items-center gap-2.5 text-sm text-ink">
              <AdAccountAvatar
                name={selectedAccount.name}
                pictureUrl={selectedAccount.pictureUrl}
                size={28}
              />
              <div className="min-w-0">
                <div className="font-medium truncate">{selectedAccount.name}</div>
                <div className="text-xs text-ink-subtle">{selectedAccount.metaAccountId}</div>
              </div>
            </div>
          )}
        </div>

        {selectedAccountId && (
          <div className="pt-2">
            {!accountState || accountState.loading ? (
              <div className="text-sm text-ink-muted">Loading account settings…</div>
            ) : (
              <>
                {!accountState.hasOverride && (
                  <div className="mb-4 px-3.5 py-2.5 rounded-lg border border-line bg-surface-alt text-sm text-ink-muted">
                    This account is currently using the global default.
                    {isAdmin && ' Change any setting below to create an override.'}
                  </div>
                )}
                <ScopeEditor
                  state={accountState}
                  onUpdate={(updater) => updateScopeConfig(selectedAccountId, updater)}
                  onSave={() => save(selectedAccountId)}
                  onClearOverride={() => clearOverride(selectedAccountId)}
                  isSaving={savingScope === selectedAccountId}
                  isAdmin={!!isAdmin}
                  saveLabel="Save override"
                  showRemoveOverride={accountState.hasOverride}
                  savedAt={savedScopeAt?.scope === selectedAccountId ? savedScopeAt.at : null}
                />
              </>
            )}
          </div>
        )}

        {!selectedAccountId && accountsList.length === 0 && (
          <div className="px-3.5 py-3 rounded-lg border border-line bg-surface-alt text-sm text-ink-muted">
            No enabled ad accounts yet. Go to <span className="text-ink font-medium">Settings → Ad accounts</span> to
            enable some.
          </div>
        )}
      </section>
    </div>
  );
}

// =====================================================================
// ScopeEditor — master toggle + granular toggles
// =====================================================================

interface ScopeEditorProps {
  state: ScopeState;
  onUpdate: (updater: (c: LaunchDefaultsConfig) => LaunchDefaultsConfig) => void;
  onSave: () => void;
  onClearOverride?: () => void;
  isSaving: boolean;
  isAdmin: boolean;
  saveLabel: string;
  showRemoveOverride: boolean;
  savedAt?: number | null;
}

function ScopeEditor({
  state,
  onUpdate,
  onSave,
  onClearOverride,
  isSaving,
  isAdmin,
  saveLabel,
  showRemoveOverride,
  savedAt,
}: ScopeEditorProps) {
  const [granularOpen, setGranularOpen] = useState(false);

  function setMaster(disable: boolean) {
    onUpdate((c) => ({ ...c, disable_enhancements: disable }));
  }

  function setGranular(key: EnhancementKey, value: boolean | null) {
    onUpdate((c) => {
      const next = { ...c.granular_overrides };
      if (value === null) delete next[key];
      else next[key] = value;
      return { ...c, granular_overrides: next };
    });
  }

  const overrideCount = Object.keys(state.config.granular_overrides).length;

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="h-sub text-ink mb-1 flex items-center gap-2">
              <Sliders size={14} className="text-accent" />
              Disable all creative enhancements
            </div>
            <p className="text-sm text-ink-muted leading-relaxed max-w-2xl">
              When on, every Meta creative enhancement (image text translation, video effects, music,
              end cards, &amp; more) is turned off on ads launched through Vass. What you upload is
              what gets served.
            </p>
          </div>
          <Toggle
            checked={state.config.disable_enhancements}
            onChange={(v) => setMaster(v)}
            disabled={!isAdmin}
          />
        </div>
      </div>

      <div className="card">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="h-sub text-ink mb-1 flex items-center gap-2">
              <Sliders size={14} className="text-accent" />
              Opt out of multi-advertiser ads
            </div>
            <p className="text-sm text-ink-muted leading-relaxed max-w-2xl">
              Multi-advertiser ads show your ad alongside other advertisers&apos; ads in a single
              unit. Since August 2024 Meta defaults this to opted-in. When this toggle is on,
              Vass explicitly opts out so your ad runs standalone.
            </p>
          </div>
          <Toggle
            checked={state.config.disable_multi_advertiser_ads}
            onChange={(v) =>
              onUpdate((c) => ({ ...c, disable_multi_advertiser_ads: v }))
            }
            disabled={!isAdmin}
          />
        </div>
      </div>

      <div className="card">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="h-sub text-ink mb-1 flex items-center gap-2">
              <Sliders size={14} className="text-accent" />
              Show only active campaigns &amp; ad sets by default
            </div>
            <p className="text-sm text-ink-muted leading-relaxed max-w-2xl">
              When on, the Launch page&apos;s campaign and ad set dropdowns are filtered to only
              show items currently serving. You can flip this on the Launch page per launch.
            </p>
          </div>
          <Toggle
            checked={state.config.show_active_only_default}
            onChange={(v) =>
              onUpdate((c) => ({ ...c, show_active_only_default: v }))
            }
            disabled={!isAdmin}
          />
        </div>
      </div>

      <div className="card">
        <button
          type="button"
          onClick={() => setGranularOpen((v) => !v)}
          className="w-full flex items-center justify-between text-left"
        >
          <div className="flex items-center gap-2">
            {granularOpen ? (
              <ChevronDown size={14} className="text-ink-muted" />
            ) : (
              <ChevronRight size={14} className="text-ink-muted" />
            )}
            <div>
              <div className="h-sub text-ink">Individual enhancements</div>
              <p className="text-xs text-ink-subtle mt-0.5">
                Override specific enhancements regardless of the master setting.
              </p>
            </div>
          </div>
          <span className="text-xs text-ink-subtle">
            {overrideCount === 0 ? 'No overrides' : `${overrideCount} override${overrideCount === 1 ? '' : 's'}`}
          </span>
        </button>

        {granularOpen && (
          <div className="mt-5 space-y-5 pl-6">
            {(['Image', 'Video', 'Other'] as const).map((group) => (
              <div key={group}>
                <div className="text-xs font-medium text-ink-muted uppercase tracking-wider mb-2">
                  {group}
                </div>
                <div className="space-y-1">
                  {ENHANCEMENT_KEYS.filter((k) => ENHANCEMENT_LABELS[k].group === group).map((key) => {
                    const overrideValue = state.config.granular_overrides[key];
                    const effective = state.effective[key];
                    return (
                      <div
                        key={key}
                        className="flex items-center justify-between gap-4 py-1.5 px-2 rounded hover:bg-surface-hover"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-ink">{ENHANCEMENT_LABELS[key].label}</div>
                          <div className="text-xs text-ink-subtle">
                            Effective:{' '}
                            <span className={effective ? 'text-success font-medium' : 'text-ink-muted'}>
                              {effective ? 'enabled' : 'disabled'}
                            </span>
                            {overrideValue !== undefined && (
                              <span className="ml-2 text-accent">(override)</span>
                            )}
                          </div>
                        </div>
                        <TriToggle
                          value={overrideValue}
                          onChange={(v) => setGranular(key, v)}
                          disabled={!isAdmin}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {isAdmin ? (
        <div className="flex items-center gap-3">
          <button onClick={onSave} disabled={isSaving} className="btn-primary">
            <Save size={14} />
            {isSaving ? 'Saving…' : saveLabel}
          </button>
          {showRemoveOverride && onClearOverride && (
            <button onClick={onClearOverride} disabled={isSaving} className="btn-secondary">
              <RotateCcw size={14} />
              Remove override (use global)
            </button>
          )}
          {savedAt && Date.now() - savedAt < 4000 && (
            <span className="flex items-center gap-1 text-sm text-success">
              <CheckCircle2 size={14} />
              Saved
            </span>
          )}
        </div>
      ) : (
        <p className="text-xs text-ink-subtle">
          You don&apos;t have permission to change these settings. Only admins can.
        </p>
      )}
    </div>
  );
}

// =====================================================================
// Small components
// =====================================================================

function SaveStatus({ isSaving, savedAt }: { isSaving: boolean; savedAt: number | null }) {
  if (isSaving) return <span className="text-xs text-ink-subtle">Saving…</span>;
  if (savedAt && Date.now() - savedAt < 4000) {
    return (
      <span className="flex items-center gap-1 text-xs text-success">
        <CheckCircle2 size={12} />
        Saved
      </span>
    );
  }
  return null;
}

function TriToggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean | undefined;
  onChange: (v: boolean | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center rounded-full bg-surface-alt p-0.5 border border-line" role="radiogroup">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(false)}
        className={[
          'text-2xs font-medium uppercase tracking-wider px-2.5 py-1 rounded-full transition-colors',
          value === false ? 'bg-danger text-white' : 'text-ink-muted hover:text-ink',
        ].join(' ')}
      >
        Off
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(null)}
        className={[
          'text-2xs font-medium uppercase tracking-wider px-2.5 py-1 rounded-full transition-colors',
          value === undefined ? 'bg-surface shadow-subtle text-ink' : 'text-ink-muted hover:text-ink',
        ].join(' ')}
      >
        Auto
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(true)}
        className={[
          'text-2xs font-medium uppercase tracking-wider px-2.5 py-1 rounded-full transition-colors',
          value === true ? 'bg-success text-white' : 'text-ink-muted hover:text-ink',
        ].join(' ')}
      >
        On
      </button>
    </div>
  );
}
