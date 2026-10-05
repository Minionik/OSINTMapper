/** Verify database preservation against a nominated pre-release SQLite snapshot. */
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { validate } from "../src/server/validation";
const backup = process.argv[2];
if (!backup) throw Error("Pass the path to the pre-release SQLite backup.");
const previous = new DatabaseSync(backup, { readOnly: true }),
  current = new DatabaseSync(
    process.env.OSINT_MAPPER_DB ?? "data/mapper.sqlite3",
    { readOnly: true },
  );
try {
  for (const [table, order] of [
    ["dossiers", "id"],
    ["cases", "id"],
    ["history", "dossier_id,revision"],
  ]) {
    if (
      !isDeepStrictEqual(
        previous.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all(),
        current.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all(),
      )
    )
      throw Error(`Preservation check failed for ${table}.`);
  }
  const rows = current.prepare("SELECT document FROM dossiers").all();
  for (const row of rows) validate(JSON.parse(row.document as string));
  if (current.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
    throw Error("SQLite integrity check failed.");
  console.log(
    `Verified ${rows.length} unchanged dossiers, all cases, full history, and SQLite integrity.`,
  );
} finally {
  previous.close();
  current.close();
}
