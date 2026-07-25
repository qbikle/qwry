// macOS-style switch (DESIGN.md rule 1 species). A real checkbox wears the
// costume: role=switch, Space toggles, wrapping labels associate clicks.
// Visual states live in tokens.css and derive from the input via :has().
export function Switch({
  checked,
  onChange,
  disabled,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <span className="switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-knob" aria-hidden="true" />
    </span>
  );
}
