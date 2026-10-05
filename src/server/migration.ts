import type {
  Assertion,
  Dossier,
  Entity,
  ResearchTask,
  Source,
  SubjectType,
} from "../shared/model";
import { TEMPLATES } from "../shared/templates";
import {
  canonicalUrl,
  identity,
  now,
  record,
  stable,
  validate,
  validDate,
  validUrl,
} from "./validation";
interface LegacyFinding {
  label?: string;
  value?: string;
  source?: string;
  notes?: string;
  collected?: string;
  category?: string;
  confidence?: string;
  status?: string;
}
interface LegacyDocument {
  schemaVersion?: number;
  id?: string;
  revision?: number;
  name?: string;
  type: SubjectType;
  caseId?: string;
  created?: string;
  updated?: string;
  notes?: string;
  templateData?: Record<string, Record<string, string>[]>;
  findings?: LegacyFinding[];
}
export function migrate(input: unknown): Dossier {
  record(input, "Dossier");
  if (input.schemaVersion === 3)
    return structuredClone(input) as unknown as Dossier;
  const old = input as unknown as LegacyDocument,
    id = String(old.id || identity()),
    warnings: string[] = [],
    root = stable(id + ":subject");
  const data = old.templateData ?? {},
    profile = (data.profile ?? [{}])[0] ?? {},
    name =
      profile["Full name"] || profile["Legal name"] || old.name || "Untitled";
  const entities: Entity[] = [
      {
        id: root,
        name,
        type: old.type,
        aliases: profile["Other names"] ?? "",
        details: profile["Country / location"] ?? "",
        dossierId: id,
      },
    ],
    sources: Source[] = [],
    assertions: Assertion[] = [],
    tasks: ResearchTask[] = [];
  const refs = new Map<string, string | null>();
  for (const [i, r] of (data["42"] ?? []).entries()) {
    if (!Object.values(r).some(Boolean)) continue;
    const s: Source = {
      id: stable(`${id}:source:${i}`),
      ref: r["Source ID"] || `S${String(i + 1).padStart(2, "0")}`,
      title: r.Title || "Legacy source",
      publisher: r.Publisher ?? "",
      url: r.URL ?? "",
      published: r.Date ?? "",
      accessed: r["Date Accessed"] ?? "",
      archiveUrl: r["Archive URL"] ?? "",
      quality: "unassessed",
      notes: "",
    };
    for (const k of ["url", "archiveUrl", "published", "accessed"] as const)
      if (
        !(k === "url" || k === "archiveUrl" ? validUrl(s[k]) : validDate(s[k]))
      ) {
        s.notes += `Legacy ${k}: ${s[k]}\n`;
        s[k] = "";
        warnings.push(
          "Invalid legacy source value preserved in notes; please review.",
        );
      }
    const ref = s.ref.toUpperCase();
    if (refs.has(ref)) {
      refs.set(ref, null);
      s.ref = `S${String(i + 1).padStart(2, "0")}-duplicate`;
      warnings.push(
        "Duplicate legacy source reference: " +
          ref +
          ". Evidence needs review.",
      );
    } else refs.set(ref, s.id);
    const same = sources.find(
      (other) => s.url && canonicalUrl(other.url) === canonicalUrl(s.url),
    );
    if (same) {
      if (refs.get(ref)) refs.set(ref, same.id);
      same.notes += "\nAdditional legacy source metadata: " + JSON.stringify(r);
      warnings.push(
        "Repeated source URL consolidated; original metadata retained in the archive and source notes.",
      );
    } else sources.push(s);
  }
  const sourceIds = (r: Record<string, string>): string[] => {
    const ids = new Set<string>();
    for (const k of ["Source", "Source 1", "Source 2", "Source 3"])
      for (const ref of (r[k] ?? "").toUpperCase().match(/\bS\d+\b/g) ?? []) {
        const resolved = refs.get(ref);
        if (resolved) ids.add(resolved);
        else warnings.push("Unresolved legacy source reference: " + ref);
      }
    return [...ids].sort();
  };
  function add(
    seed: string,
    label: string,
    value: string,
    r: Record<string, string> = {},
    category = "General",
    extra: Partial<Assertion> = {},
  ): Assertion | undefined {
    if (!String(value).trim()) return;
    const links = sourceIds(r),
      original = (r.Confidence ?? "UNVERIFIED").toUpperCase();
    let confidence =
      (
        { HIGH: "PROBABLE", MEDIUM: "POSSIBLE", LOW: "UNVERIFIED" } as Record<
          string,
          string
        >
      )[original] ?? original;
    if (
      ![
        "UNVERIFIED",
        "POSSIBLE",
        "PROBABLE",
        "CORROBORATED",
        "CONFIRMED",
        "CONTRADICTED",
      ].includes(confidence)
    )
      confidence = "UNVERIFIED";
    if (["CONFIRMED", "CORROBORATED"].includes(confidence) && !links.length) {
      warnings.push(
        `Unsupported legacy certainty for ${label}; original classification retained in the archive.`,
      );
      confidence = "UNVERIFIED";
    }
    const a: Assertion = {
      id: stable(id + ":" + seed),
      kind: "fact",
      entityId: root,
      label,
      value: String(value),
      category,
      knowledge: "known",
      classification: confidence as Assertion["classification"],
      verification: "unreviewed",
      sourceIds: links,
      evidence: r.Evidence ?? "",
      justification: "",
      collected: "",
      eventDate: "",
      publicationDate: "",
      internal: false,
      ...extra,
    };
    assertions.push(a);
    return a;
  }
  function endpoint(label: string, seed: string): string {
    if (
      [name.toLowerCase(), (old.name ?? "").toLowerCase()].includes(
        label.trim().toLowerCase(),
      )
    )
      return root;
    const eid = stable(id + ":" + seed);
    entities.push({
      id: eid,
      name: label,
      type: "entity",
      aliases: "",
      details: "Imported identity: confirm matches before merging.",
      dossierId: "",
    });
    return eid;
  }
  const sections = new Map(TEMPLATES[old.type].sections.map((s) => [s.id, s]));
  for (const [section, rows] of Object.entries(data)) {
    const definition = sections.get(section);
    if (!definition) {
      warnings.push(
        "Unknown legacy section preserved in the archive: " + section,
      );
      continue;
    }
    const labels = new Map(definition.fields.map((f) => [f.id, f.label]));
    for (const [i, r] of rows.entries()) {
      if (section === "42") continue;
      if (
        section === "connections" &&
        ["From", "To", "Relationship"].every((k) => r[k]?.trim())
      )
        add(`connection:${i}`, r.Relationship, r.Relationship, r, "General", {
          kind: "relationship",
          fromId: endpoint(r.From, `connection:${i}:from`),
          toId: endpoint(r.To, `connection:${i}:to`),
          relationship: r.Relationship,
        });
      else if (["36", "40"].includes(section)) {
        add(
          `${section}:${i}`,
          section === "36" ? "Claim" : "Key finding",
          r.Claim || r["Key Finding"] || "",
          r,
          definition.title,
        );
        for (const [k, v] of Object.entries(r))
          if (
            ![
              "Claim",
              "Key Finding",
              "Evidence",
              "Confidence",
              "Source 1",
              "Source 2",
              "Source 3",
            ].includes(k)
          )
            add(
              `${section}:${i}:${k}`,
              labels.get(k) ?? k,
              v,
              {},
              definition.title,
            );
      } else if (["38", "39", "43"].includes(section)) {
        for (const [k, v] of Object.entries(r))
          if (String(v).trim())
            tasks.push({
              id: stable(`${id}:task:${section}:${i}:${k}`),
              text: `${labels.get(k) ?? k}: ${v}`,
              done: false,
              due: "",
            });
      } else
        for (const [k, v] of Object.entries(r))
          add(
            `${section}:${i}:${k}`,
            labels.get(k) ?? k,
            v,
            {},
            definition.title,
          );
    }
  }
  for (const [i, r] of (old.findings ?? []).entries()) {
    let source: string | undefined;
    if (r.source && validUrl(r.source)) {
      source = sources.find(
        (s) => canonicalUrl(s.url) === canonicalUrl(r.source!),
      )?.id;
      if (!source) {
        source = stable(`${id}:finding-source:${i}`);
        sources.push({
          id: source,
          ref: `S${String(sources.length + 1).padStart(2, "0")}`,
          title: r.label || "Finding source",
          publisher: "",
          url: r.source,
          published: "",
          accessed: "",
          archiveUrl: "",
          quality: "unassessed",
          notes: "",
        });
      }
    }
    add(
      `finding:${i}`,
      r.label || "Finding",
      r.value ?? "",
      {},
      r.category ?? "General",
      {
        sourceIds: source ? [source] : [],
        evidence: r.notes ?? "",
        collected: validDate(r.collected ?? "") ? (r.collected ?? "") : "",
        classification:
          (
            {
              high: "PROBABLE",
              medium: "POSSIBLE",
              low: "UNVERIFIED",
            } as Record<string, Assertion["classification"]>
          )[r.confidence ?? ""] ?? "UNVERIFIED",
        verification:
          r.status === "verified" && source ? "reviewed" : "unreviewed",
      },
    );
  }
  if (entities.length > 1)
    warnings.push(
      "Legacy endpoint occurrences remain separate. Use Identity review to confirm suggested matches.",
    );
  return {
    schemaVersion: 3,
    id,
    revision: Number(old.revision ?? 0),
    name: old.name || "Untitled",
    type: old.type,
    caseId: old.caseId || "default",
    subjectId: root,
    created: old.created || now(),
    updated: old.updated || now(),
    entities,
    sources,
    assertions,
    tasks,
    notes: old.notes ?? "",
    summary: "",
    conclusionIds: [],
    modules: [],
    warnings: [...new Set(warnings)],
    legacy: structuredClone(input),
  };
}
export function previewImport(input: unknown): Dossier {
  record(input, "Dossier");
  if (
    !Number.isInteger(input.schemaVersion ?? 1) ||
    ![1, 2, 3].includes(Number(input.schemaVersion ?? 1))
  )
    throw new TypeError(
      "Unsupported import version. Supported versions: 1, 2, 3.",
    );
  if (input.schemaVersion !== 3) {
    if (!["person", "organization"].includes(String(input.type)))
      throw new TypeError("Choose Person or Organization.");
    if (!Array.isArray(input.findings ?? []))
      throw new TypeError(
        "Legacy findings must be a list and template data an object.",
      );
    record(input.templateData ?? {}, "Legacy template data");
    const d = input as unknown as LegacyDocument;
    for (const rows of Object.values(d.templateData ?? {}))
      if (
        !Array.isArray(rows) ||
        rows.some((r) => !r || typeof r !== "object" || Array.isArray(r))
      )
        throw new TypeError("Legacy sections must contain lists of objects.");
    for (const f of d.findings ?? []) {
      record(f, "Finding");
      if (Object.values(f).some((v) => typeof v !== "string"))
        throw new TypeError("Legacy findings must contain text fields.");
      if (
        !validUrl(String(f.source ?? "")) ||
        !validDate(String(f.collected ?? ""))
      )
        throw new TypeError(
          "A legacy finding has an invalid source URL or collection date.",
        );
    }
    const refs = new Set<string>();
    for (const section of TEMPLATES[d.type].sections)
      for (const r of d.templateData?.[section.id] ?? []) {
        for (const field of section.fields) {
          const v = r[field.id] ?? "";
          if (typeof v !== "string")
            throw new TypeError("Legacy field values must be text.");
          if (
            (field.type === "url" && !validUrl(v)) ||
            (field.type === "date" && !validDate(v))
          )
            throw new TypeError("Invalid imported date or URL: " + field.label);
        }
        if (section.id === "42" && r["Source ID"]) {
          const ref = r["Source ID"].toLowerCase();
          if (refs.has(ref))
            throw new TypeError(
              "Duplicate imported source reference: " + r["Source ID"],
            );
          refs.add(ref);
        }
      }
  }
  return validate(migrate(input));
}
