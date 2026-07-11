'use client';

/**
 * Settings → Branding (admin only).
 *
 * Lets an admin upload a workspace logo (PNG or SVG, ≤ 500 KB). The logo
 * replaces the default Vass mark in the sidebar and on the login page.
 *
 * Storage flow:
 *   1. User picks a file via <input type="file"> or drops one onto the zone.
 *   2. FileReader converts it to a `data:image/...;base64,...` data URL
 *      entirely in-browser.
 *   3. We PUT that string to `/branding/logo`. Server validates format
 *      (PNG/SVG) and size (≤ 500 KB raw) and stores it in app_settings.
 *   4. After a successful save we dispatch a `vass:branding-updated`
 *      window event so the live sidebar reloads without a page refresh.
 *
 * "Reset to default" sends DELETE and dispatches the same event.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Image as ImageIcon,
  Upload,
  Trash2,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ShieldAlert,
} from 'lucide-react';
import { auth, branding } from '@/lib/api';

const MAX_BYTES = 500 * 1024;
const ACCEPT = 'image/png,image/svg+xml';

export default function BrandingPage() {
  // Auth gate — backend enforces too, but we render a friendly message
  // for non-admins who land here via URL.
  const [role, setRole] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // Current saved logo
  const [savedLogo, setSavedLogo] = useState<string | null>(null);

  // Pending (picked-but-not-saved) logo + flow state
  const [pending, setPending] = useState<{ dataUrl: string; sizeBytes: number; name: string } | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Initial load: auth + current logo (in parallel).
  useEffect(() => {
    let cancelled = false;
    Promise.all([auth.me(), branding.get()])
      .then(([me, b]) => {
        if (cancelled) return;
        setRole(me.user.role);
        setSavedLogo(b.logoDataUrl);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      })
      .finally(() => !cancelled && setAuthLoading(false));
    return () => { cancelled = true; };
  }, []);

  /** Pick a file from the OS picker or drag-drop. Validates type + size
      and reads it into a base64 data URL in-browser. */
  async function handleFile(file: File) {
    setError(null);
    if (file.type !== 'image/png' && file.type !== 'image/svg+xml') {
      setError('Only PNG or SVG files are allowed.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`File is too large (${Math.round(file.size / 1024)} KB). Max 500 KB.`);
      return;
    }
    try {
      const dataUrl = await readAsDataUrl(file);
      setPending({ dataUrl, sizeBytes: file.size, name: file.name });
      setSaveState('idle');
    } catch {
      setError('Could not read the file.');
    }
  }

  async function save() {
    if (!pending) return;
    setSaveState('saving');
    setError(null);
    try {
      await branding.putLogo(pending.dataUrl);
      setSavedLogo(pending.dataUrl);
      setPending(null);
      setSaveState('saved');
      window.dispatchEvent(new Event('vass:branding-updated'));
      setTimeout(() => setSaveState('idle'), 2000);
    } catch (e) {
      setSaveState('error');
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  async function clear() {
    setSaveState('saving');
    setError(null);
    try {
      await branding.deleteLogo();
      setSavedLogo(null);
      setPending(null);
      setSaveState('saved');
      window.dispatchEvent(new Event('vass:branding-updated'));
      setTimeout(() => setSaveState('idle'), 2000);
    } catch (e) {
      setSaveState('error');
      setError(e instanceof Error ? e.message : 'Reset failed');
    }
  }

  // -------- Render --------

  if (authLoading) {
    return (
      <div className="card flex items-center gap-2 text-sm text-ink-muted">
        <Loader2 size={14} className="animate-spin" /> Loading…
      </div>
    );
  }

  if (role !== 'admin') {
    return (
      <div className="card flex items-start gap-3 text-sm">
        <ShieldAlert size={18} className="text-warning shrink-0 mt-0.5" />
        <div>
          <div className="font-medium text-ink mb-0.5">Admins only</div>
          <div className="text-ink-muted">
            Workspace branding is managed by an admin. Ask one to upload a logo
            if you need to change it.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-2xl">
      {/* Header */}
      <section className="card space-y-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-accent-subtle text-accent flex items-center justify-center">
            <ImageIcon size={14} />
          </div>
          <h2 className="h-sub text-ink">Workspace logo</h2>
        </div>
        <p className="text-xs text-ink-muted leading-relaxed">
          Upload a PNG or SVG. It replaces the default Vass mark in the sidebar
          and on the login page. Max 500 KB. Wide horizontal logos work best.
        </p>

        {/* Current saved logo */}
        <div className="rounded-lg border border-line bg-surface-alt/60 px-4 py-3">
          <div className="text-2xs font-medium text-ink-muted uppercase tracking-wider mb-2">
            Current
          </div>
          <div className="flex items-center gap-3 min-h-[40px]">
            {savedLogo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={savedLogo}
                alt="Current workspace logo"
                className="max-h-[40px] max-w-[200px] object-contain"
              />
            ) : (
              <span className="text-sm text-ink-subtle italic">
                Default Vass logo
              </span>
            )}
            {savedLogo && (
              <button
                type="button"
                onClick={clear}
                disabled={saveState === 'saving'}
                className="ml-auto btn-ghost text-xs text-danger hover:text-red-700"
              >
                <Trash2 size={12} /> Reset to default
              </button>
            )}
          </div>
        </div>

        {/* Upload dropzone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) handleFile(file);
          }}
          className={[
            'rounded-lg border-2 border-dashed px-4 py-6 flex flex-col items-center gap-2 transition-colors',
            isDragging
              ? 'border-accent bg-accent-subtle'
              : 'border-line bg-surface-alt/30 hover:bg-surface-alt/60',
          ].join(' ')}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
              // Reset so picking the same file twice still fires onChange
              e.target.value = '';
            }}
            className="hidden"
          />
          <Upload size={20} className="text-ink-muted" />
          <div className="text-sm text-ink-muted text-center">
            Drag &amp; drop a PNG or SVG here, or{' '}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-accent hover:text-accent-hover font-medium"
            >
              pick a file
            </button>
          </div>
          <div className="text-2xs text-ink-subtle">PNG / SVG · up to 500 KB</div>
        </div>

        {/* Pending preview + save */}
        {pending && (
          <div className="rounded-lg border border-accent bg-accent-subtle px-4 py-3">
            <div className="text-2xs font-medium text-accent uppercase tracking-wider mb-2">
              Preview — not yet saved
            </div>
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={pending.dataUrl}
                alt="New logo preview"
                className="max-h-[40px] max-w-[200px] object-contain"
              />
              <div className="text-xs text-ink-muted min-w-0 flex-1 truncate">
                {pending.name}
                {' · '}
                {Math.round(pending.sizeBytes / 1024)} KB
              </div>
              <button
                type="button"
                onClick={() => setPending(null)}
                className="btn-ghost text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saveState === 'saving'}
                className="btn-primary text-xs"
              >
                {saveState === 'saving' && <Loader2 size={12} className="animate-spin" />}
                {saveState === 'saving' ? 'Saving…' : 'Save logo'}
              </button>
            </div>
          </div>
        )}

        {saveState === 'saved' && (
          <div className="text-xs text-success flex items-center gap-1.5">
            <CheckCircle2 size={12} /> Saved.
          </div>
        )}
        {error && (
          <div className="text-xs text-danger flex items-start gap-1.5">
            <AlertCircle size={12} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Read a File as a base64 data URL. FileReader's `readAsDataURL` does
 * exactly this and returns it via the load event. Wrapped in a Promise
 * because callers await it.
 */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') return reject(new Error('Bad reader result'));
      resolve(result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Read error'));
    reader.readAsDataURL(file);
  });
}
