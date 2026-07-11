'use client';

/**
 * BrandHashtagsSection (Patch 4.38.4) — extracted from the old Social
 * profiles page so it can live on the Brands page, where brand
 * selection now happens.
 *
 * Renders a chip editor for a brand's hashtags. Up to 10 tags; the
 * first 3 are framed as "recommended". Auto-saves on change with a
 * 400ms debounce (no save button). Tags are stored without the
 * leading '#', lowercased, invalid chars stripped.
 *
 * These hashtags surface as quick-insert chips in the composer
 * toolbar when the brand is active.
 */

import { useEffect, useRef, useState } from 'react';
import { X, AlertCircle } from 'lucide-react';
import { brandHashtags as brandHashtagsApi, ApiError } from '@/lib/api';

export function BrandHashtagsSection({
  brandId,
  onError,
}: {
  brandId: string;
  onError?: (message: string) => void;
}) {
  const MAX_TAGS = 10;
  const RECOMMENDED = 3;

  const [tags, setTags] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const baselineRef = useRef<string>('');

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    brandHashtagsApi
      .list(brandId)
      .then((r) => {
        if (cancelled) return;
        const loaded = r.hashtags.map((h) => h.tag);
        setTags(loaded);
        baselineRef.current = loaded.join(',');
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        onError?.(err instanceof ApiError ? err.message : 'Failed to load hashtags');
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [brandId, onError]);

  useEffect(() => {
    if (!loaded) return;
    const current = tags.join(',');
    if (current === baselineRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await brandHashtagsApi.replace(brandId, tags);
        baselineRef.current = tags.join(',');
      } catch (err) {
        onError?.(err instanceof ApiError ? err.message : 'Failed to save hashtags');
      }
    }, 400);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [tags, loaded, brandId, onError]);

  const normalize = (raw: string): string | null => {
    let t = raw.trim();
    if (t.startsWith('#')) t = t.slice(1);
    t = t.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    if (!t) return null;
    return t.slice(0, 100);
  };

  const commitDraft = () => {
    const pieces = draft.split(/[,\s]+/).map(normalize).filter((t): t is string => !!t);
    if (pieces.length === 0) { setDraft(''); return; }
    setTags((prev) => {
      const next = [...prev];
      for (const t of pieces) {
        if (next.length >= MAX_TAGS) break;
        if (!next.includes(t)) next.push(t);
      }
      return next;
    });
    setDraft('');
  };

  const removeAt = (idx: number) => setTags((prev) => prev.filter((_, i) => i !== idx));
  const atCap = tags.length >= MAX_TAGS;

  return (
    <div className="mt-6 bg-white/40 border border-white/60 rounded-lg px-5 py-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-xs font-medium uppercase tracking-wider text-ink-subtle">
          Brand hashtags
        </h3>
        <span className="text-2xs text-ink-subtle">
          {tags.length}/{MAX_TAGS} <span className="text-ink-subtle">· recommended {RECOMMENDED}</span>
        </span>
      </div>
      <p className="text-xs text-ink-muted mb-3">
        Surfaced as quick-insert chips in the composer toolbar when this brand is active.
        Keep it short — 3 high-quality tags outperform 10 generic ones.
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((t, i) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-accent-subtle text-accent border border-accent/15"
          >
            #{t}
            <button
              onClick={() => removeAt(i)}
              className="p-0.5 rounded-full hover:bg-accent/20"
              aria-label={`Remove #${t}`}
            >
              <X size={10} />
            </button>
          </span>
        ))}

        {!atCap && (
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                commitDraft();
              } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
                setTags((prev) => prev.slice(0, -1));
              }
            }}
            onBlur={commitDraft}
            placeholder={tags.length === 0 ? 'Type a tag and press Enter…' : '+ add hashtag'}
            className="flex-1 min-w-[140px] px-2 py-1 text-xs bg-white/60 border border-dashed border-line rounded-full focus:outline-none focus:border-accent focus:bg-white placeholder:text-ink-subtle"
          />
        )}
      </div>

      {atCap && (
        <p className="text-2xs text-warning mt-2 flex items-center gap-1">
          <AlertCircle size={10} />
          Cap reached ({MAX_TAGS}). Remove a tag to add another.
        </p>
      )}
    </div>
  );
}
