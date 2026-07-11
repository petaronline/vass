'use client';

/**
 * Settings → Ad accounts (Patch 4.38.3 — flat list, no grouping).
 *
 * This page exists to see which ad accounts are connected and to
 * enable the ones the team can launch into. Brand grouping lives
 * entirely on Settings → Brands, so assigned accounts never disappear
 * from here — the list always shows everything.
 *
 * Layout mirrors Social profiles:
 *   Left rail  — a "Connect" card (single action that runs the Meta
 *                connect/sync flow), plus a pointer to the Brands page.
 *   Main panel — a flat list of every ad account, each row with a
 *                status dot, linked FB/IG indicators, and an enable
 *                toggle. Search by name or account ID.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, CheckCircle2, AlertCircle, Search, Megaphone, Plus } from 'lucide-react';
import { adAccounts, ApiError, AdAccount } from '@/lib/api';
import { Toggle } from '@/components/Toggle';

interface Toast { id: number; type: 'success' | 'error'; message: string; }
let toastCounter = 0;

export default function AdAccountsPage() {
  const [accounts, setAccounts] = useState<AdAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((type: Toast['type'], message: string) => {
    const id = ++toastCounter;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await adAccounts.list(true);
      setAccounts(res.accounts);
    } catch (err) {
      addToast('error', err instanceof ApiError ? err.message : 'Failed to load ad accounts');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => { load(); }, [load]);

  async function handleSync() {
    setSyncing(true);
    try {
      const result = await adAccounts.sync();
      addToast('success', `Synced — ${result.added} added, ${result.updated} updated, ${result.disappeared} gone.`);
      await load();
    } catch (err) {
      addToast('error', err instanceof ApiError ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  async function handleToggle(id: string, isEnabled: boolean) {
    setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, isEnabled } : a)));
    try {
      await adAccounts.setEnabled(id, isEnabled);
    } catch (err) {
      setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, isEnabled: !isEnabled } : a)));
      addToast('error', err instanceof ApiError ? err.message : 'Failed to update');
    }
  }

  const visibleAccounts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter(
      (a) => a.name.toLowerCase().includes(q) || a.metaAccountId.toLowerCase().includes(q)
    );
  }, [accounts, search]);

  return (
    <div className="relative">
      {/* Toasts */}
      <div className="fixed top-5 right-5 z-50 flex flex-col gap-2 w-80">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={[
              'flex items-start gap-3 px-4 py-3 rounded-lg shadow-lift border text-sm animate-slide-up',
              t.type === 'success' ? 'bg-white border-success/30 text-ink' : 'bg-white border-danger/30 text-ink',
            ].join(' ')}
          >
            {t.type === 'success' ? (
              <CheckCircle2 size={16} className="text-success shrink-0 mt-0.5" />
            ) : (
              <AlertCircle size={16} className="text-danger shrink-0 mt-0.5" />
            )}
            <span>{t.message}</span>
          </div>
        ))}
      </div>

      {/* Header */}
      <div className="mb-6">
        <h2 className="h-section text-ink">Ad accounts</h2>
        <p className="text-sm text-ink-muted mt-0.5">
          Enable the accounts your team can launch into. Connected from your workspace Meta App.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">
        {/* ═══ Left rail — Connect card ════════════════════════════════════ */}
        <aside className="space-y-5 self-start">
          <div className="bg-white/72 backdrop-blur-card border border-white/60 rounded-lg shadow-glass p-3">
            <div className="px-2 py-1.5 text-2xs uppercase tracking-wider font-semibold text-ink-subtle">
              Connect
            </div>
            <ul className="space-y-0.5">
              <li>
                <button
                  onClick={handleSync}
                  disabled={syncing}
                  className="flex items-center gap-3 w-full px-2.5 py-2 rounded-lg text-sm font-medium text-ink hover:bg-white/55 transition-colors disabled:opacity-50"
                >
                  <div
                    className="w-6 h-6 rounded flex items-center justify-center shrink-0"
                    style={{ backgroundColor: '#1877F218' }}
                  >
                    {syncing ? (
                      <RefreshCw size={12} className="animate-spin" style={{ color: '#1877F2' }} />
                    ) : (
                      <Megaphone size={12} style={{ color: '#1877F2' }} strokeWidth={2.2} />
                    )}
                  </div>
                  <span className="flex-1 text-left">{syncing ? 'Syncing…' : 'Sync ad accounts'}</span>
                  <Plus size={13} className="text-ink-subtle" />
                </button>
              </li>
            </ul>
            <p className="px-2.5 pt-2 text-2xs text-ink-subtle leading-relaxed">
              Ad accounts are pulled from the Meta account connected in{' '}
              <a href="/settings/connections" className="text-accent hover:underline">Connections</a>.
            </p>
          </div>

          {/* Grouping hint — points to the Brands page */}
          <div className="px-3 py-2.5 rounded-lg bg-white/40 border border-white/60 text-2xs text-ink-muted leading-relaxed">
            Organize these ad accounts into brands in{' '}
            <a href="/settings/brands" className="text-accent hover:underline">Settings → Brands</a>.
          </div>
        </aside>

        {/* ═══ Right pane — flat list ══════════════════════════════════════ */}
        <div>
          <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
            <div>
              <div className="text-sm font-semibold text-ink">All ad accounts</div>
              <div className="text-xs text-ink-subtle">Every connected ad account.</div>
            </div>
            <span className="text-xs text-ink-subtle">
              {visibleAccounts.length} of {accounts.length}
            </span>
          </div>

          {accounts.length > 0 && (
            <div className="relative mb-3">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle pointer-events-none" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or account ID…"
                className="w-full pl-9 pr-3 py-2 text-sm bg-white/70 border border-white/60 rounded-lg placeholder:text-ink-subtle focus:bg-white focus:border-accent focus:ring-2 focus:ring-accent/15 focus:outline-none transition-colors"
              />
            </div>
          )}

          {loading ? (
            <div className="px-6 py-16 text-center text-sm text-ink-subtle">Loading…</div>
          ) : visibleAccounts.length === 0 ? (
            <div className="border border-dashed border-line rounded-lg px-6 py-12 text-center bg-white/30">
              <p className="text-sm text-ink-muted">
                {search.trim()
                  ? `No matches for "${search}".`
                  : 'No ad accounts yet. Use the Connect card on the left to sync from Meta.'}
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {visibleAccounts.map((acct) => (
                <AdAccountCard key={acct.id} acct={acct} onToggle={handleToggle} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Ad account row ──────────────────────────────────────────────────

function AdAccountCard({
  acct,
  onToggle,
}: {
  acct: AdAccount;
  onToggle: (id: string, v: boolean) => void;
}) {
  const isActive = acct.status === 'active';
  return (
    <li className="flex items-center gap-3 bg-white/72 backdrop-blur-card border border-white/60 rounded-lg shadow-glass px-4 py-3">
      {acct.pictureUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={acct.pictureUrl} alt="" className="w-9 h-9 rounded-full shrink-0 object-cover" />
      ) : (
        <div className="w-9 h-9 rounded-full shrink-0 bg-surface-alt flex items-center justify-center">
          <Megaphone size={15} className="text-ink-subtle" />
        </div>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink truncate">{acct.name}</span>
          <span
            className={[
              'inline-flex items-center gap-1 text-2xs',
              isActive ? 'text-success' : 'text-ink-subtle',
            ].join(' ')}
            title={isActive ? 'Active' : 'Disabled'}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-success' : 'bg-ink-subtle'}`} />
            {acct.status}
          </span>
        </div>
        <div className="text-xs text-ink-subtle font-mono">{acct.metaAccountId}</div>
      </div>

      <div className="flex flex-col gap-0.5 text-2xs shrink-0">
        <span
          className={acct.pageId ? 'text-success' : 'text-ink-subtle'}
          title={acct.pageId ? `Page ID: ${acct.pageId}` : 'No linked Page'}
        >
          {acct.pageId ? '●' : '○'} FB
        </span>
        <span
          className={acct.instagramUserId ? 'text-success' : 'text-ink-subtle'}
          title={acct.instagramUserId ? `IG User ID: ${acct.instagramUserId}` : 'No linked Instagram'}
        >
          {acct.instagramUserId ? '●' : '○'} IG
        </span>
      </div>

      <div className="shrink-0 pl-1">
        <Toggle
          checked={acct.isEnabled}
          onChange={(v) => onToggle(acct.id, v)}
          disabled={!isActive}
          size="sm"
        />
      </div>
    </li>
  );
}
