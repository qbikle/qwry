import { useConnections } from "../stores/connections";
import { useSchema, type TableInfo } from "../stores/schema";
import "./browser.css";

export function StructureTab({ table }: { table: TableInfo }) {
  const activeProfileId = useConnections((s) => s.activeProfileId);
  const snapshot = useSchema((s) =>
    activeProfileId ? s.snapshots[activeProfileId] : undefined,
  );

  const fks =
    snapshot?.foreign_keys.filter(
      (fk) =>
        (fk.src_schema === table.schema && fk.src_table === table.name) ||
        (fk.dst_schema === table.schema && fk.dst_table === table.name),
    ) ?? [];
  const indexes =
    snapshot?.indexes.filter(
      (ix) => ix.schema === table.schema && ix.table === table.name,
    ) ?? [];

  return (
    <div className="tb-structure">
      <h3>Columns</h3>
      <table className="st-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Name</th>
            <th>Type</th>
            <th>Nullable</th>
            <th>Default</th>
          </tr>
        </thead>
        <tbody>
          {table.columns.map((c) => (
            <tr key={c.name}>
              <td className="st-num">{c.attnum}</td>
              <td className="st-name">
                {c.name}
                {table.pk.includes(c.name) && <span className="st-pk">PK</span>}
              </td>
              <td className="st-type">{c.type}</td>
              <td>{c.not_null ? "not null" : "null"}</td>
              <td className="st-default">{c.default ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {fks.length > 0 && (
        <>
          <h3>Foreign keys</h3>
          <table className="st-table">
            <tbody>
              {fks.map((fk, i) => (
                <tr key={i}>
                  <td className="st-name">
                    {fk.src_table}({fk.src_cols.join(", ")})
                  </td>
                  <td>→</td>
                  <td className="st-name">
                    {fk.dst_table}({fk.dst_cols.join(", ")})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>Indexes</h3>
      {indexes.length === 0 ? (
        <div className="st-none">No indexes</div>
      ) : (
        <table className="st-table">
          <tbody>
            {indexes.map((ix) => (
              <tr key={ix.name}>
                <td className="st-name">{ix.name}</td>
                <td className="st-def">{ix.def.replace(/^CREATE\s+/i, "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
