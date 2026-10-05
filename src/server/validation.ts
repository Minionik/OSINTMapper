import { randomUUID, createHash } from "node:crypto";
import type { Dossier, WorkspaceBackup } from "../shared/model";
export const now = (): string => new Date().toISOString();
export const identity = (): string => randomUUID();
export function stable(seed: string): string {
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const hash = createHash("sha1")
    .update(namespace)
    .update("osint-mapper:" + seed)
    .digest()
    .subarray(0, 16);
  hash[6] = (hash[6] & 15) | 80;
  hash[8] = (hash[8] & 63) | 128;
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function text(
  value: unknown,
  label: string,
  required = false,
  limit = 50000,
): string {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    (required && !value.trim())
  )
    throw new TypeError(
      `${label}: enter ${required ? "a nonempty value" : "text"} (maximum ${limit} characters).`,
    );
  return value;
}
export function validDate(value: string): boolean {
  if (!value) return true;
  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(value)) return false;
  const [year, month = 1, day = 1] = value.split("-").map(Number);
  if (year < 1 || year > 9999 || month < 1 || month > 12) return false;
  const days = new Date(
    Date.UTC(year === 0 ? 2000 : year, month, 0),
  ).getUTCDate();
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day >= 1 && day <= (month === 2 ? (leap ? 29 : 28) : days);
}
export function validUrl(value: string): boolean {
  if (!value) return true;
  try {
    const u = new URL(value);
    return (
      /^https?:\/\//i.test(value) &&
      !!u.hostname &&
      !/\s/.test(value) &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}
export function canonicalUrl(value: string): string {
  if (!value) return "";
  const u = new URL(value);
  return u.origin + u.pathname.replace(/\/+$/, "") + u.search;
}
export function record(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} must be an object.`);
}
export function identifier(value: unknown, label: string): string {
  const id = text(value, label, true, 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(id))
    throw new TypeError(
      `${label} must be a stable ID without spaces or slashes.`,
    );
  return id;
}
const levels = [
  "UNVERIFIED",
  "POSSIBLE",
  "PROBABLE",
  "CORROBORATED",
  "CONFIRMED",
  "CONTRADICTED",
];
export function validate(input: unknown): Dossier {
  record(input, "Dossier");
  if (input.schemaVersion !== 3)
    throw new TypeError(
      "Supported dossier schema is version 3. Preview older imports for migration.",
    );
  text(input.name, "Dossier name", true, 200);
  if (!["person", "organization"].includes(String(input.type)))
    throw new TypeError("Choose Person or Organization.");
  for (const key of ["notes", "summary"]) text(input[key] ?? "", key);
  for (const key of ["created", "updated"])
    if (key in input) {
      const v = text(input[key], key, true, 60);
      if (
        !v.includes("T") ||
        !validDate(v.split("T")[0]) ||
        !Number.isFinite(Date.parse(v))
      )
        throw new TypeError(`${key} must be an ISO date and time.`);
    }
  for (const key of [
    "entities",
    "sources",
    "assertions",
    "tasks",
    "conclusionIds",
    "modules",
    "warnings",
  ])
    if (!Array.isArray(input[key]))
      throw new TypeError(`${key} must be a list.`);
  record(input.legacy ?? {}, "Migration archive");
  for (const key of ["id", "subjectId", "caseId"]) identifier(input[key], key);
  if (!Number.isInteger(input.revision) || Number(input.revision) < 0)
    throw new TypeError("Invalid dossier revision.");
  const doc = input as unknown as Dossier;
  for (const key of ["modules", "warnings"] as const)
    for (const v of doc[key]) text(v, key);
  function ids(records: unknown[], label: string): Set<string> {
    const seen = new Set<string>();
    for (const r of records) {
      record(r, label);
      const id = identifier(r.id, label + " ID");
      if (seen.has(id)) throw new TypeError("Duplicate " + label + " ID.");
      seen.add(id);
    }
    return seen;
  }
  const entities = ids(doc.entities, "entity"),
    sources = ids(doc.sources, "source"),
    assertions = ids(doc.assertions, "assertion");
  ids(doc.tasks, "task");
  if (!entities.has(doc.subjectId))
    throw new TypeError("Subject entity is missing.");
  if (doc.entities.find((e) => e.id === doc.subjectId)?.type !== doc.type)
    throw new TypeError(
      "The dossier subject must use its Person or Organization type.",
    );
  for (const e of doc.entities) {
    text(e.name, "Entity name", true, 300);
    if (
      ![
        "person",
        "organization",
        "account",
        "domain",
        "project",
        "entity",
      ].includes(e.type)
    )
      throw new TypeError("Choose an explicit entity type.");
    for (const k of ["aliases", "details", "dossierId"] as const)
      text(e[k] ?? "", "Entity " + k);
  }
  const refs = new Set<string>(),
    urls = new Set<string>();
  for (const s of doc.sources) {
    const ref = text(s.ref, "Source reference", true, 40).toLowerCase();
    if (refs.has(ref)) throw new TypeError("Source references must be unique.");
    refs.add(ref);
    text(s.title, "Source title", true, 500);
    for (const k of ["url", "archiveUrl"] as const)
      if (!validUrl(text(s[k] ?? "", k, false, 4000)))
        throw new TypeError(
          `${s.ref}: use a full HTTP/HTTPS web address for ${k}.`,
        );
    if (s.url) {
      const u = canonicalUrl(s.url);
      if (urls.has(u))
        throw new TypeError(
          "This source URL already exists. Reuse its source record.",
        );
      urls.add(u);
    }
    for (const k of ["published", "accessed"] as const)
      if (!validDate(text(s[k] ?? "", k, false, 20)))
        throw new TypeError(
          "Source dates must be YYYY, YYYY-MM, or YYYY-MM-DD.",
        );
    text(s.publisher ?? "", "Publisher");
    text(s.notes ?? "", "Notes");
    if (
      !["unassessed", "high", "medium", "low"].includes(
        s.quality ?? "unassessed",
      )
    )
      throw new TypeError("Invalid source quality.");
  }
  for (const a of doc.assertions) {
    if (!["fact", "relationship"].includes(a.kind))
      throw new TypeError("Assertion type must be fact or relationship.");
    text(a.label, "Fact label", true, 500);
    for (const k of ["value", "evidence", "justification", "category"] as const)
      text(a[k] ?? "", k);
    if (
      !["known", "not_checked", "not_found", "not_applicable"].includes(
        a.knowledge ?? "known",
      )
    )
      throw new TypeError("Invalid information state.");
    if ((a.knowledge ?? "known") === "known" && !a.value?.trim())
      throw new TypeError(
        "Enter a fact, or mark it Not checked / Not found / Not applicable.",
      );
    if (!levels.includes(a.classification ?? "UNVERIFIED"))
      throw new TypeError("Use a level from the confidence guide.");
    if (!["unreviewed", "reviewed"].includes(a.verification ?? "unreviewed"))
      throw new TypeError("Invalid review state.");
    const links = a.sourceIds ?? [];
    if (
      !Array.isArray(links) ||
      links.some((l) => typeof l !== "string" || !sources.has(l)) ||
      links.length !== new Set(links).size
    )
      throw new TypeError(
        "A referenced source is missing. Reassign the evidence before removing it.",
      );
    if (!entities.has(a.entityId))
      throw new TypeError("Fact subject entity is missing.");
    if (a.kind === "relationship") {
      if (!entities.has(a.fromId!) || !entities.has(a.toId!))
        throw new TypeError("Choose both connection endpoints by entity ID.");
      text(a.relationship, "Relationship", true, 200);
    }
    if (typeof (a.internal ?? false) !== "boolean")
      throw new TypeError("Internal visibility must be true or false.");
    if (
      "score" in a &&
      (typeof a.score !== "number" ||
        !Number.isFinite(a.score) ||
        a.score < 0 ||
        a.score > 10 ||
        !a.justification?.trim())
    )
      throw new TypeError(
        "Scores need a number from 0 to 10 and an analyst explanation.",
      );
    if (
      (["CONFIRMED", "CORROBORATED"].includes(a.classification) ||
        a.verification === "reviewed") &&
      !links.length &&
      !a.justification?.trim()
    )
      throw new TypeError(
        "Reviewed or strongly confirmed assertions need a source or an explicit evidence justification.",
      );
    for (const k of ["collected", "eventDate", "publicationDate"] as const)
      if (!validDate(text(a[k] ?? "", k, false, 20)))
        throw new TypeError(
          "Dates must be YYYY, YYYY-MM, or YYYY-MM-DD; approximate periods remain explicit.",
        );
  }
  for (const t of doc.tasks) {
    text(t.text, "Next step", true);
    if (
      typeof (t.done ?? false) !== "boolean" ||
      !validDate(text(t.due ?? "", "Due date", false, 20))
    )
      throw new TypeError("Invalid task state or due date.");
  }
  if (
    doc.conclusionIds.some(
      (id) => typeof id !== "string" || !assertions.has(id),
    )
  )
    throw new TypeError("A referenced conclusion fact is missing.");
  return doc;
}
export function validateSnapshot(input: unknown): {
  dossiers: number;
  cases: number;
  trash: number;
} {
  record(input, "Backup");
  if (input.format !== "osint-mapper-workspace" || input.version !== 1)
    throw new TypeError("Unsupported workspace backup.");
  if (
    !Array.isArray(input.cases) ||
    !Array.isArray(input.dossiers) ||
    !Array.isArray(input.history ?? [])
  )
    throw new TypeError("Backup needs dossiers and cases.");
  const p = input as unknown as WorkspaceBackup,
    cases = new Set<string>(),
    docs = new Map<string, number>(),
    history = new Set<string>();
  for (const c of p.cases) {
    record(c, "Case");
    identifier(c.id, "Case ID");
    text(c.name, "Case name", true, 200);
    text(c.objective ?? "", "Case objective");
    if (cases.has(c.id)) throw new TypeError("Duplicate case ID.");
    cases.add(c.id);
  }
  for (const i of p.dossiers) {
    record(i, "Backup dossier");
    const d = validate(i.document);
    if (d.revision < 1 || !d.created || !d.updated)
      throw new TypeError(
        "Backup documents must include their saved revision and timestamps.",
      );
    if (
      docs.has(d.id) ||
      !cases.has(d.caseId) ||
      typeof i.deleted !== "boolean"
    )
      throw new TypeError("Invalid backup ID, case link, or trash state.");
    docs.set(d.id, d.revision);
  }
  for (const h of p.history ?? []) {
    record(h, "History entry");
    const d = validate(h.document);
    if (
      !docs.has(h.dossierId) ||
      d.id !== h.dossierId ||
      d.revision !== h.revision
    )
      throw new TypeError("History snapshot identity/revision mismatch.");
    if (
      !Number.isInteger(h.revision) ||
      h.revision < 1 ||
      h.revision > docs.get(h.dossierId)!
    )
      throw new TypeError(
        "History revision is outside the saved dossier history.",
      );
    const key = h.dossierId + ":" + h.revision;
    if (history.has(key)) throw new TypeError("Duplicate history revision.");
    history.add(key);
    text(h.action, "History action");
    text(h.time, "History time");
  }
  return {
    dossiers: docs.size,
    cases: cases.size,
    trash: p.dossiers.filter((i) => i.deleted).length,
  };
}
