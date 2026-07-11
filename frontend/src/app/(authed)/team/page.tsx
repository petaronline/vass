'use client';

/**
 * Team page — workspace user management (admin only).
 *
 * Layout:
 *   1. Header with "Add user" button
 *   2. The "How adding a tester works" info box (shows when admin clicks
 *      Add or when there are no users beyond themselves yet)
 *   3. Add-user form (collapsed by default)
 *   4. Users table with role picker + delete button
 *
 * Notes per Patch 4.18.1:
 *   - The workspace's Meta App is shared by every user. Test users do NOT
 *     create their own.
 *   - Each tester OAuths their own Facebook → gets their own pages and
 *     ad accounts. We surface that explicitly in the info box so the
 *     admin doesn't get confused about what gets shared.
 */
import { useCallback, useEffect, useMemo, useState, FormEvent } from 'react';
import { PageHeader, PAGE_TINTS } from '@/components/PageHeader';
import {
  Users, UserPlus, Trash2, AlertTriangle, CheckCircle2, Loader2,
  Info, ExternalLink, Copy, X, ShieldAlert, RefreshCw,
} from 'lucide-react';
import {
  auth, team, ApiError, TeamUser, CreateTeamUserInput, CurrentUser,
} from '@/lib/api';

type Role = 'admin' | 'member' | 'viewer';

export default function TeamPage() {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [users, setUsers] = useState<TeamUser[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  // Add-user form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [formEmail, setFormEmail] = useState('');
  const [formName, setFormName] = useState('');
  const [formRole, setFormRole] = useState<Role>('member');
  const [formPassword, setFormPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<{ email: string; password: string } | null>(null);

  // Per-row pending state for role change / delete
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const isAdmin = currentUser?.role === 'admin';

  const reload = useCallback(async () => {
    try {
      const [meRes, usersRes] = await Promise.all([auth.me(), team.list()]);
      setCurrentUser(meRes.user);
      setUsers(usersRes.users);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Failed to load team');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  /**
   * Generate a sturdy random 16-char password (letters + digits) for
   * pre-filling the new-user form. Admin can paste their own; this is
   * just a sensible default so they don't have to think.
   */
  function generateTempPassword(): string {
    const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < 16; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }

  function openAddForm() {
    setFormEmail('');
    setFormName('');
    setFormRole('member');
    setFormPassword(generateTempPassword());
    setFormError(null);
    setJustCreated(null);
    setShowAddForm(true);
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!isAdmin) return;
    setCreating(true);
    setFormError(null);
    try {
      const input: CreateTeamUserInput = {
        email: formEmail.trim().toLowerCase(),
        name: formName.trim(),
        role: formRole,
        password: formPassword,
      };
      await team.create(input);
      setJustCreated({ email: input.email, password: formPassword });
      // Reload list but keep the form area showing the credential card
      await reload();
      setShowAddForm(false);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Could not create user');
    } finally {
      setCreating(false);
    }
  }

  async function handleRoleChange(user: TeamUser, role: Role) {
    if (user.role === role) return;
    setBusyId(user.id);
    setRowError(null);
    try {
      const { user: updated } = await team.setRole(user.id, role);
      setUsers((prev) => prev?.map((u) => (u.id === user.id ? updated : u)) ?? null);
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : 'Failed to change role');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(user: TeamUser) {
    if (!confirm(`Remove ${user.name} (${user.email}) from this workspace?\n\nTheir launch history and uploads will be preserved but they won't be able to sign in.`)) {
      return;
    }
    setBusyId(user.id);
    setRowError(null);
    try {
      await team.remove(user.id);
      setUsers((prev) => prev?.filter((u) => u.id !== user.id) ?? null);
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : 'Failed to remove user');
    } finally {
      setBusyId(null);
    }
  }

  // ---------- RENDER ----------

  if (loading) {
    return (
      <div>
        <div className="card flex items-center gap-2 text-sm text-ink-muted">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      </div>
    );
  }

  if (authError) {
    return (
      <div>
        <div className="card text-sm text-danger">{authError}</div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div>
        <div className="card flex items-start gap-3 text-sm">
          <ShieldAlert size={18} className="text-warning shrink-0 mt-0.5" />
          <div>
            <div className="font-medium text-ink mb-0.5">Admins only</div>
            <div className="text-ink-muted">
              Workspace user management is restricted to admins.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <PageHeader
          icon={Users}
          title="Team"
          description="Manage who has access to this workspace."
          tint={PAGE_TINTS.team}
        />
        {!showAddForm && !justCreated && (
          <button onClick={openAddForm} className="btn-primary">
            <UserPlus size={14} />
            Add user
          </button>
        )}
      </div>

      {/* Onboarding info box (always visible when form is open OR when
          there's only one user — i.e. admin hasn't added anyone yet). */}
      {(showAddForm || (users && users.length <= 1)) && <TesterOnboardingInfo />}

      {/* Just-created success card with shareable credentials. The
          admin needs to copy these and send to the new user out of band. */}
      {justCreated && <CreatedCredentialsCard
        email={justCreated.email}
        password={justCreated.password}
        onDismiss={() => setJustCreated(null)}
      />}

      {/* Add-user form */}
      {showAddForm && (
        <form onSubmit={handleCreate} className="card space-y-4 mb-6">
          <div className="flex items-center justify-between mb-1">
            <h2 className="h-sub text-ink">Add a workspace user</h2>
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="btn-ghost text-xs"
            >
              <X size={12} /> Cancel
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label htmlFor="t-email" className="label">Email</label>
              <input
                id="t-email"
                type="email"
                required
                value={formEmail}
                onChange={(e) => setFormEmail(e.target.value)}
                placeholder="tester@example.com"
                className="input"
                disabled={creating}
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor="t-name" className="label">Full name</label>
              <input
                id="t-name"
                type="text"
                required
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="Jane Tester"
                className="input"
                disabled={creating}
                autoComplete="off"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label htmlFor="t-role" className="label">Role</label>
              <select
                id="t-role"
                value={formRole}
                onChange={(e) => setFormRole(e.target.value as Role)}
                className="input"
                disabled={creating}
              >
                <option value="member">Member — can launch ads with their own Facebook</option>
                <option value="admin">Admin — can also manage workspace settings + team</option>
                <option value="viewer">Viewer — read-only</option>
              </select>
            </div>
            <div>
              <label htmlFor="t-pass" className="label">
                Temporary password
                <span className="ml-2 text-ink-subtle normal-case tracking-normal">
                  (share with the user)
                </span>
              </label>
              <div className="flex gap-2">
                <input
                  id="t-pass"
                  type="text"
                  required
                  minLength={8}
                  value={formPassword}
                  onChange={(e) => setFormPassword(e.target.value)}
                  className="input flex-1 font-mono text-sm"
                  disabled={creating}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setFormPassword(generateTempPassword())}
                  className="btn-ghost"
                  title="Regenerate"
                  disabled={creating}
                >
                  <RefreshCw size={12} />
                </button>
              </div>
            </div>
          </div>

          {formError && (
            <div className="bg-red-50 border border-red-100 rounded-sm px-3 py-2 text-sm text-danger flex items-center gap-2">
              <AlertTriangle size={14} /> {formError}
            </div>
          )}

          <div className="pt-1">
            <button type="submit" className="btn-primary" disabled={creating}>
              {creating && <Loader2 size={12} className="animate-spin" />}
              {creating ? 'Creating…' : 'Create user'}
            </button>
          </div>
        </form>
      )}

      {/* Users table */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Users size={16} className="text-ink-muted" />
            <h2 className="h-sub text-ink">Workspace users</h2>
            {users && (
              <span className="text-xs text-ink-subtle">
                ({users.length})
              </span>
            )}
          </div>
        </div>

        {rowError && (
          <div className="bg-red-50 border border-red-100 rounded-sm px-3 py-2 text-sm text-danger mb-3 flex items-center gap-2">
            <AlertTriangle size={14} /> {rowError}
          </div>
        )}

        <div className="-mx-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-line bg-surface-alt">
                <th className="text-left font-medium text-ink-muted px-6 py-2.5 text-xs uppercase tracking-wider">User</th>
                <th className="text-left font-medium text-ink-muted px-3 py-2.5 text-xs uppercase tracking-wider">Role</th>
                <th className="text-left font-medium text-ink-muted px-3 py-2.5 text-xs uppercase tracking-wider">Last login</th>
                <th className="text-right font-medium text-ink-muted px-6 py-2.5 text-xs uppercase tracking-wider"></th>
              </tr>
            </thead>
            <tbody>
              {(users ?? []).map((u) => {
                const isSelf = currentUser?.id === u.id;
                const busy = busyId === u.id;
                return (
                  <tr key={u.id} className="border-b border-line">
                    <td className="px-6 py-3">
                      <div className="font-medium text-ink">{u.name}</div>
                      <div className="text-xs text-ink-muted">{u.email}{isSelf && ' · you'}</div>
                    </td>
                    <td className="px-3 py-3">
                      <select
                        value={u.role}
                        onChange={(e) => handleRoleChange(u, e.target.value as Role)}
                        disabled={busy || isSelf}
                        className="input text-xs py-1 max-w-[120px]"
                        title={isSelf ? "You can't change your own role" : ''}
                      >
                        <option value="admin">Admin</option>
                        <option value="member">Member</option>
                        <option value="viewer">Viewer</option>
                      </select>
                    </td>
                    <td className="px-3 py-3 text-xs text-ink-muted">
                      {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never'}
                    </td>
                    <td className="px-6 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => handleDelete(u)}
                        disabled={busy || isSelf}
                        className="btn-ghost text-xs text-danger hover:text-red-700 disabled:text-ink-subtle"
                        title={isSelf ? "You can't delete yourself" : 'Remove from workspace'}
                      >
                        {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// Sub-components
// =====================================================================

/**
 * Info box explaining the two-step Meta-side setup an admin needs to do
 * when onboarding a tester. Surfaced specifically here because this is
 * the moment in the flow where it matters.
 */
function TesterOnboardingInfo() {
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/70 p-5 mb-6 flex gap-3">
      <div className="shrink-0 w-7 h-7 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center">
        <Info size={14} />
      </div>
      <div className="flex-1 text-sm leading-relaxed space-y-3">
        <div className="font-medium text-ink">Adding a tester — two-step setup</div>
        <ol className="list-decimal pl-5 space-y-2 text-ink-muted">
          <li>
            <strong className="text-ink">Add their Facebook account as a Tester on your Meta App.</strong>{' '}
            Go to{' '}
            <a
              href="https://developers.facebook.com/apps/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:text-accent-hover underline inline-flex items-center gap-0.5"
            >
              developers.facebook.com <ExternalLink size={11} />
            </a>{' '}
            → your Vass Meta App → <strong>Roles → Roles</strong> → <strong>Add People</strong> →
            select <strong>Developers</strong> or <strong>Testers</strong> and enter their Facebook user.
            They'll get a notification on Facebook to accept.
          </li>
          <li>
            <strong className="text-ink">Create their Vass account here</strong> using the button above.
            Send them the email + temporary password out of band.
          </li>
        </ol>
        <div className="rounded-lg bg-white/60 border border-blue-100 px-3 py-2 text-xs text-ink-muted">
          <span className="font-medium text-ink">Their pages stay theirs.</span>{' '}
          When they click "Connect Facebook" in Vass, they sign in with their own Facebook account.
          They see only their own pages and ad accounts — yours stay invisible to them.
          The Meta App is just the shared OAuth client; nothing about their Facebook assets needs to be added to it.
        </div>
      </div>
    </div>
  );
}

/** Success card shown after a new user is created, with copy buttons. */
function CreatedCredentialsCard({
  email, password, onDismiss,
}: {
  email: string;
  password: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState<'email' | 'password' | 'both' | null>(null);
  function copy(value: string, label: 'email' | 'password' | 'both') {
    navigator.clipboard?.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  }
  const both = `Email: ${email}\nPassword: ${password}\nSign in at: ${typeof window !== 'undefined' ? window.location.origin : ''}/login`;

  return (
    <div className="rounded-lg border border-green-200 bg-green-50/70 p-5 mb-6">
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-7 h-7 rounded-lg bg-green-100 text-green-700 flex items-center justify-center">
          <CheckCircle2 size={14} />
        </div>
        <div className="flex-1">
          <div className="flex items-center justify-between mb-2">
            <div className="font-medium text-ink">User created. Share these credentials with them.</div>
            <button onClick={onDismiss} className="btn-ghost text-xs"><X size={12} /></button>
          </div>
          <p className="text-xs text-ink-muted mb-3">
            This is the only time the password is shown. Vass doesn't email it out for you — copy it now
            and send via Slack, password manager, or however you prefer.
          </p>
          <div className="space-y-2 font-mono text-xs">
            <CredRow label="Email" value={email} onCopy={() => copy(email, 'email')} copied={copied === 'email'} />
            <CredRow label="Password" value={password} onCopy={() => copy(password, 'password')} copied={copied === 'password'} />
          </div>
          <button
            onClick={() => copy(both, 'both')}
            className="btn-secondary text-xs mt-3"
          >
            <Copy size={11} />
            {copied === 'both' ? 'Copied!' : 'Copy email + password + login URL'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CredRow({
  label, value, onCopy, copied,
}: {
  label: string;
  value: string;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <div className="flex items-center gap-2 bg-white/60 border border-green-100 rounded-lg px-3 py-1.5">
      <span className="text-ink-subtle uppercase tracking-wider w-[70px] shrink-0">{label}</span>
      <span className="text-ink flex-1 truncate select-all">{value}</span>
      <button
        type="button"
        onClick={onCopy}
        className="text-ink-muted hover:text-ink text-2xs flex items-center gap-1"
      >
        {copied ? <CheckCircle2 size={11} className="text-success" /> : <Copy size={11} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
