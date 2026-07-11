'use client';

/**
 * ComposerSection — the ONE shared shell for every section in the composer
 * (First comment, Topic tag, Reply chain, Collaborators, TikTok options, …).
 *
 * Sections stay separate components with their own content; they all wrap it
 * in this shell so the LOOK is identical: same white card, same rounded-lg
 * border, same header row (icon + uppercase label + optional right-aligned
 * counter), same padding. Content goes in `children`.
 */
import { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

interface Props {
  icon: LucideIcon;
  label: string;
  /** Optional right-aligned counter, e.g. "0 / 500". Already-formatted text. */
  counter?: ReactNode;
  /** Counter state for color. */
  counterState?: 'normal' | 'warning' | 'danger';
  /** Whether the content area gets default padding. Set false when the child
   *  is a textarea/input that manages its own padding. */
  bodyPadding?: boolean;
  children: ReactNode;
}

export function ComposerSection({
  icon: Icon,
  label,
  counter,
  counterState = 'normal',
  bodyPadding = true,
  children,
}: Props) {
  const counterColor =
    counterState === 'danger'
      ? 'text-danger font-semibold'
      : counterState === 'warning'
      ? 'text-warning'
      : 'text-ink-subtle';

  return (
    <div className="flex flex-col bg-white rounded-lg border border-line overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-line bg-surface-alt/40">
        <Icon size={12} className="text-ink-subtle" />
        <span className="text-xs font-medium uppercase tracking-wider text-ink-subtle flex-1">
          {label}
        </span>
        {counter != null && (
          <span className={['text-2xs font-mono tabular-nums', counterColor].join(' ')}>
            {counter}
          </span>
        )}
      </div>
      <div className={bodyPadding ? 'p-3' : ''}>{children}</div>
    </div>
  );
}
