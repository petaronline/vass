'use client';

// Small (?) help icon with a hover/focus tooltip. Used to move long
// inline help text out of settings sections (Patch 4.47.0) so the page
// stays clean — the guidance is one hover away instead of a wall of text.
import { useState, useRef, useId, ReactNode } from 'react';
import { HelpCircle } from 'lucide-react';

interface Props {
  /** Tooltip content. Plain text or rich nodes. */
  children: ReactNode;
  /** Accessible label for the trigger. Defaults to "More info". */
  label?: string;
}

export function HelpTip({ children, label = 'More info' }: Props) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const show = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  // Small delay so moving the cursor from icon to tooltip doesn't dismiss it.
  const hide = () => {
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };

  return (
    <span className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => setOpen((v) => !v)}
        className="text-ink-subtle hover:text-ink transition-colors focus:outline-none focus-visible:text-accent"
      >
        <HelpCircle size={14} strokeWidth={2} />
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          onMouseEnter={show}
          onMouseLeave={hide}
          className="absolute left-1/2 top-full z-50 mt-2 w-72 -translate-x-1/2 rounded-lg border border-line bg-white px-3.5 py-3 text-xs leading-relaxed text-ink shadow-lg"
        >
          {children}
        </span>
      )}
    </span>
  );
}
