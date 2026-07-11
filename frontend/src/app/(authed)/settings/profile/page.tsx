'use client';

/**
 * Settings → Profile.
 *
 * For now: read-only name/email/role. Real profile editing (name/avatar/
 * password change) lives in a later phase.
 */
import { useEffect, useState } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { auth, CurrentUser } from '@/lib/api';

export default function ProfilePage() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    auth.me()
      .then((r) => !cancelled && setUser(r.user))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="card flex items-center gap-2 text-sm text-ink-muted">
        <Loader2 size={14} className="animate-spin" /> Loading…
      </div>
    );
  }

  if (!user) {
    return (
      <div className="card text-sm text-danger flex items-center gap-2">
        <AlertCircle size={14} /> {error ?? 'Failed to load profile.'}
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <section className="card space-y-3">
        <h2 className="h-sub text-ink">Account</h2>
        <ReadField label="Name" value={user.name} />
        <ReadField label="Email" value={user.email} />
        <ReadField label="Role" value={user.role} />
        <p className="text-xs text-ink-subtle pt-2">
          Name and email editing coming soon. To change your password, ask an admin to reset it.
        </p>
      </section>
    </div>
  );
}

function ReadField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <div className="text-xs font-medium text-ink-muted uppercase tracking-wider">
        {label}
      </div>
      <div className="text-sm text-ink">{value}</div>
    </div>
  );
}
