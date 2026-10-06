import type { DbClient } from "@/lib/db/pool";

/**
 * Batched upsert: INSERT ... ON CONFLICT (keyColumns) DO UPDATE SET <non-key columns>.
 * Column names come from code, never from user input; values are parameterised.
 */
export async function upsertRows(
  db: DbClient,
  table: string,
  columns: string[],
  keyColumns: string[],
  rows: unknown[][],
  batchSize = 500,
): Promise<number> {
  if (rows.length === 0) return 0;
  if (!/^[a-z_]+$/.test(table) || columns.some((c) => !/^[a-z_]+$/.test(c))) throw new Error("invalid identifier");
  const updateCols = columns.filter((c) => !keyColumns.includes(c));
  const setClause = updateCols.map((c) => `${c} = excluded.${c}`).join(", ");
  let written = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const params: unknown[] = [];
    const tuples = batch.map((row) => {
      if (row.length !== columns.length) throw new Error("row/column length mismatch");
      const placeholders = row.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    const sql = `insert into public.${table} (${columns.join(", ")}) values ${tuples.join(", ")}
      on conflict (${keyColumns.join(", ")}) do update set ${setClause}`;
    const r = await db.query(sql, params);
    written += r.rowCount ?? 0;
  }
  return written;
}
