'use client';

/**
 * TopicTagField — Threads' single-topic-tag input.
 *
 * Threads attaches one topic tag to the HEAD post of a thread. The tag
 * surfaces in the relevant topic feed and is visually distinct from
 * hashtags in the caption body. Rules (enforced by Meta's API; we
 * validate client-side for friendly UX):
 *
 *   - Max 50 characters
 *   - No leading '#' (Meta strips it; we strip it here too on paste)
 *   - No whitespace, periods, or ampersands
 *
 * The field is only mounted by ComposerModal when at least one Threads
 * target is selected.
 */

import { Hash, AlertCircle } from 'lucide-react';
import { useMemo } from 'react';
import { ComposerSection } from './ComposerSection';

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Max length per Threads docs. */
  maxLength?: number;
  /** Optional pill rendered inline-left of the input. Used to mark
   *  this field as Threads-only when other platforms are also in the
   *  target set. */
  badge?: React.ReactNode;
}

const TOPIC_MAX_DEFAULT = 50;
const FORBIDDEN_CHARS_RE = /[\s.&#]/;

export function TopicTagField({ value, onChange, maxLength = TOPIC_MAX_DEFAULT, badge }: Props) {
  const validation = useMemo(() => {
    if (value.length === 0) return null;
    if (FORBIDDEN_CHARS_RE.test(value)) {
      return 'No spaces, periods, ampersands, or # allowed';
    }
    return null;
  }, [value]);

  return (
    <ComposerSection
      icon={Hash}
      label="Topic tag"
      counter={`${value.length.toLocaleString()} / ${maxLength.toLocaleString()}`}
      counterState={value.length > maxLength ? 'danger' : 'normal'}
      bodyPadding={false}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        {badge && <span className="shrink-0">{badge}</span>}
        <input
          id="topic-tag"
          type="text"
          value={value}
          onChange={(e) => {
            // Strip a leading '#' since Meta doesn't want it. Easier to
            // do quietly than reject — most users will paste #thing
            // out of habit.
            let v = e.target.value;
            if (v.startsWith('#')) v = v.slice(1);
            onChange(v);
          }}
          maxLength={maxLength + 10 /* allow over so we can show invalid */}
          placeholder="e.g. ai, productdesign, marathontraining"
          className={[
            'flex-1 min-w-0 text-sm bg-transparent',
            'placeholder-ink-subtle focus:outline-none',
            validation ? 'text-danger' : 'text-ink',
          ].join(' ')}
        />
      </div>
      {validation && (
        <div className="px-3 pb-2 -mt-1">
          <p className="text-2xs text-danger flex items-center gap-1">
            <AlertCircle size={10} />
            {validation}
          </p>
        </div>
      )}
    </ComposerSection>
  );
}
