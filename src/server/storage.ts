import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  Dossier,
  HistoryEntry,
  InvestigationCase,
  WorkspaceBackup,
} from "../shared/model";
import {
  identifier,
  identity,
  now,
  record,
  text,
  validate,
  validateSnapshot,
} from "./validation";
import { migrate } from "./migration";

export class Conflict extends Error {
  constructor(public current: Dossier) {
    super(
      "This dossier changed in another tab. Compare and merge before saving.",
    );
  }
}
export class NotFound extends Error {}
interface DossierRow {
  id: string;
  document: string;
  deleted: number;
}
export class Store {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly backups: string;
  constructor(path: string) {
    this.path = resolve(path);
    this.backups = join(dirname(this.path), "backups");
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=15000;");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS dossiers(id TEXT PRIMARY KEY, document TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)",
    );
    const columns = this.db.prepare("PRAGMA table_info(dossiers)").all();
    if (!columns.some((c) => c.name === "deleted"))
      this.db.exec(
        "ALTER TABLE dossiers ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
      );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS history(dossier_id TEXT, revision INTEGER, document TEXT, action TEXT, time TEXT, PRIMARY KEY(dossier_id,revision)); CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY,name TEXT,objective TEXT)",
    );
    this.db
      .prepare(
        "INSERT INTO cases SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM cases)",
      )
      .run("default", "General research", "");
    const old = this.rows().filter(
      (r) => JSON.parse(r.document).schemaVersion !== 3,
    );
    if (old.length) {
      this.backup("before-migration");
      this.transaction(() => {
        for (const r of old) {
          const d = migrate(JSON.parse(r.document));
          d.id = r.id;
          d.revision = Math.max(1, d.revision);
          validate(d);
          this.db
            .prepare("UPDATE dossiers SET document=? WHERE id=?")
            .run(JSON.stringify(d), r.id);
          this.addHistory(d, "Migrated; legacy archive retained", true);
        }
      });
    }
    mkdirSync(this.backups, { recursive: true });
    if (
      !readdirSync(this.backups).some(
        (f) =>
          f.startsWith(now().slice(0, 10)) && f.endsWith("automatic.sqlite3"),
      )
    )
      this.backup("automatic");
  }
  close(): void {
    this.db.close();
  }
  private rows(): DossierRow[] {
    return this.db
      .prepare("SELECT id,document,deleted FROM dossiers")
      .all() as unknown as DossierRow[];
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private addHistory(d: Dossier, action: string, ignore = false): void {
    this.db
      .prepare(
        `INSERT ${ignore ? "OR IGNORE " : ""}INTO history VALUES(?,?,?,?,?)`,
      )
      .run(d.id, d.revision, JSON.stringify(d), action.slice(0, 200), now());
  }
  backup(label = "manual"): string {
    mkdirSync(this.backups, { recursive: true });
    const target = join(
      this.backups,
      `${now().replace(/:/g, "-")}-${identity().slice(0, 8)}-${label}.sqlite3`,
    );
    // SQLite builds a transaction-consistent compact snapshot, including any WAL pages.
    this.db.prepare("VACUUM INTO ?").run(target);
    return target;
  }
  list(deleted = false): Dossier[] {
    return this.rows()
      .filter((r) => Boolean(r.deleted) === deleted)
      .map((r) => JSON.parse(r.document) as Dossier)
      .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
  }
  cases(): InvestigationCase[] {
    return this.db
      .prepare("SELECT id,name,objective FROM cases ORDER BY name")
      .all() as unknown as InvestigationCase[];
  }
  saveCase(input: unknown): InvestigationCase {
    record(input, "Case");
    const c = {
      id: identifier(input.id || identity(), "Case ID"),
      name: text(input.name, "Case name", true, 200),
      objective: text(input.objective ?? "", "Case objective"),
    };
    this.db
      .prepare(
        "INSERT INTO cases VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,objective=excluded.objective",
      )
      .run(c.id, c.name, c.objective);
    return c;
  }
  save(input: unknown, action = "Saved"): Dossier {
    const d = structuredClone(validate(input));
    text(action, "Change description", false, 200);
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT id,document,deleted FROM dossiers WHERE id=?")
        .get(d.id) as unknown as DossierRow | undefined;
      const previous: Dossier | undefined = row
        ? JSON.parse(row.document)
        : undefined;
      if (previous) {
        const content = (doc: Dossier) =>
          Object.fromEntries(
            Object.entries(doc).filter(
              ([k]) =>
                !["revision", "created", "updated", "action"].includes(k),
            ),
          );
        if (
          !row!.deleted &&
          d.revision <= previous.revision &&
          isDeepStrictEqual(content(d), content(previous))
        )
          return previous;
        if (row!.deleted || d.revision !== previous.revision)
          throw new Conflict(previous);
        d.created = previous.created;
        d.revision = previous.revision + 1;
      } else {
        if (d.revision !== 0)
          throw new TypeError(
            "This dossier no longer exists. Import a saved copy instead of overwriting it.",
          );
        d.created = now();
        d.revision = 1;
      }
      d.updated = now();
      delete d.action;
      if (!this.db.prepare("SELECT 1 FROM cases WHERE id=?").get(d.caseId))
        throw new TypeError("Choose an existing case.");
      const syncCollection = <K extends "entities" | "sources">(
        other: Dossier,
        key: K,
        fields: (keyof Dossier[K][number])[],
      ): boolean => {
        const old = new Map((previous?.[key] ?? []).map((r) => [r.id, r]));
        const changed = new Map(
          d[key]
            .filter(
              (r) =>
                old.has(r.id) &&
                fields.some(
                  (f) =>
                    r[f as keyof typeof r] !==
                    old.get(r.id)![f as keyof typeof r],
                ),
            )
            .map((r) => [r.id, r]),
        );
        const known = new Map(other[key].map((r) => [r.id, r]));
        for (const r of d[key])
          if (!old.has(r.id) && known.has(r.id))
            for (const f of fields)
              Object.assign(r, {
                [f]: known.get(r.id)![f as keyof typeof r] ?? "",
              });
        let touched = false;
        for (const r of other[key]) {
          const replacement = changed.get(r.id);
          if (replacement) {
            for (const f of fields)
              Object.assign(r, { [f]: replacement[f as keyof typeof r] ?? "" });
            touched = true;
          }
        }
        return touched;
      };
      for (const other of this.list()) {
        if (other.id === d.id || other.caseId !== d.caseId) continue;
        const entityChanged = syncCollection(other, "entities", [
          "name",
          "type",
          "aliases",
          "details",
        ]);
        const sourceChanged = syncCollection(other, "sources", [
          "title",
          "publisher",
          "url",
          "published",
          "archiveUrl",
        ]);
        if (entityChanged || sourceChanged) {
          other.type = other.entities.find((e) => e.id === other.subjectId)!
            .type as Dossier["type"];
          validate(other);
          other.revision++;
          other.updated = now();
          this.db
            .prepare("UPDATE dossiers SET document=? WHERE id=?")
            .run(JSON.stringify(other), other.id);
          this.addHistory(other, "Shared record updated through " + d.name);
        }
      }
      validate(d);
      this.db
        .prepare(
          "INSERT INTO dossiers VALUES(?,?,0) ON CONFLICT(id) DO UPDATE SET document=excluded.document",
        )
        .run(d.id, JSON.stringify(d));
      this.addHistory(d, action);
      return d;
    });
  }
  delete(id: string, permanent = false, expected?: number): void {
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT id,document,deleted FROM dossiers WHERE id=?")
        .get(id) as unknown as DossierRow | undefined;
      if (!row) throw new NotFound("Dossier not found.");
      const d = JSON.parse(row.document) as Dossier;
      if (expected !== undefined && expected !== d.revision)
        throw new Conflict(d);
      if (permanent) {
        if (!row.deleted)
          throw new TypeError(
            "Move this dossier to Trash before permanently removing it.",
          );
        this.db.prepare("DELETE FROM history WHERE dossier_id=?").run(id);
        this.db.prepare("DELETE FROM dossiers WHERE id=?").run(id);
      } else {
        if (row.deleted) throw new TypeError("Dossier is already in Trash.");
        d.revision++;
        d.updated = now();
        this.db
          .prepare("UPDATE dossiers SET document=?,deleted=1 WHERE id=?")
          .run(JSON.stringify(d), id);
        this.addHistory(d, "Moved to Trash");
      }
    });
  }
  restore(id: string): Dossier {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT document FROM dossiers WHERE id=? AND deleted=1")
        .get(id);
      if (!row) throw new NotFound("Deleted dossier not found.");
      const d = JSON.parse(row.document as string) as Dossier;
      d.revision++;
      d.updated = now();
      this.db
        .prepare("UPDATE dossiers SET document=?,deleted=0 WHERE id=?")
        .run(JSON.stringify(d), id);
      this.addHistory(d, "Restored from Trash");
      return d;
    });
  }
  history(id: string): HistoryEntry[] {
    return this.db
      .prepare(
        "SELECT revision,action,time,document FROM history WHERE dossier_id=? ORDER BY revision DESC",
      )
      .all(id)
      .map((r) => ({
        revision: r.revision as number,
        action: r.action as string,
        time: r.time as string,
        document: JSON.parse(r.document as string),
      }));
  }
  snapshot(): WorkspaceBackup {
    this.backup();
    return {
      format: "osint-mapper-workspace",
      version: 1,
      created: now(),
      cases: this.cases(),
      dossiers: this.rows().map((r) => ({
        document: JSON.parse(r.document),
        deleted: Boolean(r.deleted),
      })),
      history: this.db
        .prepare("SELECT * FROM history")
        .all()
        .map((r) => ({
          dossierId: r.dossier_id as string,
          revision: r.revision as number,
          document: JSON.parse(r.document as string),
          action: r.action as string,
          time: r.time as string,
        })),
    };
  }
  restoreSnapshot(input: unknown): ReturnType<typeof validateSnapshot> {
    const counts = validateSnapshot(input),
      p = input as WorkspaceBackup;
    this.backup("before-restore");
    this.transaction(() => {
      this.db.exec(
        "DELETE FROM history; DELETE FROM dossiers; DELETE FROM cases;",
      );
      for (const c of p.cases)
        this.db
          .prepare("INSERT INTO cases VALUES(?,?,?)")
          .run(c.id, c.name, c.objective ?? "");
      for (const i of p.dossiers)
        this.db
          .prepare("INSERT INTO dossiers VALUES(?,?,?)")
          .run(i.document.id, JSON.stringify(i.document), Number(i.deleted));
      for (const h of p.history ?? [])
        this.db
          .prepare("INSERT INTO history VALUES(?,?,?,?,?)")
          .run(
            h.dossierId,
            h.revision,
            JSON.stringify(h.document),
            h.action,
            h.time,
          );
    });
    return counts;
  }
}
