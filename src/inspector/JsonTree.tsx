// Collapsible JSON tree with path/value copy. Free, unlike some tools.
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import "./inspector.css";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function Node({
  k,
  value,
  path,
  depth,
}: {
  k: string | null;
  value: Json;
  path: string;
  depth: number;
}) {
  const [open, setOpen] = useState(depth < 2);

  const copyPath = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.altKey) void writeText(path || "$");
    else void writeText(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  };

  const keyEl = k !== null && (
    <span className="jt-key" title={`${path}\nclick value to copy · ⌥-click for path`}>
      {k}:
    </span>
  );

  if (value !== null && typeof value === "object") {
    const isArr = Array.isArray(value);
    const entries = isArr
      ? (value as Json[]).map((v, i) => [String(i), v] as const)
      : Object.entries(value as Record<string, Json>);
    return (
      <div className="jt-node">
        <div className="jt-line" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {keyEl}
          <span className="jt-brace" onClick={copyPath}>
            {isArr ? `[${entries.length}]` : `{${entries.length}}`}
          </span>
        </div>
        {open && (
          <div className="jt-children">
            {entries.map(([ck, cv]) => (
              <Node
                key={ck}
                k={ck}
                value={cv}
                path={isArr ? `${path}[${ck}]` : path ? `${path}.${ck}` : ck}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const cls =
    value === null
      ? "jt-null"
      : typeof value === "string"
        ? "jt-str"
        : typeof value === "number"
          ? "jt-num"
          : "jt-bool";
  return (
    <div className="jt-line jt-leaf">
      <span className="jt-pad" />
      {keyEl}
      <span className={cls} onClick={copyPath} title="click to copy · ⌥-click for path">
        {value === null ? "null" : JSON.stringify(value)}
      </span>
    </div>
  );
}

export function JsonTree({ json }: { json: Json }) {
  return (
    <div className="json-tree">
      <Node k={null} value={json} path="" depth={0} />
    </div>
  );
}
