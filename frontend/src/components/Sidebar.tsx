'use client';

/**
 * Sidebar — left navigation.
 *
 * Patch 4.24 introduces nested "groups" — a parent item with child
 * items underneath. The Organic group expands when active to reveal
 * Studio / Pipeline / Calendar. Other items remain flat.
 *
 * Layout (top → bottom):
 *   1. Logo (custom upload OR the built-in Vass mark)
 *   2. Primary nav (Dashboard, Launch, Bulk launch, Sheets, Audit,
 *      Templates, Organic [Studio/Pipeline/Calendar])
 *   3. Secondary nav (Launches history, Team, Settings) — directly above
 *      the user card so they don't clutter the main product navigation
 *   4. User card
 *
 * Aesthetic: a thin translucent rail with backdrop-blur so the page tint
 * shows through. Active items use a soft hue pill matching the dashboard
 * product palette.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  Rocket,
  Layers,
  BookCopy,
  History,
  Settings,
  Shield,
  Users,
  Table2,
  MessageSquareOff,
  Sprout,
  ChevronDown,
  PenLine,
  Workflow,
  FileText,
  Lightbulb,
  BarChart3,
  type LucideIcon,
} from 'lucide-react';
import { VassLogo } from './VassLogo';
import { branding, CurrentUser } from '@/lib/api';

// ─── Active style palette ────────────────────────────────────────────────────

interface ActiveStyle {
  bg: string;
  fg: string;
}

const ACTIVE_INDIGO: ActiveStyle = { bg: 'rgba(99, 102, 241, 0.16)',  fg: '#4338CA' };
const ACTIVE_AMBER:  ActiveStyle = { bg: 'rgba(251, 191, 36, 0.20)',  fg: '#B45309' };
const ACTIVE_ROSE:   ActiveStyle = { bg: 'rgba(244, 114, 182, 0.16)', fg: '#BE185D' };
const ACTIVE_MINT:   ActiveStyle = { bg: 'rgba(52, 211, 153, 0.16)',  fg: '#047857' };
const ACTIVE_LILAC:  ActiveStyle = { bg: 'rgba(167, 139, 250, 0.16)', fg: '#6D28D9' };
const ACTIVE_SKY:    ActiveStyle = { bg: 'rgba(125, 211, 252, 0.16)', fg: '#0369A1' };
const ACTIVE_SLATE:  ActiveStyle = { bg: 'rgba(100, 116, 139, 0.18)', fg: '#334155' };
const ACTIVE_TEAL:   ActiveStyle = { bg: 'rgba(20, 184, 166, 0.16)',  fg: '#0F766E' };

// ─── Nav item shapes ─────────────────────────────────────────────────────────

interface FlatNavItem {
  kind: 'flat';
  label: string;
  href: string;
  icon: LucideIcon;
  adminOnly?: boolean;
  active?: ActiveStyle;
}

interface GroupNavItem {
  kind: 'group';
  label: string;
  /** Used to detect "is anywhere inside this group active?" — also used
      as the default redirect target when the group label is clicked. */
  basePath: string;
  icon: LucideIcon;
  adminOnly?: boolean;
  active?: ActiveStyle;
  children: Array<{ label: string; href: string; icon: LucideIcon }>;
}

type NavItem = FlatNavItem | GroupNavItem;

// ─── Nav data ────────────────────────────────────────────────────────────────

const PRIMARY_NAV: NavItem[] = [
  { kind: 'flat',  label: 'Dashboard',   href: '/dashboard',   icon: LayoutDashboard, active: ACTIVE_SLATE },
  { kind: 'flat',  label: 'Launch',      href: '/launch',      icon: Rocket,          active: ACTIVE_INDIGO },
  { kind: 'flat',  label: 'Bulk launch', href: '/bulk-launch', icon: Layers,          active: ACTIVE_AMBER },
  { kind: 'flat',  label: 'Sheets',      href: '/sheets',      icon: Table2,          active: ACTIVE_ROSE },
  { kind: 'flat',  label: 'Audit',       href: '/audit',       icon: Shield,          active: ACTIVE_MINT },
  { kind: 'flat',  label: 'Comment Guard', href: '/comment-guard', icon: MessageSquareOff, active: ACTIVE_SKY },
  { kind: 'flat',  label: 'Templates',   href: '/templates',   icon: BookCopy,        active: ACTIVE_LILAC },
  {
    kind: 'group',
    label: 'Organic',
    basePath: '/organic',
    icon: Sprout,
    active: ACTIVE_TEAL,
    children: [
      { label: 'Studio',   href: '/organic/studio',   icon: PenLine },
      { label: 'Pipeline', href: '/organic/pipeline', icon: Workflow },
      { label: 'Drafts',   href: '/organic/drafts',   icon: FileText },
      { label: 'Ideas',    href: '/organic/ideas',    icon: Lightbulb },
      { label: 'Analytics', href: '/organic/analytics', icon: BarChart3 },
    ],
  },
];

const SECONDARY_NAV: NavItem[] = [
  { kind: 'flat', label: 'Launches', href: '/launches', icon: History,   active: ACTIVE_SKY },
  { kind: 'flat', label: 'Team',     href: '/team',     icon: Users,     adminOnly: true, active: ACTIVE_SLATE },
  { kind: 'flat', label: 'Settings', href: '/settings', icon: Settings,  active: ACTIVE_SLATE },
];

// ─── Sidebar ─────────────────────────────────────────────────────────────────

export function Sidebar({ user }: { user: CurrentUser }) {
  const pathname = usePathname();

  const filterByRole = (items: NavItem[]) =>
    items.filter((item) => !item.adminOnly || user.role === 'admin');

  const primary   = filterByRole(PRIMARY_NAV);
  const secondary = filterByRole(SECONDARY_NAV);

  // Custom-uploaded workspace logo (fetched once + listens for updates).
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      branding
        .get()
        .then((r) => !cancelled && setLogoDataUrl(r.logoDataUrl))
        .catch(() => { /* fall back to default mark */ });
    load();
    const onUpdate = () => load();
    window.addEventListener('vass:branding-updated', onUpdate);
    return () => {
      cancelled = true;
      window.removeEventListener('vass:branding-updated', onUpdate);
    };
  }, []);

  return (
    <aside
      className={[
        'w-[232px] shrink-0 h-screen sticky top-0 flex flex-col',
        'bg-white/55 backdrop-blur-card border-r border-white/60',
      ].join(' ')}
    >
      <div className="px-6 pt-7 pb-8">
        {logoDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoDataUrl}
            alt="Workspace logo"
            className="max-h-[28px] max-w-full object-contain"
          />
        ) : (
          <VassLogo variant="full" height={26} color="#0A0A0A" />
        )}
      </div>

      <nav className="px-3 overflow-y-auto flex-1">
        <NavList items={primary} pathname={pathname} />
      </nav>

      <nav className="px-3 pb-2 mt-2">
        <NavList items={secondary} pathname={pathname} />
      </nav>

      <div className="border-t border-white/60 px-3 py-3">
        <div className="flex items-center gap-3 px-2.5 py-2">
          <div className="w-8 h-8 rounded-full bg-accent-subtle text-accent flex items-center justify-center text-xs font-semibold shrink-0">
            {user.name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink truncate">{user.name}</div>
            <div className="text-xs text-ink-subtle truncate">{user.email}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}

// ─── NavList ─────────────────────────────────────────────────────────────────

function NavList({ items, pathname }: { items: NavItem[]; pathname: string }) {
  return (
    <ul className="space-y-0.5">
      {items.map((item) =>
        item.kind === 'flat' ? (
          <FlatRow key={item.href} item={item} pathname={pathname} />
        ) : (
          <GroupRow key={item.basePath} item={item} pathname={pathname} />
        )
      )}
    </ul>
  );
}

// ─── Flat row ────────────────────────────────────────────────────────────────

function FlatRow({ item, pathname }: { item: FlatNavItem; pathname: string }) {
  const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
  const Icon = item.icon;
  const active = item.active;
  return (
    <li>
      <Link
        href={item.href}
        className={[
          'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
          isActive ? '' : 'text-ink hover:bg-white/55',
        ].join(' ')}
        style={isActive && active ? { background: active.bg, color: active.fg } : undefined}
      >
        <Icon
          size={17}
          strokeWidth={2}
          style={isActive && active ? { color: active.fg } : undefined}
          className={isActive ? '' : 'text-ink-muted'}
        />
        <span>{item.label}</span>
      </Link>
    </li>
  );
}

// ─── Group row (collapsible) ─────────────────────────────────────────────────

function GroupRow({ item, pathname }: { item: GroupNavItem; pathname: string }) {
  const isInside = pathname === item.basePath || pathname.startsWith(`${item.basePath}/`);

  // Persistent open/closed state. Auto-open whenever pathname is inside;
  // user can toggle when not active. Defaults to closed.
  const storageKey = `vass:nav:group:${item.basePath}`;
  const [open, setOpen] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(storageKey);
    if (stored !== null) {
      setOpen(stored === '1');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the active path moves into this group, force-open.
  useEffect(() => {
    if (isInside && !open) {
      setOpen(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInside]);

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(storageKey, next ? '1' : '0');
      }
      return next;
    });
  };

  const Icon = item.icon;
  const active = item.active;
  const expanded = open || isInside;

  return (
    <li>
      {/* Group header — clickable to toggle, also navigates to first
          child when the user clicks the icon/label rather than the chevron.
          We split into two buttons so the chevron toggles without navigating. */}
      <div
        className={[
          'flex items-center gap-1 rounded-lg text-sm font-medium transition-colors',
          isInside ? '' : 'text-ink hover:bg-white/55',
        ].join(' ')}
        style={isInside && active ? { background: active.bg, color: active.fg } : undefined}
      >
        <Link
          href={item.children[0]?.href ?? item.basePath}
          className="flex-1 flex items-center gap-3 pl-3 py-2"
        >
          <Icon
            size={17}
            strokeWidth={2}
            style={isInside && active ? { color: active.fg } : undefined}
            className={isInside ? '' : 'text-ink-muted'}
          />
          <span>{item.label}</span>
        </Link>
        <button
          onClick={toggle}
          className="px-2 py-2 rounded-lg hover:bg-black/5 transition-colors"
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          <ChevronDown
            size={14}
            className={[
              'transition-transform',
              expanded ? 'rotate-0' : '-rotate-90',
              isInside ? '' : 'text-ink-subtle',
            ].join(' ')}
            style={isInside && active ? { color: active.fg } : undefined}
          />
        </button>
      </div>

      {expanded && (
        <ul className="mt-0.5 ml-3 pl-3 border-l border-line/50 space-y-0.5">
          {item.children.map((child) => {
            const isActive = pathname === child.href || pathname.startsWith(`${child.href}/`);
            const ChildIcon = child.icon;
            return (
              <li key={child.href}>
                <Link
                  href={child.href}
                  className={[
                    'flex items-center gap-2.5 px-2.5 py-1.5 rounded text-sm transition-colors',
                    isActive ? 'font-semibold' : 'text-ink-muted hover:text-ink hover:bg-white/55',
                  ].join(' ')}
                  style={isActive && active ? { color: active.fg } : undefined}
                >
                  <ChildIcon size={13} strokeWidth={2} />
                  <span>{child.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
