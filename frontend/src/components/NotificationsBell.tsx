'use client';

/**
 * Notifications bell for the TopBar.
 *
 * Polls /notifications every 60s, shows an unread badge, and opens a dropdown
 * listing recent events (launch finished/failed, Comment Guard hides, expiring
 * tokens, sync errors). Clicking an item marks it read and follows its link.
 *
 * Failures are silent by design — the bell must never break the top bar.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bell, Check, Rocket, MessageSquareOff, KeyRound, AlertTriangle, Inbox } from 'lucide-react';
import { notifications as notificationsApi, AppNotification } from '@/lib/api';

const POLL_MS = 60_000;

/** Icon per event type (falls back to a generic bell). */
function iconFor(type: string) {
  if (type.startsWith('launch.')) return Rocket;
  if (type.startsWith('comment_guard.')) return MessageSquareOff;
  if (type === 'meta.token_expiring') return KeyRound;
  if (type === 'sync.error') return AlertTriangle;
  return Bell;
}

const SEVERITY_COLOR: Record<string, string> = {
  success: 'text-emerald-600',
  warning: 'text-amber-600',
  error: 'text-red-600',
  info: 'text-sky-600',
};

function timeAgo(iso: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function NotificationsBell() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    notificationsApi
      .list()
      .then((r) => {
        setItems(r.notifications);
        setUnread(r.unreadCount);
      })
      .catch(() => {
        /* silent — never break the top bar */
      });
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Close on outside click
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const markAllRead = async () => {
    setUnread(0);
    setItems((cur) => cur.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    try {
      await notificationsApi.markRead();
    } catch {
      /* optimistic; next poll reconciles */
    }
  };

  const markOneRead = async (id: string) => {
    setItems((cur) =>
      cur.map((n) => (n.id === id ? { ...n, readAt: n.readAt ?? new Date().toISOString() } : n))
    );
    setUnread((u) => Math.max(0, u - 1));
    try {
      await notificationsApi.markRead([id]);
    } catch {
      /* optimistic */
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        aria-label="Notifications"
        onClick={() => setOpen((v) => !v)}
        className="relative p-2 rounded hover:bg-white/55 text-ink-muted hover:text-ink transition-colors"
      >
        <Bell size={18} strokeWidth={2} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-accent text-white text-[10px] font-semibold leading-none">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[360px] max-h-[70vh] overflow-hidden flex flex-col rounded-xl border border-black/10 bg-white shadow-lg z-50">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-black/5">
            <span className="text-sm font-semibold text-ink">Notifications</span>
            {unread > 0 && (
              <button
                onClick={markAllRead}
                className="text-xs text-accent hover:underline flex items-center gap-1"
              >
                <Check size={12} /> Mark all read
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <Inbox size={20} className="text-ink-subtle" />
              <span className="text-sm text-ink-muted">You&apos;re all caught up.</span>
            </div>
          ) : (
            <ul className="overflow-y-auto divide-y divide-black/5">
              {items.map((n) => {
                const Icon = iconFor(n.type);
                const color = SEVERITY_COLOR[n.severity] ?? SEVERITY_COLOR.info;
                const unreadItem = !n.readAt;
                const inner = (
                  <div
                    className={`flex items-start gap-3 px-4 py-3 hover:bg-black/[0.03] transition-colors ${
                      unreadItem ? 'bg-sky-50/40' : ''
                    }`}
                  >
                    <Icon size={15} className={`mt-0.5 shrink-0 ${color}`} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-ink leading-snug">{n.title}</div>
                      {n.body && (
                        <div className="text-xs text-ink-muted mt-0.5 leading-snug">{n.body}</div>
                      )}
                      <div className="text-[11px] text-ink-subtle mt-1">{timeAgo(n.createdAt)}</div>
                    </div>
                    {unreadItem && (
                      <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                    )}
                  </div>
                );
                return (
                  <li key={n.id}>
                    {n.link ? (
                      <Link
                        href={n.link}
                        onClick={() => {
                          markOneRead(n.id);
                          setOpen(false);
                        }}
                      >
                        {inner}
                      </Link>
                    ) : (
                      <button className="w-full text-left" onClick={() => markOneRead(n.id)}>
                        {inner}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
