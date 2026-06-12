import { X } from "lucide-react";
import { useExplain, type PlanNode } from "../stores/explain";
import "./explain.css";

function Node({ node, total, depth }: { node: PlanNode; total: number; depth: number }) {
  const selfPct = total > 0 ? (node.selfMs / total) * 100 : 0;
  const hot = selfPct >= 20;
  const warm = selfPct >= 5 && selfPct < 20;
  const misestimate =
    node.planRows > 0 &&
    node.actualRows > 0 &&
    (node.actualRows / node.planRows >= 100 || node.planRows / node.actualRows >= 100);

  return (
    <>
      <div className={`ex-row${hot ? " hot" : warm ? " warm" : ""}`}>
        <div className="ex-label" style={{ paddingLeft: depth * 18 }}>
          <span className="ex-type">{node.type}</span>
          {node.relation && <span className="ex-rel">on {node.relation}</span>}
          {node.index && <span className="ex-rel">using {node.index}</span>}
          {node.loops > 1 && <span className="ex-loops">×{node.loops}</span>}
          {misestimate && (
            <span
              className="ex-mis"
              title={`planner estimated ${node.planRows.toLocaleString()} rows, got ${node.actualRows.toLocaleString()}`}
            >
              est ⚠
            </span>
          )}
        </div>
        <div className="ex-rows" title="actual rows (plan rows)">
          {node.actualRows.toLocaleString()}
          <span className="ex-plan-rows"> ({node.planRows.toLocaleString()})</span>
        </div>
        <div className="ex-bar-wrap">
          <div
            className="ex-bar"
            style={{ width: `${Math.max(0.5, selfPct)}%` }}
            title={`self ${node.selfMs.toFixed(2)}ms of ${total.toFixed(2)}ms`}
          />
        </div>
        <div className="ex-ms">{node.selfMs.toFixed(1)}ms</div>
      </div>
      {node.children.map((c, i) => (
        <Node key={i} node={c} total={total} depth={depth + 1} />
      ))}
    </>
  );
}

export function ExplainView() {
  const root = useExplain((s) => s.root);
  const running = useExplain((s) => s.running);
  const error = useExplain((s) => s.error);
  const executionMs = useExplain((s) => s.executionMs);
  const planningMs = useExplain((s) => s.planningMs);
  const close = useExplain((s) => s.close);

  return (
    <div className="explain-view">
      <div className="ex-header">
        <span className="ex-title">EXPLAIN ANALYZE</span>
        {root && (
          <span className="ex-summary">
            execution {executionMs.toFixed(1)}ms · planning {planningMs.toFixed(1)}ms
          </span>
        )}
        <button className="icon-btn" title="Close (esc)" onClick={close}>
          <X size={14} />
        </button>
      </div>

      {running && <div className="ex-msg">Analyzing…</div>}
      {error && <div className="ex-error">{error}</div>}
      {root && (
        <div className="ex-tree">
          <div className="ex-row ex-head">
            <div className="ex-label">node</div>
            <div className="ex-rows">rows (est)</div>
            <div className="ex-bar-wrap">self time</div>
            <div className="ex-ms" />
          </div>
          <Node node={root} total={executionMs} depth={0} />
        </div>
      )}
    </div>
  );
}
