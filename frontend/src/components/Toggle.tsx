/**
 * Toggle — Vass's standard on/off switch.
 *
 * Used wherever a boolean setting is exposed in the UI (settings pages,
 * launch builder, ad account enable/disable, etc.). Visual: rounded pill,
 * filled with accent color when on, neutral line color when off.
 *
 * Two sizes:
 *   - "md" (default): 24x44px — used for prominent settings cards
 *   - "sm": 20x36px — used in dense table rows
 *
 * Accessibility: rendered as a button with role="switch" and aria-checked.
 */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
  size = 'md',
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** Optional aria-label for screen readers when not next to descriptive text. */
  label?: string;
  size?: 'sm' | 'md';
}) {
  const dims =
    size === 'sm'
      ? {
          track: 'h-5 w-9',
          knob: 'h-3.5 w-3.5',
          on: 'translate-x-[18px]',
          off: 'translate-x-1',
        }
      : {
          track: 'h-6 w-11',
          knob: 'h-5 w-5',
          on: 'translate-x-[22px]',
          off: 'translate-x-[2px]',
        };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        'relative inline-flex shrink-0 items-center rounded-full transition-colors',
        dims.track,
        checked ? 'bg-accent' : 'bg-line-strong',
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block transform rounded-full bg-white shadow-subtle transition',
          dims.knob,
          checked ? dims.on : dims.off,
        ].join(' ')}
      />
    </button>
  );
}
