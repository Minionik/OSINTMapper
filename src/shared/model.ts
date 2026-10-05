/** Persisted schema. IDs, rather than display names, identify linked records. */
export type SubjectType = "person" | "organization";
export type EntityType =
  SubjectType | "account" | "domain" | "project" | "entity";
export type Confidence =
  | "UNVERIFIED"
  | "POSSIBLE"
  | "PROBABLE"
  | "CORROBORATED"
  | "CONFIRMED"
  | "CONTRADICTED";
export type Knowledge =
  "known" | "not_checked" | "not_found" | "not_applicable";
export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  aliases: string;
  details: string;
  dossierId: string;
}
export interface Source {
  id: string;
  ref: string;
  title: string;
  publisher: string;
  url: string;
  published: string;
  accessed: string;
  archiveUrl: string;
  quality: "unassessed" | "high" | "medium" | "low";
  notes: string;
}
export interface Assertion {
  id: string;
  kind: "fact" | "relationship";
  entityId: string;
  label: string;
  value: string;
  category: string;
  knowledge: Knowledge;
  classification: Confidence;
  verification: "unreviewed" | "reviewed";
  sourceIds: string[];
  evidence: string;
  justification: string;
  collected: string;
  eventDate: string;
  publicationDate: string;
  internal: boolean;
  fromId?: string;
  toId?: string;
  relationship?: string;
  score?: number;
}
export interface ResearchTask {
  id: string;
  text: string;
  done: boolean;
  due: string;
}
export interface Dossier {
  schemaVersion: 3;
  id: string;
  revision: number;
  name: string;
  type: SubjectType;
  caseId: string;
  subjectId: string;
  created?: string;
  updated?: string;
  entities: Entity[];
  sources: Source[];
  assertions: Assertion[];
  tasks: ResearchTask[];
  notes: string;
  summary: string;
  conclusionIds: string[];
  modules: string[];
  warnings: string[];
  legacy: Record<string, unknown>;
  action?: string;
}
export interface InvestigationCase {
  id: string;
  name: string;
  objective: string;
}
export interface HistoryEntry {
  revision: number;
  action: string;
  time: string;
  document: Dossier;
}
export interface WorkspaceBackup {
  format: "osint-mapper-workspace";
  version: 1;
  created: string;
  cases: InvestigationCase[];
  dossiers: { document: Dossier; deleted: boolean }[];
  history: (HistoryEntry & { dossierId: string })[];
}
export interface TemplateField {
  id: string;
  label: string;
  type: string;
  help?: string;
  options?: string[];
  [key: string]: unknown;
}
export interface TemplateSection {
  id: string;
  title: string;
  fields: TemplateField[];
  [key: string]: unknown;
}
export interface TemplateDefinition {
  sections: TemplateSection[];
  [key: string]: unknown;
}
export type TemplateLibrary = Record<SubjectType, TemplateDefinition>;
