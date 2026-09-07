export interface AdminEditDiffRow {
  field: string;
  before: string;
  after: string;
}

export function AdminEditDiff({ rows }: { rows: AdminEditDiffRow[] }) {
  if (!rows.length) return null;
  return (
    <section className="admin-edit-diff" aria-label="保存前の変更内容">
      <h3>保存前の変更内容</h3>
      <table>
        <thead>
          <tr>
            <th scope="col">項目</th>
            <th scope="col">現在</th>
            <th scope="col">保存後</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.field}>
              <th scope="row">{row.field}</th>
              <td>{row.before || "未設定"}</td>
              <td>{row.after || "未設定"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
