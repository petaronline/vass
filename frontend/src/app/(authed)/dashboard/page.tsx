/**
 * Dashboard — the home page after login.
 *
 * Design (Patch 4.12):
 *   - Display greeting.
 *   - Four stat tiles in glass cards.
 *   - "Tools" grid: each card is a deep saturated coloured block. Icon,
 *     title, tagline, and CTA all sit on the colour — so the dashboard
 *     reads like a row of trading cards. Each product picks a different
 *     hue (indigo / orange / emerald / violet / slate / rose). Live cards
 *     lift on hover; coming-soon cards are muted.
 *   - Recent launches list underneath, full width.
 */
import { cookies } from 'next/headers';
import Link from 'next/link';
import {
  Rocket,
  Clock,
  Layers,
  KeyRound,
  AlertTriangle,
  Table2,
  Shield,
  BookCopy,
  History,
  ArrowRight,
  LayoutDashboard,
  type LucideIcon,
} from 'lucide-react';
import { ProductCard } from '@/components/ProductCard';

async function apiGet<T>(path: string, sessionCookie: string): Promise<T | null> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4040';
  try {
    const res = await fetch(`${apiUrl}${path}`, {
      headers: { Cookie: `vass_session=${sessionCookie}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface MetaStatus {
  hasCredentials: boolean;
  connected: boolean;
  connectedUserName: string | null;
}

interface AdAccountsResp {
  accounts: Array<{ id: string; isEnabled: boolean; status: string }>;
}

/** Subset of LaunchBatchSummary we render on the dashboard. */
interface RecentBatch {
  id: string;
  name: string;
  status: string;
  totalAdsPlanned: number;
  totalAdsLaunched: number;
  totalAdsFailed: number;
  adAccountName: string | null;
  startedAt: string | null;
  createdAt: string;
}

interface RecentBatchesResp {
  batches: RecentBatch[];
}

interface LaunchStats {
  adsLaunchedThisMonth: number;
  avgLaunchSeconds: number | null;
}

/** Format an average launch duration (seconds) into a compact label. */
function formatLaunchTime(seconds: number | null): string {
  if (seconds == null || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get('vass_session')?.value ?? '';

  const [me, metaStatus, adAccountsResp, recentBatchesResp, launchStats] = await Promise.all([
    apiGet<{ user: { name: string; role: string } }>('/auth/me', sessionCookie),
    apiGet<MetaStatus>('/settings/meta', sessionCookie),
    apiGet<AdAccountsResp>('/ad-accounts', sessionCookie),
    apiGet<RecentBatchesResp>('/launches', sessionCookie),
    apiGet<LaunchStats>('/launches/stats', sessionCookie),
  ]);

  const greeting = getGreeting();
  const firstName = me?.user?.name.split(' ')[0] ?? '';
  const isAdmin = me?.user?.role === 'admin';
  const recentBatches = recentBatchesResp?.batches?.slice(0, 5) ?? [];

  const enabledAdAccounts = adAccountsResp?.accounts?.filter((a) => a.isEnabled && a.status === 'active').length ?? 0;
  const metaConnected = metaStatus?.connected ?? false;

  return (
    <div className="relative w-full">
      {/* Greeting — dashboard is an async server component, so it renders
          the header inline rather than passing an icon function to the
          client-side PageHeader (which is not allowed across the boundary).
          Tint values are inlined (not read from PAGE_TINTS) so this never
          depends on PageHeader.tsx being in sync on the server. */}
      <header className="flex items-start gap-3 mb-6">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: 'rgba(99, 102, 241, 0.16)', color: '#4F46E5' }}
        >
          <LayoutDashboard size={18} strokeWidth={2} />
        </div>
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-ink">
            {greeting}, {firstName}.
          </h1>
          <p className="text-sm text-ink-muted mt-1 max-w-2xl">
            Welcome back. Pick a tool below to get started — or jump to a recent launch.
          </p>
        </div>
      </header>

      {/* Not-connected banner */}
      {!metaConnected && (
        <Link
          href="/settings/meta"
          className="group flex items-center gap-3 glass-card glass-card-hover px-4 py-3 mb-6 !border-amber-200/80"
          style={{ background: 'linear-gradient(rgba(255, 251, 235, 0.85), rgba(255, 251, 235, 0.85))' }}
        >
          <AlertTriangle size={18} className="text-warning shrink-0" />
          <div className="flex-1">
            <div className="text-sm font-medium text-ink">
              {isAdmin ? 'Meta is not connected yet.' : 'Vass is not connected to Meta yet.'}
            </div>
            <div className="text-xs text-ink-muted">
              {isAdmin
                ? 'Go to Settings → Meta connection to set up the integration.'
                : 'An admin needs to set up the Meta connection before you can launch ads.'}
            </div>
          </div>
          {isAdmin && (
            <span className="text-sm text-accent font-medium flex items-center gap-1 group-hover:gap-2 transition-all">
              Set up <ArrowRight size={14} />
            </span>
          )}
        </Link>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
        <StatCard
          icon={Rocket}
          label="Ads launched"
          value={launchStats ? String(launchStats.adsLaunchedThisMonth) : '—'}
          subtitle="This month"
        />
        <StatCard
          icon={Clock}
          label="Avg. launch time"
          value={formatLaunchTime(launchStats?.avgLaunchSeconds ?? null)}
          subtitle="Across batches"
        />
        <StatCard
          icon={Layers}
          label="Ad accounts"
          value={metaConnected ? String(enabledAdAccounts) : '—'}
          subtitle={metaConnected ? 'Ready to launch into' : 'Not connected yet'}
        />
        <StatCard
          icon={KeyRound}
          label="Meta"
          value={metaConnected ? 'Connected' : 'Off'}
          subtitle={metaStatus?.connectedUserName ?? 'Set up to start'}
        />
      </div>

      {/* Products grid */}
      <section className="mb-10">
        <header className="flex items-end justify-between mb-4">
          <div>
            <h2 className="h-section text-ink">Tools</h2>
            <p className="text-xs text-ink-muted mt-0.5">
              Every product Vass ships — live and on the way.
            </p>
          </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <ProductCard
            theme="launch"
            iconName="rocket"
            title="Launch"
            tagline="Single ad set, single creative — out in under a minute."
            href="/launch"
            ctaLabel="New launch"
            status="live"
          />
          <ProductCard
            theme="bulkLaunch"
            iconName="layers"
            title="Bulk launch"
            tagline="Drop many creatives at once. Auto-pairs 4×5 + 9×16 into ads."
            href="/bulk-launch"
            ctaLabel="Start bulk launch"
            status="live"
          />
          <ProductCard
            theme="sheets"
            iconName="table"
            title="Sheet launcher"
            tagline="Bulk-launch ads from a spreadsheet. Includes 9:16 + per-ad edit."
            href="/sheets"
            ctaLabel="Import a sheet"
            status="live"
          />
          <ProductCard
            theme="audit"
            iconName="shield"
            title="Audit"
            tagline="Scan a campaign for misconfigs, oddities, and underperformers."
            href="/audit"
            ctaLabel="Open audit"
            status="beta"
          />
          <ProductCard
            theme="launches"
            iconName="history"
            title="Launch history"
            tagline="Every batch you've run. Retry, edit, and re-queue failed ads."
            href="/launches"
            ctaLabel="See history"
            status="live"
          />
          <ProductCard
            theme="commentGuard"
            iconName="messageOff"
            title="Comment Guard"
            tagline="Auto-hide unwanted comments on your ads — links, phone numbers, profanity, keywords."
            href="/comment-guard"
            ctaLabel="Open Comment Guard"
            status="live"
          />
        </div>
      </section>

      {/* Recent activity */}
      <div className="grid grid-cols-1 gap-4">
        <section className="glass-card">
          <header className="flex items-center justify-between mb-4">
            <h2 className="h-sub text-ink">Recent launches</h2>
            <Link href="/launches" className="text-xs text-accent hover:text-accent-hover font-medium">
              View all →
            </Link>
          </header>
          {recentBatches.length === 0 ? (
            <div className="py-12 text-center text-sm text-ink-subtle">
              No launches yet. Once you connect Meta and launch your first batch,
              <br />
              it&apos;ll appear here.
            </div>
          ) : (
            <ul className="divide-y divide-line/60 -mx-2">
              {recentBatches.map((b) => (
                <li key={b.id}>
                  <Link
                    href={`/launches/${b.id}`}
                    className="flex items-center gap-3 px-2 py-2.5 rounded hover:bg-white/55 transition-colors"
                  >
                    <RecentStatusDot status={b.status} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-ink font-medium truncate">
                        {b.name || 'Untitled launch'}
                      </div>
                      <div className="text-xs text-ink-subtle truncate">
                        {b.adAccountName ?? 'Unknown account'}
                        {' · '}
                        {new Date(b.startedAt ?? b.createdAt).toLocaleString(undefined, {
                          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                        })}
                      </div>
                    </div>
                    <div className="text-xs text-ink-muted whitespace-nowrap">
                      <span className="text-success font-medium">{b.totalAdsLaunched}</span>
                      {' / '}
                      <span>{b.totalAdsPlanned}</span>
                      {b.totalAdsFailed > 0 && (
                        <span className="text-danger ml-1">({b.totalAdsFailed} failed)</span>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * Small coloured dot indicating a batch's status. Used in the dashboard
 * recent-launches list. Same palette as the /launches page badges.
 */
function RecentStatusDot({ status }: { status: string }) {
  const cls: Record<string, string> = {
    pending:   'bg-ink-subtle',
    running:   'bg-accent animate-pulse',
    completed: 'bg-success',
    partial:   'bg-warning',
    failed:    'bg-danger',
  };
  return (
    <span
      className={`w-2 h-2 rounded-full shrink-0 ${cls[status] ?? 'bg-ink-subtle'}`}
      title={status}
    />
  );
}


function StatCard({
  icon: Icon,
  label,
  value,
  subtitle,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  subtitle: string;
}) {
  return (
    <div className="glass-card !p-5">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-7 h-7 rounded-lg bg-accent-subtle text-accent flex items-center justify-center">
          <Icon size={14} />
        </div>
        <span className="text-xs font-medium text-ink-muted uppercase tracking-wider">
          {label}
        </span>
      </div>
      <div className="font-display text-3xl font-bold tracking-tight text-ink leading-none mb-1">
        {value}
      </div>
      <div className="text-xs text-ink-subtle">{subtitle}</div>
    </div>
  );
}

