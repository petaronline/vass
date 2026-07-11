'use client';

/**
 * FirstCommentField — small textarea for the post's first comment.
 *
 * Posted automatically by the worker after the main post succeeds.
 * Common use cases: a thank-you, a link the algorithm punishes in the
 * main post body, or call-to-action text.
 *
 * Char limit: 2200 (IG's cap; FB's is higher, so we use the smaller
 * for cross-platform safety). Same auto-resize behavior as the main
 * composer — 2 rows min, 5 rows max.
 */

import { useEffect, useRef } from 'react';
import { MessageCircle } from 'lucide-react';
import { ComposerSection } from './ComposerSection';

interface Props {
  value: string;
  onChange: (v: string) => void;
}

const MIN_ROWS = 2;
const MAX_ROWS = 5;
const LINE_HEIGHT = 20;
const PADDING_Y = 16;
const MIN_H = LINE_HEIGHT * MIN_ROWS + PADDING_Y;
const MAX_H = LINE_HEIGHT * MAX_ROWS + PADDING_Y;
const CHAR_LIMIT = 2200;

export function FirstCommentField({ value, onChange }: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Auto-resize
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.max(MIN_H, Math.min(MAX_H, el.scrollHeight));
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_H ? 'auto' : 'hidden';
  }, [value]);

  const remaining = CHAR_LIMIT - value.length;
  const isOver = remaining < 0;
  const isClose = remaining >= 0 && remaining < 100;

  return (
    <ComposerSection
      icon={MessageCircle}
      label="First comment"
      counter={`${value.length.toLocaleString()} / ${CHAR_LIMIT.toLocaleString()}`}
      counterState={isOver ? 'danger' : isClose ? 'warning' : 'normal'}
      bodyPadding={false}
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Posted automatically as the first comment after publish…"
        style={{ minHeight: MIN_H }}
        className="w-full px-3 py-2 text-sm leading-5 resize-none focus:outline-none placeholder:text-ink-subtle"
      />
    </ComposerSection>
  );
}
