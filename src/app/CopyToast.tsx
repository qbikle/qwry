// Small transient pill confirming clipboard writes (see lib/copyCue.ts).
// Non-interactive, never in the overlay stack: pure feedback.
import { useEffect, useRef, useState } from "react";
import "./copytoast.css";

export function CopyToast() {
  const [label, setLabel] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      setLabel((e as CustomEvent<string>).detail);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setLabel(null), 1200);
    };
    window.addEventListener("qwry:copy-cue", on);
    return () => {
      window.removeEventListener("qwry:copy-cue", on);
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);
  if (label === null) return null;
  return (
    <div className={`copy-toast${label === "copy failed" ? " err" : ""}`} role="status">
      {label}
    </div>
  );
}
