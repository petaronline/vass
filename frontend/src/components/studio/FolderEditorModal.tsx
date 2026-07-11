'use client';

/**
 * FolderEditorModal — pop-up for creating or editing an idea folder
 * (Patch 4.37.1). Name + preset color swatches + emoji input.
 */

import { useEffect, useRef, useState } from 'react';
import { X, Trash2, RefreshCw, Check } from 'lucide-react';
import {
  organicIdeaFolders,
  ApiError,
  type OrganicIdeaFolder,
} from '@/lib/api';

const FOLDER_COLOR_PRESETS: Array<{ value: string; label: string }> = [
  { value: '#6b7fa3', label: 'Slate' },
  { value: '#5b9f6a', label: 'Sage' },
  { value: '#c98a3e', label: 'Amber' },
  { value: '#a85a8a', label: 'Mauve' },
  { value: '#3e8aa8', label: 'Teal' },
  { value: '#a85a5a', label: 'Brick' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  brandId: string;
  folder: OrganicIdeaFolder | null; // null = create
  onSaved: (folder: OrganicIdeaFolder) => void;
  onDeleted?: (folderId: string) => void;
}

export function FolderEditorModal({
  open,
  onClose,
  brandId,
  folder,
  onSaved,
  onDeleted,
}: Props) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<string | null>(null);
  const [emoji, setEmoji] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (folder) {
      setName(folder.name);
      setColor(folder.color);
      setEmoji(folder.emoji ?? '');
    } else {
      setName('');
      setColor(null);
      setEmoji('');
    }
  }, [open, folder]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, saving, onClose]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (saving) return;
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const t = setTimeout(() => window.addEventListener('mousedown', onDoc), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onDoc);
    };
  }, [open, saving, onClose]);

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (folder) {
        const r = await organicIdeaFolders.update(folder.id, {
          name: name.trim(),
          color,
          emoji: emoji.trim() ? emoji.trim() : null,
        });
        onSaved(r.folder);
      } else {
        const r = await organicIdeaFolders.create({
          brandId,
          name: name.trim(),
          color,
          emoji: emoji.trim() ? emoji.trim() : null,
        });
        onSaved(r.folder);
      }
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!folder) return;
    if (!confirm(`Delete folder "${folder.name}"? Ideas inside become unfiled.`)) return;
    setSaving(true);
    try {
      await organicIdeaFolders.delete(folder.id);
      if (onDeleted) onDeleted(folder.id);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete');
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm px-4">
      <div
        ref={panelRef}
        className="bg-white border border-line rounded-lg shadow-card w-full max-w-md flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-line/60">
          <h2 className="h-sub text-ink">
            {folder ? 'Edit folder' : 'New folder'}
          </h2>
          <button
            onClick={onClose}
            disabled={saving}
            className="p-1.5 rounded text-ink-muted hover:text-ink hover:bg-surface-hover transition-colors disabled:opacity-40"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-ink-muted mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Q3 launch"
              maxLength={80}
              autoFocus
              className="w-full px-3 py-2 rounded-lg border border-line bg-white text-sm text-ink placeholder:text-ink-subtle focus:outline-none focus:border-accent"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink-muted mb-1">Emoji (optional)</label>
            <input
              type="text"
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
              placeholder="📁"
              maxLength={8}
              className="w-20 px-3 py-2 rounded-lg border border-line bg-white text-base text-ink placeholder:text-ink-subtle focus:outline-none focus:border-accent text-center"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink-muted mb-1">Color</label>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setColor(null)}
                className={[
                  'h-7 w-7 rounded-full border-2 flex items-center justify-center transition-all',
                  color === null
                    ? 'border-accent ring-2 ring-accent/30'
                    : 'border-line hover:border-ink-subtle',
                ].join(' ')}
                title="No color"
              >
                <span className="block w-4 h-4 rounded-full bg-surface-alt" />
              </button>
              {FOLDER_COLOR_PRESETS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => setColor(p.value)}
                  title={p.label}
                  className={[
                    'h-7 w-7 rounded-full border-2 transition-all',
                    color === p.value
                      ? 'border-accent ring-2 ring-accent/30'
                      : 'border-transparent hover:border-line',
                  ].join(' ')}
                  style={{ backgroundColor: p.value }}
                />
              ))}
            </div>
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg bg-danger/10 text-danger text-xs">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t border-line/60">
          <div>
            {folder && (
              <button
                onClick={handleDelete}
                disabled={saving}
                className="btn-danger"
              >
                <Trash2 size={13} />
                Delete
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="btn-ghost"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !name.trim()}
              className="btn-primary"
            >
              {saving ? (
                <>
                  <RefreshCw size={14} className="animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <Check size={14} />
                  {folder ? 'Save' : 'Create'}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
