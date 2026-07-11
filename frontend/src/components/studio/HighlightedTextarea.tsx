'use client';

/**
 * HighlightedTextarea — textarea with inline blue token highlighting.
 *
 * Why this exists: a plain <textarea> only supports a single text color.
 * Editors like Twitter/Slack/Sprout show hashtags, mentions, and URLs in
 * a distinct color while you type, which requires either contenteditable
 * (fragile UX) or this trick:
 *
 *   - A transparent textarea on top captures keystrokes / selection
 *   - A read-only <div> mirrors the text, with tokens wrapped in <span>
 *   - Both share the same font/padding/line-height so the styled text
 *     sits exactly under the textarea glyphs
 *   - Scroll position syncs between the two
 *
 * The textarea must keep its own color transparent and a visible caret;
 * the mirror handles ALL visual rendering. We preserve user newlines
 * and trailing whitespace (with `whiteSpace: 'pre-wrap'` and a trailing
 * space marker so the mirror's wrap matches the textarea's).
 *
 * Token patterns:
 *   - #hashtag      : # followed by [a-z0-9_] (case-insensitive)
 *   - @mention      : @ followed by [a-z0-9._-]
 *   - http(s)://url : standard URL prefix
 *
 * Auto-resizes the same way the previous AutoResizeTextarea did —
 * 3 rows min, 8 rows max, scrolls beyond.
 */

import { useEffect, useRef } from 'react';

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Imperative ref handle for the inner textarea (so the composer can
   *  manipulate the cursor for emoji/hashtag insertion). */
  refCallback?: (el: HTMLTextAreaElement | null) => void;
}

/** Patterns ordered by priority — first match wins per character span.
 *  URL is greediest so it goes first; mentions before hashtags because
 *  email-like "@foo.com" gets the @ part and the rest stays plain. */
const TOKEN_RE = /(https?:\/\/[^\s]+|@[\w.\-]+|#[\w]+)/g;

const MIN_ROWS = 5;
const MAX_ROWS = 10;
const LINE_HEIGHT = 24;
const PADDING_Y = 24; // 12px top + 12px bottom from px-4 py-3
const MIN_H = LINE_HEIGHT * MIN_ROWS + PADDING_Y;
const MAX_H = LINE_HEIGHT * MAX_ROWS + PADDING_Y;

export function HighlightedTextarea({ value, onChange, placeholder, refCallback }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);

  // Auto-resize: recompute height on every value change. Set both the
  // textarea and the mirror so they stay matched.
  useEffect(() => {
    const ta = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!ta) return;

    ta.style.height = 'auto';
    const next = Math.max(MIN_H, Math.min(MAX_H, ta.scrollHeight));
    ta.style.height = `${next}px`;
    ta.style.overflowY = ta.scrollHeight > MAX_H ? 'auto' : 'hidden';

    if (mirror) {
      mirror.style.height = `${next}px`;
    }
  }, [value]);

  // Keep the mirror's scroll position in sync with the textarea.
  // When the textarea overflows past MAX_H, the user scrolls it; we
  // mirror that so the styled spans don't drift out of alignment.
  const handleScroll = () => {
    if (textareaRef.current && mirrorRef.current) {
      mirrorRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  // Render the value as a series of text + token spans for the mirror.
  // We append a trailing space marker so the mirror wraps identically
  // when the textarea ends with a newline (otherwise the last empty
  // line wouldn't take height in the mirror but does in the textarea).
  const renderMirror = (raw: string) => {
    if (!raw) {
      // Show placeholder color in mirror as well so the visible text
      // matches the textarea's placeholder treatment.
      return null;
    }
    const parts: Array<{ text: string; token: boolean }> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    // Reset lastIndex because TOKEN_RE has /g flag
    TOKEN_RE.lastIndex = 0;
    while ((match = TOKEN_RE.exec(raw)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ text: raw.slice(lastIndex, match.index), token: false });
      }
      parts.push({ text: match[0], token: true });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < raw.length) {
      parts.push({ text: raw.slice(lastIndex), token: false });
    }

    // The trailing-newline trick: if the final character is a newline,
    // append a non-breaking space so the line takes height in the
    // mirror DIV (browsers collapse trailing \n in normal divs).
    return (
      <>
        {parts.map((p, i) =>
          p.token ? (
            <span key={i} className="text-[#1d4ed8]">{p.text}</span>
          ) : (
            <span key={i}>{p.text}</span>
          )
        )}
        {raw.endsWith('\n') && '\u00A0'}
      </>
    );
  };

  // Shared text styling between textarea + mirror. Critical for alignment:
  // identical font, line-height, padding, and word-wrap behavior.
  const sharedTextStyle = 'px-4 py-3 text-[15px] leading-6 font-sans tracking-normal';

  return (
    <div className="relative w-full">
      {/* Mirror — sits behind the textarea, renders styled tokens.
          Pointer-events disabled so all interaction goes to the real
          textarea on top. */}
      <div
        ref={mirrorRef}
        aria-hidden
        className={[
          sharedTextStyle,
          'absolute inset-0 w-full overflow-hidden pointer-events-none whitespace-pre-wrap break-words',
          // Text color matches the host ink color; tokens override to blue inline
          'text-ink',
        ].join(' ')}
        style={{ minHeight: MIN_H, wordBreak: 'break-word' }}
      >
        {value ? renderMirror(value) : null}
      </div>

      {/* Real textarea — transparent text so only the mirror is visible.
          We keep the caret color so the user sees where they're typing. */}
      <textarea
        ref={(el) => {
          textareaRef.current = el;
          if (refCallback) refCallback(el);
        }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={handleScroll}
        placeholder={placeholder}
        spellCheck
        className={[
          sharedTextStyle,
          'relative w-full resize-none focus:outline-none placeholder:text-ink-subtle',
          // Make the typed text invisible — the mirror renders it. The
          // caret stays visible via caret-color, and selected text uses
          // a tinted background so users can still see selections.
          'text-transparent caret-ink',
          'selection:bg-accent/20 selection:text-transparent',
          'bg-transparent',
        ].join(' ')}
        style={{ minHeight: MIN_H }}
      />
    </div>
  );
}
