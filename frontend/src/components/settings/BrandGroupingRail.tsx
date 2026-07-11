'use client';

/**
 * BrandGroupingRail (Patch 4.38.2) — the shared left-rail used by
 * Settings → Social profiles, Ad accounts, and Brands. It renders the
 * "Groupings" card: an Unassigned bucket pinned to the top, every
 * brand below it (with a first-member-avatar thumbnail + count), and
 * an inline "New brand" form. Brands can be renamed, recolored and
 * deleted in place. Every row is a drag target so accounts can be
 * dropped onto a brand to assign them.
 *
 * This component is presentational + self-contained for brand CRUD —
 * the parent owns the brand list state and passes handlers. Assignment
 * (drop) is delegated to the parent via onDropOnBrand because the
 * payload format differs per page (organic vs ad vs unified).
 */

import { useState, type DragEvent, type ReactNode } from 'react';
import { Plus, Check, X, Edit2, Trash2, Inbox } from 'lucide-react';

export const BRAND_COLORS = [
  '#6366F1', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444',
  '#EC4899', '#8B5CF6', '#14B8A6', '#F97316', '#64748B',
];

export const UNASSIGNED_ID = '__unassigned__';

export interface RailBrand {
  id: string;
  name: string;
  color: string;
}

export function BrandRow({
  isActive,
  isDragOver,
  color,
  icon,
  thumbnailUrl,
  label,
  count,
  onClick,
  onDragOver,
  onDragLeave,
  onDrop,
  onEdit,
  onDelete,
}: {
  isActive: boolean;
  isDragOver: boolean;
  color: string;
  icon?: ReactNode;
  thumbnailUrl?: string | null;
  label: string;
  count: number;
  onClick: () => void;
  onDragOver: (e: DragEvent<HTMLLIElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent<HTMLLIElement>) => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <li
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={[
        'group flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors',
        isActive ? 'bg-accent-subtle text-accent' : 'text-ink hover:bg-white/60',
        isDragOver ? 'ring-2 ring-accent/50 bg-accent-subtle' : '',
      ].join(' ')}
      onClick={onClick}
    >
      {icon ? (
        <span className="shrink-0 text-ink-muted">{icon}</span>
      ) : thumbnailUrl ? (
        <div
          className="w-5 h-5 rounded-full shrink-0 overflow-hidden ring-2"
          style={{ boxShadow: `0 0 0 2px ${color}` }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={thumbnailUrl} alt="" className="w-full h-full object-cover" />
        </div>
      ) : (
        <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: color }} />
      )}
      <span className="flex-1 text-sm font-medium truncate">{label}</span>
      <span className={[
        'text-2xs font-semibold px-1.5 rounded-full',
        isActive ? 'bg-accent/15' : 'bg-surface-hover text-ink-subtle',
      ].join(' ')}>
        {count}
      </span>
      {onEdit && onDelete && (
        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5">
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="p-1 text-ink-subtle hover:text-ink rounded"
            title="Rename"
          >
            <Edit2 size={11} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="p-1 text-ink-subtle hover:text-danger rounded"
            title="Delete"
          >
            <Trash2 size={11} />
          </button>
        </div>
      )}
    </li>
  );
}

export function BrandGroupingRail({
  brands,
  selectedId,
  onSelect,
  unassignedCount,
  countForBrand,
  thumbnailForBrand,
  dragOverId,
  onDragOverBrand,
  onDragLeaveBrand,
  onDropOnBrand,
  onCreateBrand,
  onRenameBrand,
  onRecolorBrand,
  onDeleteBrand,
  footer,
}: {
  brands: RailBrand[];
  selectedId: string;
  onSelect: (id: string) => void;
  unassignedCount: number;
  countForBrand: (brandId: string) => number;
  thumbnailForBrand: (brandId: string) => string | null;
  dragOverId: string | null;
  onDragOverBrand: (e: DragEvent<HTMLLIElement>, brandId: string) => void;
  onDragLeaveBrand: () => void;
  onDropOnBrand: (e: DragEvent<HTMLLIElement>, brandId: string) => void;
  onCreateBrand: (name: string, color: string) => void;
  onRenameBrand: (id: string, name: string) => void;
  onRecolorBrand: (id: string, color: string) => void;
  onDeleteBrand: (id: string) => void;
  /** Optional extra block under the groupings card (e.g. Connect a
   *  profile on the social page). */
  footer?: ReactNode;
}) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(BRAND_COLORS[0]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const create = () => {
    if (!newName.trim()) return;
    onCreateBrand(newName.trim(), newColor);
    setCreating(false);
    setNewName('');
    setNewColor(BRAND_COLORS[0]);
  };
  const saveRename = (id: string) => {
    if (editingName.trim()) onRenameBrand(id, editingName.trim());
    setEditingId(null);
  };

  return (
    <aside className="space-y-5 self-start">
      <div className="bg-white/72 backdrop-blur-card border border-white/60 rounded-lg shadow-glass p-3">
        <div className="px-2 py-1.5 text-2xs uppercase tracking-wider font-semibold text-ink-subtle">
          Groupings
        </div>
        <ul className="space-y-0.5">
          <BrandRow
            isActive={selectedId === UNASSIGNED_ID}
            isDragOver={dragOverId === UNASSIGNED_ID}
            color="#9CA3AF"
            icon={<Inbox size={14} />}
            label="Unassigned"
            count={unassignedCount}
            onClick={() => onSelect(UNASSIGNED_ID)}
            onDragOver={(e) => onDragOverBrand(e, UNASSIGNED_ID)}
            onDragLeave={onDragLeaveBrand}
            onDrop={(e) => onDropOnBrand(e, UNASSIGNED_ID)}
          />

          {brands.map((brand) =>
            editingId === brand.id ? (
              <li key={brand.id} className="px-2 py-2 border border-dashed border-line rounded mt-1">
                <input
                  autoFocus
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveRename(brand.id);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  className="w-full px-2 py-1 text-sm border border-line rounded bg-white focus:outline-none focus:border-accent mb-2"
                />
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {BRAND_COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => onRecolorBrand(brand.id, c)}
                      className={[
                        'w-5 h-5 rounded-full border-2 transition-transform',
                        brand.color === c ? 'border-ink scale-110' : 'border-transparent hover:scale-105',
                      ].join(' ')}
                      style={{ backgroundColor: c }}
                      title={c}
                    />
                  ))}
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => saveRename(brand.id)}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs font-medium rounded bg-accent text-white hover:bg-accent-hover"
                  >
                    <Check size={12} /> Save
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    className="px-2 py-1 text-xs text-ink-muted hover:text-ink"
                  >
                    <X size={12} />
                  </button>
                </div>
              </li>
            ) : (
              <BrandRow
                key={brand.id}
                isActive={selectedId === brand.id}
                isDragOver={dragOverId === brand.id}
                color={brand.color}
                thumbnailUrl={thumbnailForBrand(brand.id)}
                label={brand.name}
                count={countForBrand(brand.id)}
                onClick={() => onSelect(brand.id)}
                onDragOver={(e) => onDragOverBrand(e, brand.id)}
                onDragLeave={onDragLeaveBrand}
                onDrop={(e) => onDropOnBrand(e, brand.id)}
                onEdit={() => { setEditingId(brand.id); setEditingName(brand.name); }}
                onDelete={() => onDeleteBrand(brand.id)}
              />
            )
          )}

          {creating ? (
            <li className="px-2 py-2 border border-dashed border-line rounded mt-2">
              <input
                autoFocus
                placeholder="Brand name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') create();
                  if (e.key === 'Escape') { setCreating(false); setNewName(''); }
                }}
                className="w-full px-2 py-1 text-sm border border-line rounded bg-white focus:outline-none focus:border-accent mb-2"
              />
              <div className="flex flex-wrap gap-1.5 mb-2">
                {BRAND_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setNewColor(c)}
                    className={[
                      'w-5 h-5 rounded-full border-2 transition-transform',
                      newColor === c ? 'border-ink scale-110' : 'border-transparent hover:scale-105',
                    ].join(' ')}
                    style={{ backgroundColor: c }}
                    title={c}
                  />
                ))}
              </div>
              <div className="flex gap-1">
                <button
                  onClick={create}
                  disabled={!newName.trim()}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs font-medium rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Check size={12} /> Create
                </button>
                <button
                  onClick={() => { setCreating(false); setNewName(''); }}
                  className="px-2 py-1 text-xs text-ink-muted hover:text-ink"
                >
                  <X size={12} />
                </button>
              </div>
            </li>
          ) : (
            <li className="mt-2">
              <button
                onClick={() => setCreating(true)}
                className="w-full flex items-center gap-2 px-2.5 py-2 text-sm text-ink-muted hover:text-ink hover:bg-white/55 rounded-lg transition-colors"
              >
                <Plus size={14} />
                New brand
              </button>
            </li>
          )}
        </ul>
      </div>

      {footer}
    </aside>
  );
}
