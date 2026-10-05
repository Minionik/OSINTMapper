import { cleanTestWorkspace } from "./temp-workspace";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { startupMessage } from "../scripts/startup-errors";
import { DatabaseSync } from "node:sqlite";
import type { Dossier, Source, Assertion } from "../src/shared/model";
import { Store, Conflict } from "../src/server/storage";
import { createApp } from "../src/server/app";
import { migrate, previewImport } from "../src/server/migration";
import { validate, stable, validDate } from "../src/server/validation";
const doc = (
  id = "test-dossier",
  type: Dossier["type"] = "person",
  name = "Example Person",
): Dossier => ({
  schemaVersion: 3,
  id,
  revision: 0,
  name,
  type,
  caseId: "default",
  subjectId: id + "-subject",
  entities: [
    {
      id: id + "-subject",
      name,
      type,
      aliases: "",
      details: "",
      dossierId: id,
    },
  ],
  assertions: [],
  sources: [],
  tasks: [],
  notes: "",
  summary: "",
  conclusionIds: [],
  modules: [],
  warnings: [],
  legacy: {},
});
const source = (
  id = "source-1",
  ref = "S01",
  url = "https://example.com/evidence",
): Source => ({
  id,
  ref,
  title: "Original record",
  publisher: "Example publisher",
  url,
  published: "2026-09",
  accessed: "2026-10-04",
  archiveUrl: "",
  quality: "high",
  notes: "private source notes",
});
const fact = (d: Dossier, changes: Partial<Assertion> = {}): Assertion => ({
  id: "fact-1",
  kind: "fact",
  entityId: d.subjectId,
  label: "Recorded fact",
  value: "Example fact",
  category: "General",
  knowledge: "known",
  classification: "UNVERIFIED",
  verification: "unreviewed",
  sourceIds: [],
  evidence: "",
  justification: "",
  collected: "2026-10-04",
  eventDate: "2025",
  publicationDate: "",
  internal: false,
  ...changes,
});
function fixture(): { directory: string; store: Store; close: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "osint-ts-test-")),
    store = new Store(join(directory, "mapper.sqlite3"));
  return {
    directory,
    store,
    close: () => {
      store.close();
      cleanTestWorkspace(directory);
    },
  };
}
test("create retry is idempotent and saved history records the change", () => {
  const f = fixture();
  try {
    const first = f.store.save(doc());
    assert.deepEqual(f.store.save(doc()), first);
    assert.equal(f.store.history(first.id).length, 1);
    first.notes = "new evidence";
    assert.equal(f.store.save(first, "Changed notes").revision, 2);
    assert.equal(f.store.history(first.id)[0].action, "Changed notes");
  } finally {
    f.close();
  }
});
test("stale tabs cannot overwrite newer work", () => {
  const f = fixture();
  try {
    const first = f.store.save(doc()),
      stale = structuredClone(first);
    first.notes = "tab A";
    f.store.save(first);
    stale.notes = "tab B";
    assert.throws(
      () => f.store.save(stale),
      (e: unknown) => e instanceof Conflict && e.current.notes === "tab A",
    );
    assert.equal(f.store.list()[0].notes, "tab A");
  } finally {
    f.close();
  }
});
test("two independent SQLite connections give one revision winner", () => {
  const f = fixture(),
    other = new Store(f.store.path);
  try {
    const first = f.store.save(doc()),
      stale = structuredClone(first);
    first.notes = "A";
    stale.notes = "B";
    f.store.save(first);
    assert.throws(() => other.save(stale), Conflict);
    assert.equal(other.list()[0].notes, "A");
  } finally {
    other.close();
    f.close();
  }
});
test("restoring a history snapshot creates a new revision", () => {
  const f = fixture();
  try {
    let d = f.store.save(doc());
    d.notes = "wrong";
    d = f.store.save(d);
    const old = f.store.history(d.id).at(-1)!.document;
    old.revision = d.revision;
    const restored = f.store.save(old, "Restored revision 1");
    assert.equal(restored.notes, "");
    assert.equal(restored.revision, 3);
    assert.equal(f.store.history(d.id).length, 3);
  } finally {
    f.close();
  }
});
test("trash, restore and deliberate permanent removal preserve revision semantics", () => {
  const f = fixture();
  try {
    let d = f.store.save(doc());
    assert.throws(() => f.store.delete(d.id, true));
    f.store.delete(d.id, false, 1);
    assert.equal(f.store.list().length, 0);
    assert.equal(f.store.list(true)[0].revision, 2);
    d = f.store.restore(d.id);
    assert.equal(d.revision, 3);
    f.store.delete(d.id, false, 3);
    f.store.delete(d.id, true);
    assert.equal(f.store.history(d.id).length, 0);
    assert.equal(f.store.list(true).length, 0);
  } finally {
    f.close();
  }
});
test("workspace backup roundtrips live records, trash and full history", () => {
  const f = fixture(),
    other = new Store(join(f.directory, "restored.sqlite3"));
  try {
    const d = f.store.save(doc());
    d.notes = "retain history";
    f.store.save(d);
    f.store.save(doc("org", "organization", "Example Ltd"));
    f.store.delete("org");
    const backup = f.store.snapshot();
    assert.deepEqual(other.restoreSnapshot(backup), {
      dossiers: 2,
      cases: 1,
      trash: 1,
    });
    assert.deepEqual(other.snapshot().dossiers, backup.dossiers);
    assert.equal(other.history(d.id).length, 2);
    assert(
      readdirSync(other.backups).some((f) =>
        f.endsWith("before-restore.sqlite3"),
      ),
    );
  } finally {
    other.close();
    f.close();
  }
});
test("invalid backup is rejected before any workspace mutation", () => {
  const f = fixture();
  try {
    f.store.save(doc());
    const p = f.store.snapshot();
    p.dossiers[0].document.assertions = [
      fact(doc(), { sourceIds: ["missing"] }),
    ];
    assert.throws(() => f.store.restoreSnapshot(p));
    assert.equal(f.store.list().length, 1);
  } finally {
    f.close();
  }
});
test("shared case metadata updates revisions atomically but leaves local source assessments", () => {
  const f = fixture();
  try {
    let first = doc("first");
    first.sources = [source()];
    first = f.store.save(first);
    let other = doc("other");
    other.sources = [source("source-1", "LOCAL")];
    other.sources[0].notes = "Local analysis";
    other.entities.push(structuredClone(first.entities[0]));
    other = f.store.save(other);
    const stale = structuredClone(other);
    first.sources[0].title = "Corrected title";
    first.entities[0].name = "Verified identity name";
    f.store.save(first);
    const current = f.store.list().find((d) => d.id === "other")!;
    assert.equal(current.sources[0].title, "Corrected title");
    assert.equal(current.sources[0].ref, "LOCAL");
    assert.equal(current.sources[0].notes, "Local analysis");
    assert.equal(current.entities[1].name, "Verified identity name");
    assert.equal(current.revision, 2);
    stale.notes = "stale";
    assert.throws(() => f.store.save(stale), Conflict);
    assert.equal(f.store.history("other").length, 2);
  } finally {
    f.close();
  }
});
test("shared record validation rolls back all affected dossiers on failure", () => {
  const f = fixture();
  try {
    let first = doc("first");
    first.sources = [source()];
    first = f.store.save(first);
    const other = doc("other");
    other.sources = [
      source("source-1", "LOCAL"),
      source("second", "S02", "https://example.com/second"),
    ];
    f.store.save(other);
    first.sources[0].url = "https://example.com/second";
    assert.throws(() => f.store.save(first));
    assert.equal(f.store.list().find((d) => d.id === "first")!.revision, 1);
    assert.equal(f.store.list().find((d) => d.id === "other")!.revision, 1);
  } finally {
    f.close();
  }
});
test("legacy migration preserves the original archive and distinct namesakes", () => {
  const f = fixture();
  const old = {
    schemaVersion: 2,
    id: "legacy",
    type: "person",
    name: "Person",
    notes: "keep me",
    findings: [],
    templateData: {
      connections: [
        { From: "Person", To: "Alex", Relationship: "knows" },
        { From: "Person", To: "Alex", Relationship: "works with" },
      ],
    },
  };
  try {
    f.store.db
      .prepare("INSERT INTO dossiers VALUES(?,?,0)")
      .run("legacy", JSON.stringify(old));
    f.store.close();
    const migrated = new Store(f.store.path);
    try {
      const d = migrated.list()[0];
      validate(d);
      assert.deepEqual(d.legacy, old);
      assert.notEqual(d.assertions[0].toId, d.assertions[1].toId);
      assert(
        readdirSync(migrated.backups).some((f) =>
          f.endsWith("before-migration.sqlite3"),
        ),
      );
    } finally {
      migrated.close();
    }
  } finally {
    cleanTestWorkspace(f.directory);
  }
});
test("duplicate legacy URLs resolve to stable canonical evidence links", () => {
  const old = {
    id: "old",
    name: "Person",
    type: "person",
    schemaVersion: 2,
    findings: [],
    templateData: {
      "42": [
        { "Source ID": "S01", Title: "One", URL: "https://EXAMPLE.com/path/" },
        {
          "Source ID": "S02",
          Title: "Two",
          URL: "https://example.com/path#fragment",
        },
      ],
      "36": [
        {
          Claim: "Claim",
          "Source 1": "[S01]",
          "Source 2": "S02",
          Confidence: "CONFIRMED",
        },
      ],
    },
  };
  const d = validate(migrate(old));
  assert.equal(d.sources.length, 1);
  assert.deepEqual(d.assertions[0].sourceIds, [d.sources[0].id]);
  assert.deepEqual(d.legacy, old);
});
test("both current fictional samples and the old import format are supported", () => {
  for (const file of [
    "sample-person.json",
    "sample-organization.json",
    "legacy-sample-person.json",
  ])
    validate(
      previewImport(JSON.parse(readFileSync("examples/" + file, "utf8"))),
    );
});
test("unsupported shapes, dates, addresses, duplicate references and IDs are rejected", () => {
  for (const patch of [
    { schemaVersion: 999 },
    { sources: {} },
    { entities: null },
    { conclusionIds: null },
    { revision: true },
  ])
    assert.throws(() => previewImport({ ...doc(), ...patch }));
  for (const bad of [
    "2026-02-30",
    "2026-13",
    "20260101",
    "2026-W40-1",
    "tomorrow",
  ]) {
    const d = doc();
    d.sources = [{ ...source(), published: bad }];
    assert.throws(() => validate(d));
  }
  for (const bad of [
    "javascript:alert(1)",
    "file:///c:/secret",
    "https://example.com:99999",
    "https://user:pass@example.com",
    "http://",
  ]) {
    const d = doc();
    d.sources = [source("s", "S01", bad)];
    assert.throws(() => validate(d));
  }
  const d = doc();
  d.sources = [
    source(),
    source("source-2", "S02", "https://EXAMPLE.com/evidence/#fragment"),
  ];
  assert.throws(() => validate(d));
  d.sources[1] = source("source-2", "s01", "https://example.com/other");
  assert.throws(() => validate(d));
});
test("reviewed and strong confidence need evidence; source removal cannot break references", () => {
  for (const patch of [
    { classification: "CONFIRMED" },
    { classification: "CORROBORATED" },
    { verification: "reviewed" },
    { sourceIds: ["missing"] },
  ] as Partial<Assertion>[]) {
    const d = doc();
    d.assertions = [fact(d, patch)];
    assert.throws(() => validate(d));
  }
  const d = doc();
  d.assertions = [
    fact(d, {
      classification: "CONFIRMED",
      justification: "Directly examined original paper record",
    }),
  ];
  validate(d);
  d.sources = [source()];
  d.assertions[0].sourceIds = ["source-1"];
  validate(d);
  d.sources = [];
  assert.throws(() => validate(d));
});
test("relationships need explicit endpoints and unknown information stays distinct from known", () => {
  const d = doc();
  d.assertions = [
    fact(d, {
      kind: "relationship",
      relationship: "owns",
      fromId: d.subjectId,
      toId: "missing",
    }),
  ];
  assert.throws(() => validate(d));
  Object.assign(d.assertions[0], {
    kind: "fact",
    value: "",
    knowledge: "not_found",
  });
  validate(d);
  d.assertions[0].knowledge = "known";
  assert.throws(() => validate(d));
});
test("analyst scores require a reason and a finite number within the rubric", () => {
  const d = doc();
  d.assertions = [fact(d, { score: 8 })];
  assert.throws(() => validate(d));
  d.assertions[0].justification = "Leading contribution to the case objective";
  validate(d);
  for (const score of [11, NaN, Infinity]) {
    d.assertions[0].score = score;
    assert.throws(() => validate(d));
  }
});
test("date validation retains approximate dates and handles early years and leap days", () => {
  for (const date of ["0001", "0001-01-01", "2000-02-29", "2024-02", "2026"])
    assert(validDate(date), date);
  for (const date of ["0000", "1900-02-29", "2026-02-29", "0099-02-29"])
    assert(!validDate(date), date);
});
test("stable legacy IDs exactly match UUID v5 used by the original app", () => {
  assert.equal(
    stable("legacy:subject"),
    "97a2e1e0-4064-5285-b8ab-b53c25bd61ab",
  );
});
async function httpFixture() {
  const f = fixture(),
    server = createApp(f.store);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing test server");
  const url = "http://127.0.0.1:" + address.port;
  return {
    ...f,
    server,
    url,
    close: async () => {
      server.close();
      await once(server, "close");
      cleanTestWorkspace(f.directory);
    },
    call: async (
      path: string,
      method = "GET",
      data?: unknown,
      headers: Record<string, string> = {},
    ) => {
      const r = await fetch(url + path, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      return { status: r.status, value: await r.json() };
    },
  };
}
test("HTTP saves expose revision conflicts and actual database health", async () => {
  const f = await httpFixture();
  try {
    const first = await f.call("/api/dossiers", "POST", doc());
    assert.equal(first.status, 200);
    const changed = { ...first.value, notes: "A" };
    assert.equal((await f.call("/api/dossiers", "POST", changed)).status, 200);
    const stale = await f.call("/api/dossiers", "POST", {
      ...first.value,
      notes: "B",
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.value.current.notes, "A");
    assert.equal((await f.call("/api/health")).value.status, "online");
  } finally {
    await f.close();
  }
});
test("HTTP invalid imports and cross-origin requests are blocked", async () => {
  const f = await httpFixture();
  try {
    assert.equal(
      (await f.call("/api/import/preview", "POST", { schemaVersion: 999 }))
        .status,
      400,
    );
    assert.equal((await f.call("/api/dossiers", "POST", [])).status, 400);
    assert.equal((await f.call("/api/cases", "POST")).status, 400);
    assert.equal(
      (
        await f.call("/api/dossiers", "POST", doc(), {
          Origin: "https://evil.example",
        })
      ).status,
      403,
    );
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        f.url + "/api/health",
        { headers: { Host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  } finally {
    await f.close();
  }
});
test("HTTP serves the built folio but does not expose database, source maps or traversal", async () => {
  const f = await httpFixture();
  try {
    assert.equal((await fetch(f.url + "/")).status, 200);
    for (const path of [
      "/data/mapper.sqlite3",
      "/../storage.py",
      "/app.js.map",
      "/src/server/storage.ts",
      "/%2e%2e/data/mapper.sqlite3",
    ])
      assert.equal((await fetch(f.url + path)).status, 404);
  } finally {
    await f.close();
  }
});
test("existing SQLite database can be copied and read without rewriting any dossier", () => {
  const f = fixture();
  try {
    f.store.save(doc());
    const original = f.store.db.prepare("SELECT document FROM dossiers").get()!
        .document,
      backup = f.store.backup("compatibility");
    const copied = new Store(join(f.directory, "copy.sqlite3"));
    copied.close();
    copyFileSync(backup, join(f.directory, "copy.sqlite3"));
    const opened = new Store(join(f.directory, "copy.sqlite3"));
    try {
      assert.equal(
        opened.db.prepare("SELECT document FROM dossiers").get()!.document,
        original,
      );
      assert.equal(
        opened.db.prepare("PRAGMA integrity_check").get()!.integrity_check,
        "ok",
      );
    } finally {
      opened.close();
    }
  } finally {
    f.close();
  }
});

test("launcher errors explain recovery actions", () => {
  assert.match(startupMessage("EADDRINUSE", 8765), /occupied/);
  assert.match(
    startupMessage("unable to open database", 8765),
    /writable folder/,
  );
  assert.match(
    startupMessage("database disk image is malformed", 8765),
    /restore/,
  );
  assert.match(startupMessage("ENOSPC", 8765), /disk space/);
});
