'use client';

/**
 * ComposerToolbar — sits below the composer textarea.
 *
 * Patch 4.29 changes:
 *   - Hashtag button is now a dropdown when brand hashtags are configured.
 *     Lists individual tags + "Insert all". Falls back to bare "insert #"
 *     when the active brand has no presets.
 *   - Hashtag insert no longer prefixes a space — caller passes the full
 *     string (e.g. " #foo #bar") so we can support multi-insert cleanly.
 */
import { useState, useRef, useEffect } from 'react';
import { Smile, Hash, AlertCircle, Sparkles } from 'lucide-react';

/** Curated emoji grid — common social-media set, no full Unicode dump. */
const EMOJI_GRID = [
  '😀','😁','😂','🤣','😊','😍','🥰','😘','😎','🤩',
  '😋','🤗','🤔','🙄','😏','🤨','😴','😢','😭','😤',
  '😡','🤯','🥳','🤝','👏','🙌','👋','👌','🤞','✌️',
  '🤘','💪','🙏','❤️','🧡','💛','💚','💙','💜','🖤',
  '🤍','🤎','💔','💖','💯','✨','⭐','🌟','💫','🔥',
  '🎉','🎊','🎁','🎂','🏆','🥇','🚀','💎','💰','💸',
  '👀','💭','💬','📣','📢','📌','📍','🔗','📷','📸',
  '☀️','🌙','⚡','🌈','☕','🍻','🍷','🍕','🍔','🍰',
];

interface Props {
  body: string;
  limit: number;
  onInsertEmoji: (emoji: string) => void;
  /** Insert raw text at cursor. Called with the formatted string the
   *  user picked (e.g. " #foo", " #foo #bar #baz"). */
  onInsertText: (text: string) => void;
  /** Hashtags pre-fetched for the active brand. Empty = no brand or
   *  no tags configured; button falls back to single-# behavior. */
  brandHashtags: string[];
}

export function ComposerToolbar({
  body,
  limit,
  onInsertEmoji,
  onInsertText,
  brandHashtags,
}: Props) {
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [hashtagOpen, setHashtagOpen] = useState(false);
  const [emojiPos, setEmojiPos] = useState<{ left: number; bottom: number } | null>(null);
  const [hashtagPos, setHashtagPos] = useState<{ left: number; bottom: number } | null>(null);

  const emojiBtnRef = useRef<HTMLButtonElement>(null);
  const hashtagBtnRef = useRef<HTMLButtonElement>(null);
  const emojiPopRef = useRef<HTMLDivElement>(null);
  const hashtagPopRef = useRef<HTMLDivElement>(null);

  // Anchoring helper for fixed-position popovers
  const computePos = (btn: HTMLButtonElement | null) => {
    if (!btn) return null;
    const rect = btn.getBoundingClientRect();
    return {
      left: rect.left,
      bottom: window.innerHeight - rect.top + 8,
    };
  };

  // Emoji popover positioning
  useEffect(() => {
    if (!emojiOpen) return;
    const recompute = () => setEmojiPos(computePos(emojiBtnRef.current));
    recompute();
    window.addEventListener('resize', recompute);
    window.addEventListener('scroll', recompute, true);
    return () => {
      window.removeEventListener('resize', recompute);
      window.removeEventListener('scroll', recompute, true);
    };
  }, [emojiOpen]);

  // Hashtag popover positioning
  useEffect(() => {
    if (!hashtagOpen) return;
    const recompute = () => setHashtagPos(computePos(hashtagBtnRef.current));
    recompute();
    window.addEventListener('resize', recompute);
    window.addEventListener('scroll', recompute, true);
    return () => {
      window.removeEventListener('resize', recompute);
      window.removeEventListener('scroll', recompute, true);
    };
  }, [hashtagOpen]);

  // Close on outside click — handles both popovers
  useEffect(() => {
    if (!emojiOpen && !hashtagOpen) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (emojiOpen &&
          emojiPopRef.current && !emojiPopRef.current.contains(target) &&
          emojiBtnRef.current && !emojiBtnRef.current.contains(target)) {
        setEmojiOpen(false);
      }
      if (hashtagOpen &&
          hashtagPopRef.current && !hashtagPopRef.current.contains(target) &&
          hashtagBtnRef.current && !hashtagBtnRef.current.contains(target)) {
        setHashtagOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [emojiOpen, hashtagOpen]);

  const remaining = limit - body.length;
  const isOver = remaining < 0;
  const isClose = remaining >= 0 && remaining < 20;

  const handleHashtagClick = () => {
    if (brandHashtags.length === 0) {
      // No presets — insert a bare '#' so users can type a tag
      onInsertText(' #');
      return;
    }
    setHashtagOpen((v) => !v);
  };

  const insertOne = (tag: string) => {
    onInsertText(` #${tag}`);
    setHashtagOpen(false);
  };
  const insertAll = () => {
    const joined = brandHashtags.map((t) => `#${t}`).join(' ');
    // Ensure a leading space so we don't run into existing body text
    onInsertText(' ' + joined);
    setHashtagOpen(false);
  };

  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-line bg-surface-alt/50">
      <div className="flex items-center gap-1">
        {/* Emoji */}
        <button
          ref={emojiBtnRef}
          type="button"
          onClick={() => { setEmojiOpen((v) => !v); setHashtagOpen(false); }}
          className={[
            'p-1.5 rounded-lg transition-colors',
            emojiOpen ? 'text-ink bg-white/80' : 'text-ink-muted hover:text-ink hover:bg-white/55',
          ].join(' ')}
          title="Insert emoji"
        >
          <Smile size={16} strokeWidth={2} />
        </button>

        {/* Hashtag */}
        <button
          ref={hashtagBtnRef}
          type="button"
          onClick={() => { handleHashtagClick(); setEmojiOpen(false); }}
          className={[
            'p-1.5 rounded-lg transition-colors relative',
            hashtagOpen ? 'text-ink bg-white/80' : 'text-ink-muted hover:text-ink hover:bg-white/55',
          ].join(' ')}
          title={brandHashtags.length > 0 ? `${brandHashtags.length} brand hashtag${brandHashtags.length === 1 ? '' : 's'}` : 'Insert hashtag'}
        >
          <Hash size={16} strokeWidth={2} />
          {brandHashtags.length > 0 && (
            <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-accent text-white text-[9px] font-semibold flex items-center justify-center">
              {brandHashtags.length}
            </span>
          )}
        </button>
      </div>

      {/* Counter */}
      <div className="flex items-center gap-1.5 text-2xs">
        {isOver && <AlertCircle size={11} className="text-danger" />}
        <span
          className={[
            'text-2xs font-mono tabular-nums',
            isOver ? 'text-danger font-semibold' : isClose ? 'text-warning' : 'text-ink-subtle',
          ].join(' ')}
        >
          {body.length.toLocaleString()} / {limit.toLocaleString()}
        </span>
      </div>

      {/* Emoji popover */}
      {emojiOpen && emojiPos && (
        <div
          ref={emojiPopRef}
          style={{ position: 'fixed', left: `${emojiPos.left}px`, bottom: `${emojiPos.bottom}px`, zIndex: 70 }}
          className="bg-white border border-line rounded-lg shadow-lift w-[340px] animate-fade-in"
        >
          <div className="px-3 py-2 border-b border-line flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-ink-subtle">Emoji</span>
            <span className="text-2xs text-ink-subtle">{EMOJI_GRID.length} available</span>
          </div>
          <div className="p-2 max-h-[300px] overflow-y-auto">
            <div className="grid grid-cols-10 gap-0.5">
              {EMOJI_GRID.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => { onInsertEmoji(e); setEmojiOpen(false); }}
                  className="w-8 h-8 flex items-center justify-center text-lg rounded hover:bg-surface-hover transition-colors"
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Hashtag popover */}
      {hashtagOpen && hashtagPos && brandHashtags.length > 0 && (
        <div
          ref={hashtagPopRef}
          style={{ position: 'fixed', left: `${hashtagPos.left}px`, bottom: `${hashtagPos.bottom}px`, zIndex: 70 }}
          className="bg-white border border-line rounded-lg shadow-lift w-[280px] animate-fade-in"
        >
          <div className="px-3 py-2 border-b border-line flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-ink-subtle">Brand hashtags</span>
            <span className="text-2xs text-ink-subtle">{brandHashtags.length}</span>
          </div>
          <button
            type="button"
            onClick={insertAll}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm font-medium text-accent hover:bg-accent-subtle transition-colors border-b border-line"
          >
            <Sparkles size={13} />
            Insert all
          </button>
          <div className="max-h-[240px] overflow-y-auto py-1">
            {brandHashtags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => insertOne(tag)}
                className="w-full text-left px-3 py-1.5 text-sm text-ink hover:bg-surface-hover transition-colors"
              >
                #{tag}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
