import type {
  Dossier,
  InvestigationCase,
  TemplateLibrary,
} from "../shared/model";
import { buildGraph, mountGraph } from "./graph";
/* One maintained draft per dossier; views project the same assertions and IDs. */
const $ = (s: string): any => document.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const clone = <T>(v: T): T => structuredClone(v);
const uid = (): string => crypto.randomUUID();
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const levels = [
  "UNVERIFIED",
  "POSSIBLE",
  "PROBABLE",
  "CORROBORATED",
  "CONFIRMED",
  "CONTRADICTED",
];
const entityTypes = [
  "person",
  "organization",
  "account",
  "domain",
  "project",
  "entity",
];
const friendly = (v) =>
  ({
    not_checked: "Not checked",
    not_found: "Not found",
    not_applicable: "Not applicable",
    unreviewed: "Unreviewed",
    reviewed: "Reviewed",
  })[v] || v[0]?.toUpperCase() + v.slice(1).toLowerCase();
interface WorkspaceState {
  docs: Dossier[];
  cases: InvestigationCase[];
  caseId: string;
  doc: Dossier | null;
  base: Dossier | null;
  tab: string;
  stamp: number;
  pending: Map<string, Promise<Dossier>>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  status: string;
  dialogKey: string;
  graph: ReturnType<typeof mountGraph> | null;
  reviewFilter: string;
  allAssertions: boolean;
  openOnly: boolean;
  mapScope: string;
  database?: string;
  backups?: string;
  conflictEntryKey?: string;
}
const state: WorkspaceState = {
  docs: [],
  cases: [],
  caseId: "default",
  doc: null,
  base: null,
  tab: "overview",
  stamp: 0,
  pending: new Map(),
  timers: new Map(),
  status: "Saved",
  dialogKey: "",
  graph: null,
  reviewFilter: "all",
  allAssertions: false,
  openOnly: false,
  mapScope: "dossier",
};
let templates: TemplateLibrary = {
    person: { sections: [] },
    organization: { sections: [] },
  },
  dialogPending = false;
// A duplicated browser tab can inherit sessionStorage. Give every live page its
// own draft keys, carrying its previous draft forward for reload/recovery.
const previousTab = sessionStorage.getItem("osint:tab");
const tabId = uid();
sessionStorage.setItem("osint:tab", tabId);
if (previousTab) {
  for (const key of Object.keys(localStorage))
    if (key.startsWith("osint:draft:") && key.endsWith(":" + previousTab)) {
      storageSet(key.slice(0, -previousTab.length) + tabId, storageGet(key));
      if (
        (
          performance.getEntriesByType?.(
            "navigation",
          )[0] as PerformanceNavigationTiming
        )?.type === "reload"
      )
        storageRemove(key);
    }
}
function notify(message, error = false) {
  $("#notice").textContent = message;
  $("#notice").className = error ? "error" : "";
}
async function request(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<any> {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(path, {
      method,
      signal: controller.signal,
      ...(data === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          }),
    });
    const value = await response.json();
    if (!response.ok) {
      const error = Error(value.error || "Request failed") as Error & {
        status?: number;
        current?: Dossier;
      };
      error.status = response.status;
      error.current = value.current;
      throw error;
    }
    return value;
  } catch (error) {
    if (error.status) throw error;
    throw Error(
      error.name === "AbortError"
        ? "The request timed out. The server may have saved it; your draft is protected. Save now safely checks the saved revision."
        : "Connection lost or response incomplete. Your draft is kept on this device. Restart the local app and try Save now.",
    );
  } finally {
    clearTimeout(timer);
  }
}
function storageGet(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}
function storageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    notify(
      "Browser draft storage is unavailable. Keep this tab open and save before closing.",
      true,
    );
  }
}
function storageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
}
function draftKey(id) {
  return "osint:draft:" + id + ":" + tabId;
}
function persist() {
  if (state.doc && dirty())
    storageSet(draftKey(state.doc.id), {
      document: state.doc,
      base: state.base,
      stamp: state.stamp,
      savedAt: new Date().toISOString(),
    });
}
function dirty() {
  return (
    state.doc &&
    JSON.stringify({ ...state.doc, revision: 0, updated: "" }) !==
      JSON.stringify({ ...state.base, revision: 0, updated: "" })
  );
}
function status(value) {
  state.status = value;
  $("#save-state").textContent = value;
}
function edit(change, action = "Edited") {
  change(state.doc);
  state.doc.action = action;
  state.stamp++;
  persist();
  status("Unsaved · draft protected");
  clearTimeout(state.timers.get(state.doc.id));
  state.timers.set(
    state.doc.id,
    setTimeout(() => saveDraft().catch(() => {}), 900),
  );
}
function updateSaved(saved) {
  const index = state.docs.findIndex((d) => d.id === saved.id);
  if (index < 0) state.docs.unshift(saved);
  else state.docs[index] = saved;
  renderNav();
}
async function saveDraft() {
  if (!state.doc || !dirty()) return state.doc;
  const id = state.doc.id;
  if (state.pending.has(id)) {
    await state.pending.get(id);
    if (state.doc?.id === id && dirty()) return saveDraft();
    return state.doc;
  }
  clearTimeout(state.timers.get(id));
  const snapshot = clone(state.doc),
    stamp = state.stamp,
    originalBase = clone(state.base);
  status("Saving…");
  const operation = (async () => {
    try {
      const saved = await request("/api/dossiers", "POST", snapshot);
      updateSaved(saved);
      if (state.doc?.id === id) {
        state.base = clone(saved);
        if (state.stamp === stamp) {
          state.doc = clone(saved);
          storageRemove(draftKey(id));
          status("Saved · revision " + saved.revision);
        } else {
          state.doc.revision = saved.revision;
          state.doc.updated = saved.updated;
          persist();
          status("Newer edits unsaved · draft protected");
          state.timers.set(
            id,
            setTimeout(() => saveDraft().catch(() => {}), 900),
          );
        }
        renderHeader();
      }
      return saved;
    } catch (error) {
      if (state.doc?.id === id) {
        persist();
        status(
          error.status === 409
            ? "Conflict · draft protected"
            : "Save failed · draft protected",
        );
        if (error.status === 409)
          showConflict(originalBase, clone(state.doc), error.current);
        else notify(error.message, true);
      }
      throw error;
    } finally {
      state.pending.delete(id);
    }
  })();
  state.pending.set(id, operation);
  return operation;
}
window.addEventListener("beforeunload", (event) => {
  if (
    dirty() ||
    dialogPending ||
    ($("#editor").open && state.dialogKey && storageGet(state.dialogKey))
  ) {
    persist();
    event.preventDefault();
    event.returnValue = "";
  }
});
function threeWay(base, mine, theirs) {
  const conflicts: { path: (string | number)[]; mine: any; theirs: any }[] = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function merge(b, m, t, path) {
    if (same(m, b)) return cloneValue(t);
    if (same(t, b) || same(m, t)) return cloneValue(m);
    if (
      Array.isArray(m) &&
      Array.isArray(t) &&
      [...m, ...t].every((v) => v && typeof v === "object" && v.id)
    ) {
      const ids = [...new Set([...t, ...m].map((v) => v.id))];
      return ids.map((id, index) =>
        merge(
          (b || []).find((v) => v.id === id),
          m.find((v) => v.id === id),
          t.find((v) => v.id === id),
          [...path, index],
        ),
      );
    }
    if (
      m &&
      t &&
      typeof m === "object" &&
      !Array.isArray(m) &&
      !Array.isArray(t)
    ) {
      const result: Record<string, any> = {};
      for (const key of new Set([
        ...Object.keys(b || {}),
        ...Object.keys(m),
        ...Object.keys(t),
      ]))
        result[key] = merge(b?.[key], m[key], t[key], [...path, key]);
      return result;
    }
    conflicts.push({ path, mine: m, theirs: t });
    return cloneValue(t);
  }
  function cloneValue(v) {
    return v === undefined ? undefined : clone(v);
  }
  const merged = merge(base, mine, theirs, []);
  return { merged, conflicts };
}
function prune(value) {
  if (Array.isArray(value))
    return value.filter((v) => v !== undefined).map(prune);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, prune(v)]),
    );
  return value;
}
function showConflict(base, mine, theirs) {
  const { merged, conflicts } = threeWay(base, mine, theirs);
  const dialog = $("#conflict-dialog");
  $("#conflict-content").innerHTML =
    `<h2>Another tab changed this dossier</h2><p>Your draft is safe. Nonconflicting edits can be combined; choose which value to keep for each conflict.</p>${conflicts.map((c, i) => `<fieldset><legend>${esc(c.path.join(" / "))}</legend><label><input type="radio" name="conflict-${i}" value="mine" checked> My draft<pre>${esc(JSON.stringify(c.mine, null, 2) ?? "(removed)")}</pre></label><label><input type="radio" name="conflict-${i}" value="theirs"> Latest saved version<pre>${esc(JSON.stringify(c.theirs, null, 2) ?? "(removed)")}</pre></label></fieldset>`).join("") || "<p>The edits touch different fields and can be combined.</p>"}<div class="dialog-actions"><button id="conflict-later">Keep draft; decide later</button><button class="primary" id="merge-save">Save combined version</button></div>`;
  $("#conflict-later").onclick = () => dialog.close();
  $("#merge-save").onclick = async () => {
    for (const [i, c] of conflicts.entries()) {
      const value =
        $(`#conflict-content input[name="conflict-${i}"]:checked`).value ===
        "mine"
          ? c.mine
          : c.theirs;
      let cursor = merged;
      for (const key of c.path.slice(0, -1)) cursor = cursor[key];
      cursor[c.path.at(-1)] = value;
    }
    state.base = clone(theirs);
    state.doc = prune(merged);
    state.doc.revision = theirs.revision;
    state.stamp++;
    persist();
    dialog.close();
    try {
      await saveDraft();
      if (state.conflictEntryKey) {
        storageRemove(state.conflictEntryKey);
        if (state.dialogKey === state.conflictEntryKey) $("#editor").close();
        state.conflictEntryKey = "";
      }
      renderContent();
    } catch {}
  };
  if (!dialog.open) dialog.showModal();
}
async function navigate(change) {
  persist();
  if (dirty()) {
    try {
      await saveDraft();
    } catch {
      return false;
    }
  }
  change();
  return true;
}
function selectDoc(id) {
  const saved = state.docs.find((d) => d.id === id);
  if (!saved) return;
  state.caseId = saved.caseId;
  $("#case-filter").value = saved.caseId;
  const draft = storageGet(draftKey(id));
  state.doc = clone(draft?.document || saved);
  state.base = clone(draft?.base || saved);
  state.stamp = draft?.stamp || 0;
  state.tab = "overview";
  status(
    draft ? "Recovered unsaved draft" : "Saved · revision " + saved.revision,
  );
  render();
}
function searchable(doc) {
  return [
    doc.name,
    doc.notes,
    doc.summary,
    ...doc.entities.map((e) => [e.name, e.aliases, e.details].join(" ")),
    ...doc.assertions.map((a) =>
      [a.label, a.value, a.evidence, a.relationship].join(" "),
    ),
    ...doc.sources.map((s) => [s.title, s.publisher, s.url].join(" ")),
    ...doc.tasks.map((t) => t.text),
  ]
    .join(" ")
    .toLowerCase();
}
function renderNav() {
  $("#dossier-count").textContent = String(
    state.docs.filter((d) => d.caseId === state.caseId).length,
  ).padStart(2, "0");
  const query = $("#search").value.toLowerCase();
  $("#dossiers").innerHTML =
    state.docs
      .filter((d) => d.caseId === state.caseId && searchable(d).includes(query))
      .map(
        (d) =>
          `<button data-dossier="${esc(d.id)}" class="${state.doc?.id === d.id ? "selected" : ""}" aria-current="${state.doc?.id === d.id ? "page" : "false"}"><span class="dossier-icon" aria-hidden="true">${d.type === "person" ? "P" : "O"}</span><span class="dossier-name">${esc(d.name)}<small>${friendly(d.type)} · ${d.assertions.length} records</small></span></button>`,
      )
      .join("") || '<p class="muted">No matching dossiers in this case.</p>';
  $("#dossiers")
    .querySelectorAll("button")
    .forEach(
      (button) =>
        (button.onclick = () =>
          navigate(() => selectDoc(button.dataset.dossier))),
    );
}
function unresolved(a) {
  return (
    a.verification !== "reviewed" ||
    ["UNVERIFIED", "POSSIBLE", "CONTRADICTED"].includes(a.classification)
  );
}
function renderHeader() {
  const doc = state.doc;
  $("#folio-type").textContent = doc
    ? " / " + friendly(doc.type).toUpperCase()
    : " / RESEARCH";
  $("#title").textContent = doc?.name || "Your investigation starts here.";
  $("#subtitle").textContent = doc
    ? `${friendly(doc.type)} · ${state.cases.find((c) => c.id === doc.caseId)?.name || "Case"} · revision ${state.base.revision}`
    : "Capture facts, keep their sources, and follow the connections.";
  $("#header-actions").hidden = !doc;
  $("#workspace").hidden = !doc;
  $("#empty").hidden = !!doc;
  if (!doc) return;
  $("#stats").innerHTML = [
    ["Unique sources", doc.sources.length, "sources"],
    [
      "Unresolved assertions",
      doc.assertions.filter(unresolved).length,
      "facts",
    ],
    ["Open next steps", doc.tasks.filter((t) => !t.done).length, "next"],
  ]
    .map(
      ([label, count, tab]) =>
        `<button class="stat" data-stat-tab="${tab}"><strong>${count}</strong><span>${label}</span></button>`,
    )
    .join("");
  $("#stats")
    .querySelectorAll("button")
    .forEach(
      (button) =>
        (button.onclick = () => {
          state.tab = button.dataset.statTab;
          state.reviewFilter = state.tab === "facts" ? "unresolved" : "all";
          state.allAssertions = state.tab === "facts";
          state.openOnly = state.tab === "next";
          renderContent();
        }),
    );
}
function render() {
  renderNav();
  renderHeader();
  if (state.doc) renderContent();
}
function button(label, action, id = "", extra = "") {
  return `<button type="button" data-action="${action}" data-id="${esc(id)}" ${extra}>${label}</button>`;
}
function sourceLabels(ids) {
  return ids
    .map((id) => {
      const source = state.doc.sources.find((s) => s.id === id);
      return source
        ? `<button type="button" class="text-link" data-action="source" data-id="${esc(id)}">${esc(source.ref)}</button>`
        : "Missing source";
    })
    .join(" ");
}
function badge(a) {
  return `<span class="badge ${a.classification.toLowerCase()}">${friendly(a.classification)}</span><span class="badge">${friendly(a.verification)}</span>${a.internal ? '<span class="badge">Internal</span>' : ""}${!a.sourceIds.length && !a.justification ? '<span class="badge warning">No evidence linked</span>' : ""}`;
}
function assertionCard(a) {
  const doc = state.doc;
  const from = doc.entities.find((e) => e.id === a.fromId),
    to = doc.entities.find((e) => e.id === a.toId);
  return `<article class="finding" id="record-${esc(a.id)}"><div class="finding-top"><div><h3>${esc(a.label)} · ${esc(a.category)}</h3><div class="value">${a.kind === "relationship" ? `${esc(from?.name)} → ${esc(a.relationship)} → ${esc(to?.name)}` : esc(a.knowledge === "known" ? a.value : friendly(a.knowledge))}</div></div><div class="badges">${badge(a)}</div></div><p>${esc(a.evidence)}</p><div class="metadata">${sourceLabels(a.sourceIds)}${a.eventDate ? `<span>Event: ${esc(a.eventDate)}</span>` : ""}${a.collected ? `<span>Collected: ${esc(a.collected)}</span>` : ""}</div><div class="card-actions">${button("Edit", "assertion", a.id)}${button("Use in conclusions", "conclusion", a.id)}${button("Remove · undo available", "remove-assertion", a.id)}</div></article>`;
}
function bindActions(root = $("#content")) {
  root.querySelectorAll("[data-action]").forEach((element) => {
    if (!element.closest("#relationship-graph"))
      element.onclick = () =>
        action(element.dataset.action, element.dataset.id);
  });
  root
    .querySelectorAll("[data-help]")
    .forEach(
      (element) => (element.onclick = () => showHelp(element.dataset.help)),
    );
}
function renderContent() {
  if (!state.doc) return;
  state.graph?.destroy?.();
  state.graph = null;
  $(".tabs")
    .querySelectorAll("button")
    .forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === state.tab);
      b.setAttribute("aria-selected", String(b.dataset.tab === state.tab));
      b.setAttribute("tabindex", b.dataset.tab === state.tab ? "0" : "-1");
    });
  const doc = state.doc,
    content = $("#content");
  if (state.tab === "overview") {
    const subject = doc.entities.find((e) => e.id === doc.subjectId);
    content.innerHTML = `<section class="folio-hero"><span class="subject-monogram" aria-hidden="true">${esc(
      subject.name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((n) => n[0])
        .join(""),
    )}</span><div><span class="eyebrow">SUBJECT / ${esc(friendly(subject.type))}</span><h2>${esc(subject.name)}</h2><p>${esc(subject.details || "Add distinguishing details to identify the right subject.")}</p></div>${button("Edit subject &nearr;", "entity", subject.id)}</section><div class="overview-grid"><section class="notes-panel"><span class="panel-kicker">01 / THE INVESTIGATION QUESTION</span><h2>Investigation overview</h2><p>${esc(state.cases.find((c) => c.id === doc.caseId)?.objective || "Set an objective using New case or Case settings.")}</p><label>Conclusion narrative ${help("summary")}<textarea id="summary" rows="5" placeholder="Explain your conclusion. Select supporting facts below; keep guesses in working notes.">${esc(doc.summary)}</textarea></label><h3>Supporting facts</h3>${
      doc.conclusionIds
        .map((id) => doc.assertions.find((a) => a.id === id))
        .filter(Boolean)
        .map(
          (a) =>
            `<p>${esc(a.value)} ${sourceLabels(a.sourceIds)} ${button("Remove from conclusion", "unconclusion", a.id)}</p>`,
        )
        .join("") || "<p>Use “Use in conclusions” on a reviewed fact.</p>"
    }</section><section class="notes-panel"><span class="panel-kicker">02 / THE ANALYST NOTEBOOK</span><h2>Working notes · internal</h2><p>Kept separate from facts and excluded from colleague-facing exports by default.</p><textarea id="notes" rows="8" aria-label="Working notes">${esc(doc.notes)}</textarea><p>Edits are saved automatically; Save now is always available.</p></section></div><section class="notes-panel"><span class="panel-kicker">03 / IDENTITY & RESEARCH TOOLS</span><h2>Basic identity</h2>${doc.entities
      .filter((e) => e.id === doc.subjectId)
      .map(
        (e) =>
          `<p><strong>${esc(e.name)}</strong> · ${friendly(e.type)}<br>${esc(e.details)}<br>Aliases: ${esc(e.aliases || "none recorded")}</p>`,
      )
      .join(
        "",
      )}${button("Identity review: suggested matches", "identities")}${button("Optional modules & presets", "modules")}${doc.modules.includes("Scoring") ? button("Edit optional scores", "scores") : ""}${button("View original migration archive", "archive")}</section>${doc.warnings?.length ? `<details class="template-section"><summary>Migration notes (${doc.warnings.length})</summary><div class="section-body">${doc.warnings.map((w) => `<p>${esc(w)}</p>`).join("")}</div></details>` : ""}`;
    $("#summary").oninput = (e) =>
      edit((d) => (d.summary = e.target.value), "Edited conclusion");
    $("#notes").oninput = (e) =>
      edit((d) => (d.notes = e.target.value), "Edited working notes");
  } else if (["facts", "connections"].includes(state.tab)) {
    const connections = state.tab === "connections";
    content.innerHTML = `<div class="map-header"><div><h2>${state.allAssertions ? "Unresolved assertions" : connections ? "Connections" : "Facts & claims"}</h2><p>One assertion, reused by the map, timeline, and report. Sources stay linked by ID.</p></div><div>${button(connections ? "＋ Record connection" : "＋ Add fact", connections ? "new-connection" : "new-fact")}${connections ? button("Manage entities", "entities") : button("Custom fields & modules", "modules")}</div></div><div class="filter-row"><label>Review<select id="review-filter"><option value="all">All assertions</option><option value="unresolved">Unresolved</option><option value="reviewed">Reviewed</option></select></label><label>Search assertions<input id="assertion-search" type="search" placeholder="Label, value, evidence, or relationship"></label></div><div id="assertion-list"></div>`;
    $("#review-filter").value = state.reviewFilter;
    function list() {
      const filter = $("#review-filter").value,
        q = $("#assertion-search").value.toLowerCase();
      state.reviewFilter = filter;
      $("#assertion-list").innerHTML =
        doc.assertions
          .filter(
            (a) =>
              (state.allAssertions ||
                (connections
                  ? a.kind === "relationship"
                  : a.kind === "fact")) &&
              (filter === "all" ||
                (filter === "unresolved"
                  ? unresolved(a)
                  : a.verification === "reviewed")) &&
              [a.label, a.value, a.evidence, a.relationship]
                .join(" ")
                .toLowerCase()
                .includes(q),
          )
          .map(assertionCard)
          .join("") ||
        '<div class="content-empty"><p>No matching assertions. Quick capture adds a fact and source together.</p></div>';
      bindActions($("#assertion-list"));
    }
    $("#review-filter").onchange = list;
    $("#assertion-search").oninput = list;
    list();
  } else if (state.tab === "sources") {
    content.innerHTML = `<div class="map-header"><div><h2>Source library (${doc.sources.length})</h2><p>Reuse a source instead of copying it into every record.</p></div>${button("＋ Add source", "new-source")}</div>${
      doc.sources
        .map((source) => {
          const used = doc.assertions.filter((a) =>
            a.sourceIds.includes(source.id),
          );
          return `<article class="finding"><h3>${esc(source.ref)} · ${esc(source.title)}</h3><p>${safeLink(source.url)}<br>${esc(source.publisher)}</p><p>Quality: ${esc(source.quality)} · Published ${esc(source.published || "not known")} · Checked ${esc(source.accessed || "not recorded")}</p><p>${used.length} linked assertions</p>${button("Edit source", "source", source.id)}${button("Read linked facts", "source-facts", source.id)}${button("Remove", "remove-source", source.id)}</article>`;
        })
        .join("") ||
      '<div class="content-empty"><p>Add a source here, or capture it with your first fact.</p></div>'
    }`;
  } else if (state.tab === "next") {
    content.innerHTML = `<div class="map-header"><div><h2>Next steps${state.openOnly ? " ? open only" : ""}</h2><p>Turn an unanswered question into a specific research task.</p></div>${button("＋ Add next step", "new-task")}</div>${
      doc.tasks
        .filter((t) => !state.openOnly || !t.done)
        .map(
          (t) =>
            `<article class="finding"><label><input class="inline-checkbox" data-task="${esc(t.id)}" type="checkbox" ${t.done ? "checked" : ""}> ${esc(t.text)}</label><p>${t.due ? "Due " + esc(t.due) : "No deadline"}</p>${button("Edit", "task", t.id)}${button("Remove", "remove-task", t.id)}</article>`,
        )
        .join("") ||
      '<div class="content-empty"><p>No next steps yet. What evidence would change your conclusion?</p></div>'
    }`;
    content.querySelectorAll("[data-task]").forEach(
      (input) =>
        (input.onchange = () => {
          edit(
            (d) =>
              (d.tasks.find((t) => t.id === input.dataset.task).done =
                input.checked),
            "Updated task",
          );
          renderHeader();
          if (state.openOnly) renderContent();
        }),
    );
  } else if (state.tab === "timeline") renderTimeline();
  else if (state.tab === "history") renderHistory();
  else if (state.tab === "map") renderMap();
  bindActions();
}
function safeLink(value) {
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol))
      return `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(value)}</a>`;
  } catch {}
  return esc(value);
}
function help(key) {
  const guidance = helpText[key] || helpText.fact;
  return `<span class="help-wrap"><button type="button" class="help-button" data-help="${esc(key)}" aria-label="Show guidance: ${esc(guidance[0])}" title="${esc(guidance[0])}">?</button><span class="help-tip" role="tooltip">${guidance.map(esc).join("<br><br>")}</span></span>`;
}
const helpText = {
  fact: [
    "Capture what the source actually says.",
    "Example: “The official staff page lists Avery as a research engineer.”",
    "Start with an official profile or original document. Add its URL and a relevant excerpt. Leave the value blank only if you choose Not checked, Not found, or Not applicable.",
  ],
  source: [
    "Create one reusable source.",
    "Example: S01 — staff directory — full https:// address.",
    "Copy the title and publisher from the page itself. Publication date and the date you checked it are different. Leave unknown dates blank.",
  ],
  identity: [
    "Identify an entity, not just a name.",
    "Example: Mercury / Organization / registered in Demo City.",
    "Use an official profile or registry. Same names are suggested matches, never an automatic merge. Add distinguishing details and aliases.",
  ],
  confidence: [
    "Use the same evidence levels everywhere.",
    "Confirmed: authoritative direct evidence. Corroborated: independent support. Probable: strong indirect evidence. Possible: a tentative lead. Unverified: not established. Contradicted: reliable disagreement.",
    "Reviewed means you examined the evidence; it does not automatically mean confirmed. Strong certainty needs a linked source or an explicit justification.",
  ],
  connection: [
    "Record the specific relationship supported by evidence.",
    "Example: Avery → works at → Northstar Labs, supported by S01.",
    "Select existing entity IDs or create a new typed entity. Do not merge two namesakes just to make the graph simpler. Record event dates separately from collection dates.",
  ],
  summary: [
    "Explain what the reviewed facts support.",
    "Example: “The staff and project records support a current affiliation; account ownership remains unresolved.”",
    "Use supported facts as citations. Keep speculative ideas in internal working notes.",
  ],
  unknown: [
    "Record what a blank actually means.",
    "Not checked: research remains. Not found: checked but no result. Not applicable: irrelevant to this inquiry.",
    "Add a short explanation of where you looked for a documented negative result.",
  ],
  scores: [
    "Optional analyst judgment, not an objective ranking.",
    "0: no demonstrated importance; 2: minor; 5: material; 8: leading contribution; 10: decisive for this investigation.",
    "Use only relevant dimensions, cite evidence, and explain your rating. A total is meaningful only with all seven scores and your context.",
  ],
  quality: [
    "Assess the source origin and reliability, separately from claim confidence.",
    "High: authenticated original record. Medium: established secondary account. Low: unclear provenance. Unassessed: not evaluated.",
    "Check the publisher, authorship, date, original context and whether this is a repost. A high source rating does not automatically confirm a particular assertion.",
  ],
};
function showHelp(key) {
  const values = helpText[key] || helpText.fact,
    panel = $("#help-panel");
  ($("#editor").open ? $("#editor") : document.body).append(panel);
  panel.innerHTML = `<button type="button" id="close-help">Close guidance</button><h2>${esc(key.startsWith("field:") ? values[0] : key[0].toUpperCase() + key.slice(1))}</h2>${values.map((v) => `<p>${esc(v)}</p>`).join("")}`;
  panel.hidden = false;
  $("#close-help").onclick = () => (panel.hidden = true);
  $("#close-help").focus();
}
const fieldGuidance = {
  password: [
    "Use the encryption password for this backup.",
    "For a new backup, choose a separate passphrase. For restoration, enter the password originally used.",
    "It is used only in your browser and is never sent to the server. Keep it separately; a lost password cannot be recovered.",
  ],
  label: [
    "Give the fact a short, specific label.",
    "Example: Current role.",
    "The value records what was observed; this label helps you find it later.",
  ],
  value: [
    "Record one factual observation or claim.",
    "Example: The official staff page lists a research engineer role.",
    "Keep the source excerpt separate and link the original page.",
  ],
  eventDate: [
    "When did the reported event happen?",
    "Example: 2025-09 for a September appointment.",
    "Read the date stated by the original source. Do not substitute the date you found the page.",
  ],
  collected: [
    "When did you examine this evidence?",
    "Example: 2026-10-04.",
    "Use your research date; approximate year or month is allowed if that is all you recorded.",
  ],
  published: [
    "When was the source published?",
    "Example: 2025-09.",
    "Check the document header, page metadata, or publisher record; leave blank if unknown.",
  ],
  publicationDate: [
    "When was this claim published?",
    "Example: 2025-09-12.",
    "Check the original article or document. The event can have happened earlier.",
  ],
  accessed: [
    "When did you check this source?",
    "Example: 2026-10-04.",
    "This documents your access, not the publication date.",
  ],
  url: [
    "Record a full public web address.",
    "Example: https://example.com/staff.",
    "Open the original document and copy its address; reuse an existing source for the same page.",
  ],
  archiveUrl: [
    "Record a preserved copy of this source.",
    "Example: the full HTTPS address of an archive snapshot.",
    "Find an archived page or a publisher repository version. Check that it contains the evidence you cited.",
  ],
  evidence: [
    "Quote or describe the passage supporting this precise assertion.",
    "Example: Staff page lists Avery with the role Research engineer.",
    "Read the original source, preserve relevant context, and avoid turning an indirect mention into a confirmed relationship.",
  ],
  justification: [
    "Explain the basis if a link cannot be provided.",
    "Example: Examined the public paper register, entry 14, at the registry office on this date.",
    "Describe the actual evidence and its limitations. An unsupported opinion does not establish certainty.",
  ],
  aliases: [
    "Add alternative names for this same verified identity.",
    "Example: abbreviated company name; former legal name.",
    "Use official profiles or registry history. Similar spelling alone does not establish identity.",
  ],
  details: [
    "Record details that distinguish namesakes.",
    "Example: organization jurisdiction or the role and city stated in an official profile.",
    "Use reliable identity information and explain ambiguities.",
  ],
  ref: [
    "Use a short unique source reference.",
    "Example: S01.",
    "This label can change without breaking linked assertions; links use the maintained source identity.",
  ],
  publisher: [
    "Who issued this record?",
    "Example: the official registry or organization.",
    "Read the page masthead or document cover; distinguish the publisher from the author and hosting site.",
  ],
  title: [
    "Use the source document or page title.",
    "Example: Northstar Labs staff directory.",
    "Copy a recognizable title from the original page so another analyst can find it.",
  ],
};
function field(
  label,
  name,
  value: string | number = "",
  type = "text",
  guidance = "fact",
) {
  const key = fieldGuidance[name] ? "field:" + name : guidance;
  if (fieldGuidance[name]) helpText[key] = fieldGuidance[name];
  return `<label for="input-${name}">${esc(label)} ${help(key)}${type === "textarea" ? `<textarea id="input-${name}" name="${name}" rows="3">${esc(value)}</textarea>` : `<input id="input-${name}" name="${name}" type="${type}" value="${esc(value)}">`}</label>`;
}
function selectField(
  label,
  name,
  options,
  value,
  guidance = "fact",
  multiple = false,
) {
  return `<label for="input-${name}">${esc(label)} ${help(guidance)}<select id="input-${name}" name="${name}" ${multiple ? 'multiple size="4"' : ""}>${options.map(([id, text]) => `<option value="${esc(id)}" ${(multiple ? (value || []).includes(id) : id === value) ? "selected" : ""}>${esc(text)}</option>`).join("")}</select>${multiple ? '<small class="field-hint">Ctrl / Command click to select multiple sources.</small>' : ""}</label>`;
}
function dialog(title, body, key = "", submitLabel = "Save") {
  if (dialogPending) return $("#edit-form");
  $("#help-panel").hidden = true;
  state.dialogKey = key;
  const restored = key ? storageGet(key) : null;
  $("#editor-content").innerHTML =
    `<h2>${esc(title)}</h2>${restored ? '<p class="draft-banner">Recovered unfinished entry. Cancel keeps this draft.</p>' : ""}<form id="edit-form"><div id="form-error" role="alert"></div>${body}<div class="dialog-actions"><button type="button" id="close-editor">Close · keep draft</button>${key ? '<button type="button" id="discard-dialog">Discard entry draft</button>' : ""}<button class="primary" id="submit-editor">${submitLabel}</button></div></form>`;
  const form = $("#edit-form");
  if (restored)
    for (const [name, value] of Object.entries(restored)) {
      const input = form.elements.namedItem(name);
      if (!input) continue;
      if (input.multiple)
        [...input.options].forEach(
          (o) => (o.selected = ((value as string[]) || []).includes(o.value)),
        );
      else if (input.type === "checkbox") input.checked = Boolean(value);
      else input.value = value;
    }
  function retain() {
    if (key) storageSet(key, formData(form));
  }
  form.oninput = retain;
  form.onchange = retain;
  $("#close-editor").onclick = () => {
    retain();
    $("#editor").close();
  };
  $("#discard-dialog")?.addEventListener("click", () => {
    storageRemove(key);
    $("#editor").close();
  });
  $("#editor").oncancel = (event) => {
    if (dialogPending) event.preventDefault();
    else retain();
  };
  bindActions($("#editor-content"));
  if (!$("#editor").open) $("#editor").showModal();
  return form;
}
function formData(form) {
  const data: Record<string, any> = Object.fromEntries(new FormData(form));
  for (const input of form.querySelectorAll("select[multiple]"))
    data[input.name] = [...input.selectedOptions].map((o) => o.value);
  for (const input of form.querySelectorAll('input[type="checkbox"]'))
    data[input.name] = input.checked;
  return data;
}
function submit(form, handler) {
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (dialogPending) return;
    const data = formData(form),
      controls = [...form.elements].map((input) => ({
        input,
        disabled: input.disabled,
      }));
    dialogPending = true;
    const key = state.dialogKey;
    controls.forEach(({ input }) => (input.disabled = true));
    $("#form-error").textContent = "";
    try {
      await handler(data);
      storageRemove(key);
      if (state.conflictEntryKey === key) state.conflictEntryKey = "";
      $("#editor").close();
      render();
    } catch (error) {
      if (error.status === 409 && key) state.conflictEntryKey = key;
      $("#form-error").textContent = error.message;
    } finally {
      dialogPending = false;
      controls.forEach(({ input, disabled }) => (input.disabled = disabled));
    }
  };
}
async function checkedEdit(change, action) {
  const proposal = clone(state.doc);
  change(proposal);
  await request("/api/import/preview", "POST", proposal);
  const revision = state.doc.revision;
  edit(() => {
    state.doc = proposal;
    state.doc.revision = revision;
  }, action);
}
function newDoc(
  name: string,
  type: Dossier["type"],
  caseId: string,
  id: string = uid(),
  usePreset = false,
): Dossier {
  const subjectId = "subject-" + id,
    doc: Dossier = {
      schemaVersion: 3,
      id,
      revision: 0,
      name,
      type,
      caseId,
      subjectId,
      entities: [
        { id: subjectId, name, type, aliases: "", details: "", dossierId: id },
      ],
      sources: [],
      assertions: [],
      tasks: [],
      notes: "",
      summary: "",
      conclusionIds: [],
      modules: [],
      warnings: [],
      legacy: {},
    };
  const preset = storageGet("osint:module-preset");
  if (usePreset && preset) {
    doc.modules = clone(preset.modules || []);
    for (const [index, f] of (preset.fields || []).entries())
      doc.assertions.push({
        id: "prompt-" + id + "-" + index,
        kind: "fact",
        entityId: subjectId,
        label: f.label,
        value: "",
        category: f.category,
        knowledge: "not_checked",
        classification: "UNVERIFIED",
        verification: "unreviewed",
        sourceIds: [],
        evidence: "",
        justification: "",
        collected: "",
        eventDate: "",
        publicationDate: "",
        internal: false,
      });
  }
  return doc;
}
function openDossier(existing = false, forcedId?: string) {
  const initial = existing ? state.doc : null,
    id = initial?.id || forcedId || uid();
  const form = dialog(
    existing ? "Dossier settings" : "Create a dossier",
    field("Name", "name", initial?.name || "", "text", "identity") +
      selectField(
        "Subject type",
        "type",
        [
          ["person", "Person"],
          ["organization", "Organization"],
        ],
        initial?.type || "person",
        "identity",
      ) +
      selectField(
        "Case",
        "caseId",
        state.cases.map((c) => [c.id, c.name]),
        initial?.caseId || state.caseId,
        "summary",
      ),
    "osint:entry:dossier:" + id,
  );
  if (existing) form.elements.type.disabled = true;
  else if (storageGet("osint:module-preset")) {
    const label = document.createElement("label");
    label.innerHTML =
      '<input type="checkbox" class="inline-checkbox" name="usePreset"> Apply my saved optional prompts';
    form.querySelector(".dialog-actions").before(label);
    form.elements.usePreset.checked = Boolean(
      storageGet(state.dialogKey)?.usePreset,
    );
  }
  submit(form, async (data) => {
    await saveDraft();
    if (initial) {
      await checkedEdit((d) => {
        d.name = data.name.trim();
        d.caseId = data.caseId;
      }, "Updated dossier settings");
      await saveDraft();
      state.caseId = data.caseId;
      $("#case-filter").value = data.caseId;
    } else {
      const doc = newDoc(
        data.name.trim(),
        data.type,
        data.caseId,
        id,
        data.usePreset,
      );
      const saved = await request("/api/dossiers", "POST", doc);
      updateSaved(saved);
      state.caseId = saved.caseId;
      $("#case-filter").value = state.caseId;
      selectDoc(saved.id);
    }
  });
}
function nextRef() {
  let n = 1;
  const refs = new Set(state.doc.sources.map((s) => s.ref.toLowerCase()));
  while (refs.has(("S" + String(n).padStart(2, "0")).toLowerCase())) n++;
  return "S" + String(n).padStart(2, "0");
}
function canonicalURL(value) {
  try {
    const u = new URL(value);
    return u.origin + u.pathname.replace(/\/+$/, "") + u.search;
  } catch {
    return value;
  }
}
function openSource(id: string | null = null) {
  const existing = state.doc.sources.find((s) => s.id === id),
    sourceId = id || uid();
  const defaults = existing || {
    ref: nextRef(),
    title: "",
    url: "",
    publisher: "",
    published: "",
    accessed: today(),
    archiveUrl: "",
    quality: "unassessed",
    notes: "",
  };
  const form = dialog(
    existing ? "Edit source" : "Add a reusable source",
    `<input type="hidden" name="sharedSourceId" value="${esc(sourceId)}">` +
      field("Reference", "ref", defaults.ref, "text", "source") +
      field("Title", "title", defaults.title, "text", "source") +
      field("Web address", "url", defaults.url, "url", "source") +
      field("Publisher", "publisher", defaults.publisher, "text", "source") +
      field(
        "Publication date (YYYY, YYYY-MM, or YYYY-MM-DD)",
        "published",
        defaults.published,
        "text",
        "source",
      ) +
      field("Date checked", "accessed", defaults.accessed, "text", "source") +
      field(
        "Archived web address",
        "archiveUrl",
        defaults.archiveUrl,
        "url",
        "source",
      ) +
      selectField(
        "Source quality",
        "quality",
        ["unassessed", "high", "medium", "low"].map((v) => [v, friendly(v)]),
        defaults.quality,
        "quality",
      ) +
      field(
        "Source notes · internal",
        "notes",
        defaults.notes,
        "textarea",
        "source",
      ),
    "osint:entry:source:" + state.doc.id + ":" + sourceId,
  );
  if (!existing) {
    const shared = state.docs
      .filter((d) => d.id !== state.doc.id && d.caseId === state.doc.caseId)
      .flatMap((d) => d.sources.map((s) => ({ source: s, owner: d })))
      .filter(
        ({ source }) =>
          !state.doc.sources.some(
            (s) =>
              s.id === source.id ||
              (source.url && canonicalURL(s.url) === canonicalURL(source.url)),
          ),
      );
    if (shared.length) {
      const area = document.createElement("div");
      area.innerHTML = selectField(
        "Reuse an existing source from this case",
        "reuseSource",
        [
          ["", "Choose a recorded source"],
          ...shared.map((entry, i) => [
            String(i),
            entry.source.title + " - " + entry.owner.name,
          ]),
        ],
        "",
        "source",
      );
      form.prepend(area);
      area.querySelector("select").onchange = (
        e: Event & { target: HTMLSelectElement },
      ) => {
        if (e.target.value === "") return;
        const entry = shared[Number(e.target.value)],
          record = clone(entry.source);
        record.ref = nextRef();
        record.accessed = today();
        record.notes = "";
        for (const [key, value] of Object.entries(record))
          if (form.elements[key]) form.elements[key].value = value;
        form.elements.sharedSourceId.value = record.id;
        form.dispatchEvent(new Event("input", { bubbles: true }));
      };
    }
  }
  const info = document.createElement("p");
  info.textContent =
    "Reused source IDs share title, publisher, URL, publication date and archive address within this case. Edits create revisions in linked dossiers; reference labels, access dates, quality and notes remain local.";
  form.prepend(info);
  submit(form, async (data) => {
    delete data.reuseSource;
    const selectedId = data.sharedSourceId || sourceId;
    delete data.sharedSourceId;
    await checkedEdit((d) => {
      const index = d.sources.findIndex((s) => s.id === selectedId);
      const source = { ...existing, ...data, id: selectedId };
      if (index < 0) d.sources.push(source);
      else d.sources[index] = source;
    }, "Updated source");
    await saveDraft();
  });
}
function openEntity(id: string | null = null) {
  const existing = state.doc.entities.find((e) => e.id === id),
    entityId = id || uid();
  const form = dialog(
    existing ? "Edit identity" : "Add a distinct identity",
    field("Name", "name", existing?.name || "", "text", "identity") +
      selectField(
        "Entity type",
        "type",
        (entityId === state.doc.subjectId
          ? ["person", "organization"]
          : entityTypes
        ).map((t) => [t, friendly(t)]),
        existing?.type || "person",
        "identity",
      ) +
      field("Aliases", "aliases", existing?.aliases || "", "text", "identity") +
      field(
        "Distinguishing details",
        "details",
        existing?.details || "",
        "textarea",
        "identity",
      ),
    "osint:entry:entity:" + state.doc.id + ":" + entityId,
  );
  const info = document.createElement("p");
  info.textContent =
    "Editing an identity deliberately linked by ID updates its metadata in other live dossiers in this case and creates saved revisions. Namesakes with different IDs stay separate.";
  form.prepend(info);
  submit(form, async (data) => {
    await checkedEdit((d) => {
      const entity = {
        ...existing,
        ...data,
        id: entityId,
        dossierId: existing?.dossierId || "",
      };
      if (entityId === d.subjectId) d.type = data.type;
      const index = d.entities.findIndex((e) => e.id === entityId);
      if (index < 0) d.entities.push(entity);
      else d.entities[index] = entity;
    }, "Updated identity");
    await saveDraft();
  });
}
function openAssertion(
  id: string | null = null,
  relationship = false,
  quick = false,
) {
  const existing = state.doc.assertions.find((a) => a.id === id),
    assertionId = id || uid(),
    doc = state.doc;
  const value = existing || {
    kind: relationship ? "relationship" : "fact",
    entityId: doc.subjectId,
    label: "",
    value: "",
    category: "General",
    knowledge: "known",
    classification: "UNVERIFIED",
    verification: "unreviewed",
    sourceIds: [],
    evidence: "",
    justification: "",
    collected: today(),
    eventDate: "",
    publicationDate: "",
    internal: false,
    fromId: doc.subjectId,
    toId: "",
    relationship: "",
  };
  relationship = value.kind === "relationship";
  const options = doc.entities.map((e) => [
    e.id,
    `${e.name} · ${friendly(e.type)} · ${e.details || e.id.slice(0, 8)}`,
  ]);
  const external = state.docs
    .filter((d) => d.id !== doc.id && d.caseId === doc.caseId)
    .map((d) => d.entities.find((e) => e.id === d.subjectId))
    .filter((e) => !doc.entities.some((known) => known.id === e.id));
  const endpoints = [
    ...options,
    ...external.map((e) => [e.id, `${e.name} · existing dossier`]),
  ];
  const body =
    (relationship
      ? selectField(
          "From identity",
          "fromId",
          endpoints,
          value.fromId,
          "connection",
        ) +
        selectField(
          "To identity",
          "toId",
          [["", "Choose an identity"], ...endpoints],
          value.toId,
          "connection",
        ) +
        field(
          "Relationship (e.g. works at)",
          "relationship",
          value.relationship,
          "text",
          "connection",
        )
      : `${field("Fact label", "label", value.label, "text", "fact")}${field("What the source says", "value", value.value, "textarea", "fact")}${selectField(
          "Information state",
          "knowledge",
          ["known", "not_checked", "not_found", "not_applicable"].map((v) => [
            v,
            friendly(v),
          ]),
          value.knowledge,
          "unknown",
        )}${field("Category / custom module", "category", value.category, "text", "fact")}`) +
    selectField(
      "Supporting sources",
      "sourceIds",
      doc.sources.map((s) => [s.id, s.ref + " · " + s.title]),
      value.sourceIds,
      "source",
      true,
    ) +
    (quick
      ? `<details open><summary>Add or reuse source from URL</summary>${field("Source URL", "newUrl", "", "url", "source")}${field("Source title", "newTitle", "", "text", "source")}</details>`
      : "") +
    field(
      "Evidence excerpt / explanation",
      "evidence",
      value.evidence,
      "textarea",
      "fact",
    ) +
    selectField(
      "Evidence confidence",
      "classification",
      levels.map((l) => [l, friendly(l)]),
      value.classification,
      "confidence",
    ) +
    selectField(
      "Review state",
      "verification",
      [
        ["unreviewed", "Unreviewed"],
        ["reviewed", "Reviewed"],
      ],
      value.verification,
      "confidence",
    ) +
    field(
      "Justification if no source is linked",
      "justification",
      value.justification,
      "textarea",
      "confidence",
    ) +
    field(
      "Event date (actual event, approximate period allowed)",
      "eventDate",
      value.eventDate,
      "text",
      "connection",
    ) +
    field(
      "Collection date (when you checked it)",
      "collected",
      value.collected,
      "text",
      "source",
    ) +
    field(
      "Publication date",
      "publicationDate",
      value.publicationDate,
      "text",
      "source",
    ) +
    `<label><input name="internal" class="inline-checkbox" type="checkbox" ${value.internal ? "checked" : ""}> Internal assertion · excluded from colleague export</label><p>${button("Need another identity? Close with draft, then add one", "entities")}</p>`;
  const form = dialog(
    existing
      ? "Edit assertion"
      : quick
        ? "Quick capture: fact + source"
        : relationship
          ? "Record a connection"
          : "Add a fact",
    body,
    "osint:entry:assertion:" + doc.id + ":" + assertionId,
  );
  submit(form, async (data) => {
    const next = { ...value, ...data, id: assertionId };
    delete next.newUrl;
    delete next.newTitle;
    if (relationship) {
      next.label = data.relationship;
      next.value = data.relationship;
      next.relationship = data.relationship;
    }
    if (
      !next.label.trim() ||
      (next.knowledge === "known" && !next.value.trim())
    )
      throw Error(
        "Enter a label and a fact, or choose a documented unknown state.",
      );
    if (relationship && !next.toId)
      throw Error(
        "Choose both identities. Add a new identity rather than reusing a namesake.",
      );
    if (
      (next.verification === "reviewed" ||
        ["CONFIRMED", "CORROBORATED"].includes(next.classification)) &&
      !next.sourceIds.length &&
      !data.newUrl &&
      !next.justification.trim()
    )
      throw Error(
        "Link a source or explain the evidence before marking this assertion reviewed or confirmed.",
      );
    await checkedEdit((d) => {
      for (const endpoint of [next.fromId, next.toId])
        if (endpoint && !d.entities.some((e) => e.id === endpoint)) {
          const entity = external.find((e) => e.id === endpoint);
          if (entity) d.entities.push(clone(entity));
        }
      if (data.newUrl) {
        let source = d.sources.find(
          (s) => canonicalURL(s.url) === canonicalURL(data.newUrl),
        );
        if (!source) {
          source = {
            id: uid(),
            ref: nextRef(),
            title: data.newTitle || "Captured source",
            url: data.newUrl,
            publisher: "",
            published: data.publicationDate || "",
            accessed: data.collected || "",
            archiveUrl: "",
            quality: "unassessed",
            notes: "",
          };
          d.sources.push(source);
        }
        next.sourceIds = [...new Set([...next.sourceIds, source.id])];
      }
      const index = d.assertions.findIndex((a) => a.id === assertionId);
      if (index < 0) d.assertions.push(next);
      else d.assertions[index] = next;
    }, "Updated assertion");
    await saveDraft();
  });
}
function openTask(id: string | null = null) {
  const task = state.doc.tasks.find((t) => t.id === id),
    taskId = id || uid();
  const form = dialog(
    "Next research step",
    field(
      "Specific question or action",
      "text",
      task?.text || "",
      "textarea",
      "unknown",
    ) + field("Due date", "due", task?.due || "", "text", "unknown"),
    "osint:entry:task:" + state.doc.id + ":" + taskId,
  );
  submit(form, async (data) => {
    await checkedEdit((d) => {
      const next = { ...task, ...data, id: taskId, done: task?.done || false };
      const index = d.tasks.findIndex((t) => t.id === taskId);
      if (index < 0) d.tasks.push(next);
      else d.tasks[index] = next;
    }, "Updated next step");
    await saveDraft();
  });
}
async function action(name, id) {
  if (name === "new-fact") return openAssertion();
  if (name === "new-connection") return openAssertion(null, true);
  if (name === "assertion") return openAssertion(id);
  if (name === "new-source") return openSource();
  if (name === "source") return openSource(id);
  if (name === "entity") return openEntity(id);
  if (name === "new-task") return openTask();
  if (name === "task") return openTask(id);
  if (name === "entities") return showEntities();
  if (name === "identities") return identityReview();
  if (name === "modules") return showModules();
  if (name === "scores") return showScores();
  if (name === "archive") return showArchive();
  if (name === "conclusion") {
    edit((d) => {
      if (!d.conclusionIds.includes(id)) d.conclusionIds.push(id);
    }, "Selected supporting conclusion");
    return renderContent();
  }
  if (name === "unconclusion") {
    edit(
      (d) => (d.conclusionIds = d.conclusionIds.filter((v) => v !== id)),
      "Removed conclusion reference",
    );
    return renderContent();
  }
  if (name === "source-facts") {
    const assertions = state.doc.assertions.filter((a) =>
      a.sourceIds.includes(id),
    );
    dialog(
      "Assertions using this source",
      assertions.map(assertionCard).join("") || "<p>No assertions linked.</p>",
    );
    $("#submit-editor").hidden = true;
    bindActions($("#editor-content"));
    return;
  }
  if (
    name === "remove-source" &&
    state.doc.assertions.some((a) => a.sourceIds.includes(id))
  )
    return notify(
      "This source supports assertions. Reassign their evidence before removing it.",
      true,
    );
  if (name.startsWith("remove-")) {
    const key = {
      "remove-assertion": "assertions",
      "remove-source": "sources",
      "remove-task": "tasks",
    }[name];
    if (!key) return;
    const before = clone(state.doc);
    edit((d) => {
      d[key] = d[key].filter((v) => v.id !== id);
      if (key === "assertions")
        d.conclusionIds = d.conclusionIds.filter((v) => v !== id);
    }, "Removed " + key);
    renderContent();
    notify(
      "Removed. Undo is available now; all saved versions remain in History.",
    );
    const undo = document.createElement("button");
    undo.textContent = "Undo";
    undo.onclick = () => {
      const revision = state.doc.revision;
      edit(() => {
        state.doc = clone(before);
        state.doc.revision = revision;
      }, "Undo removal");
      renderContent();
    };
    $("#notice").appendChild(undo);
  }
}
function showEntities() {
  dialog(
    "Identities in this dossier",
    `<p>Use different IDs for namesakes. Linking an existing dossier shares its identity.</p>${state.doc.entities.map((e) => `<article><strong>${esc(e.name)}</strong> · ${friendly(e.type)}<p>${esc(e.details)} · ID ${esc(e.id.slice(0, 8))}</p>${button("Edit", "entity", e.id)}</article>`).join("")}${button("＋ Add distinct identity", "new-entity")}${button("Review suggested matches", "identities")}`,
  );
  $("#submit-editor").hidden = true;
  $('#editor-content [data-action="new-entity"]').onclick = () => openEntity();
  bindActions($("#editor-content"));
  $('#editor-content [data-action="new-entity"]').onclick = () => openEntity();
}
function identityReview() {
  const entities = state.doc.entities;
  const pairs = [];
  for (let i = 0; i < entities.length; i++)
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i],
        b = entities[j];
      const names = (e) =>
        [e.name, ...e.aliases.split(/[,;\n]/)].map((v) =>
          v.trim().toLowerCase(),
        );
      if (names(a).some((v) => v && names(b).includes(v))) pairs.push([a, b]);
    }
  dialog(
    "Suggested identity matches · never merged automatically",
    `<p>Inspect distinguishing details. These suggestions may be unrelated namesakes. Merge only after verifying identity; this changes this dossier, not other cases.</p>${pairs.map(([a, b], i) => `<article class="finding"><h3>${esc(a.name)} ↔ ${esc(b.name)}</h3><p>${friendly(a.type)}: ${esc(a.details)}<br>${friendly(b.type)}: ${esc(b.details)}</p><button type="button" data-merge="${i}">Confirm same identity and merge</button></article>`).join("") || "<p>No name/alias matches suggested.</p>"}`,
  );
  $("#submit-editor").hidden = true;
  $("#editor-content")
    .querySelectorAll("[data-merge]")
    .forEach(
      (button) =>
        (button.onclick = () => {
          const [a, b] = pairs[Number(button.dataset.merge)];
          const survivor = b.id === state.doc.subjectId ? b : a,
            victim = survivor === a ? b : a;
          if (
            !confirm(
              "Merge these verified identities in this dossier? History keeps the previous version.",
            )
          )
            return;
          edit((d) => {
            for (const assertion of d.assertions)
              for (const key of ["entityId", "fromId", "toId"])
                if (assertion[key] === victim.id) assertion[key] = survivor.id;
            d.entities = d.entities.filter((e) => e.id !== victim.id);
            const kept = d.entities.find((e) => e.id === survivor.id);
            kept.aliases = [kept.aliases, victim.name, victim.aliases]
              .filter(Boolean)
              .join("; ");
          }, "Confirmed identity merge");
          $("#editor").close();
          renderContent();
        }),
    );
}
function showModules() {
  const stored = storageGet("osint:module-preset") || {},
    preset = Array.isArray(stored) ? { modules: stored, fields: [] } : stored;
  const modules = ["Research", "Ownership", "Contacts", "Scoring"],
    definition = templates[state.doc.type];
  const optional = (definition?.sections || [])
    .filter((s) => ["profile", "online", "33", "41"].includes(s.id))
    .flatMap((section) =>
      section.fields
        .filter((f) => !["select", "total"].includes(f.type))
        .map((f) => ({
          label: f.label,
          category: section.title,
          help: f.help || section.description || helpText.fact.join(" "),
        })),
    );
  optional.push(
    ...[
      "Registration number",
      "Registered office",
      "Directors",
      "Beneficial owners",
    ].map((label) => ({
      label,
      category: "Ownership",
      help: "Use the official company registry. Record jurisdiction, the register date, a source link, and any ownership uncertainty.",
    })),
  );
  const form = dialog(
    "Optional modules & custom fields",
    `<p>Enable only relevant modules. Template prompts become ordinary maintained facts with an explicit Not checked state; repeated answers use Add fact.</p>${modules.map((m) => `<label><input class="inline-checkbox" name="module-${m}" type="checkbox" ${state.doc.modules.includes(m) ? "checked" : ""}> ${m}</label>`).join("")}${button("Use personal preset", "use-preset")}${button("Optional scores with rubric", "scores")}<label><input class="inline-checkbox" name="savePreset" type="checkbox"> Save enabled modules and selected prompts as my personal preset</label><details><summary>Person / organization template prompts (optional)</summary><div class="module-library">${optional.map((f, i) => `<label><input class="inline-checkbox" name="prompt-${i}" type="checkbox"> ${esc(f.category)} - ${esc(f.label)}<small class="field-hint">${esc(f.help)}</small></label>`).join("")}</div></details>${field("New custom field label", "customLabel", "", "text", "fact")}${field("Custom category / section", "customCategory", "General", "text", "fact")}`,
  );
  $('#editor-content [data-action="use-preset"]').onclick = () => {
    modules.forEach(
      (m) =>
        (form.elements["module-" + m].checked = (preset.modules || []).includes(
          m,
        )),
    );
    optional.forEach(
      (f, i) =>
        (form.elements["prompt-" + i].checked = (preset.fields || []).some(
          (p) => p.label === f.label && p.category === f.category,
        )),
    );
  };
  let extras = [];
  const presetButton = $('#editor-content [data-action="use-preset"]'),
    applyPreset = presetButton.onclick;
  presetButton.onclick = () => {
    applyPreset();
    extras = (preset.fields || []).filter(
      (p) =>
        !optional.some((f) => f.label === p.label && f.category === p.category),
    );
    notify(
      extras.length
        ? extras.length + " custom preset prompt(s) will also be added."
        : "Preset choices applied.",
    );
  };
  submit(form, async (data) => {
    const enabled = modules.filter((m) => data["module-" + m]),
      fields = [...extras, ...optional.filter((f, i) => data["prompt-" + i])];
    if (data.customLabel.trim())
      fields.push({
        label: data.customLabel,
        category: data.customCategory || "General",
      });
    await checkedEdit((d) => {
      d.modules = enabled;
      for (const f of fields)
        if (
          !d.assertions.some(
            (a) => a.label === f.label && a.category === f.category,
          )
        )
          d.assertions.push({
            id: uid(),
            kind: "fact",
            entityId: d.subjectId,
            label: f.label,
            value: "",
            category: f.category,
            knowledge: "not_checked",
            classification: "UNVERIFIED",
            verification: "unreviewed",
            sourceIds: [],
            evidence: "",
            justification: "",
            collected: "",
            eventDate: "",
            publicationDate: "",
            internal: false,
          });
    }, "Changed modules and custom prompts");
    if (data.savePreset)
      storageSet("osint:module-preset", { modules: enabled, fields });
    await saveDraft();
  });
}
function showScores() {
  const dimensions = (
    templates[state.doc.type]?.sections.find((s) => s.id === "34")?.fields || []
  ).filter((f) => f.type === "score");
  const prior = dimensions.map((f) =>
    state.doc.assertions.find(
      (a) =>
        a.kind === "fact" &&
        a.category === "Analyst scoring" &&
        a.label === f.label &&
        typeof a.score === "number",
    ),
  );
  const form = dialog(
    "Optional importance scores ? analyst judgment",
    `<p>${helpText.scores.map(esc).join("<br>")} Blank dimensions are omitted. Explain how each dimension matters to the case; include evidence links when available.</p><div class="score-fields">${dimensions.map((f, i) => field(f.label, "score-" + i, prior[i]?.score ?? "", "number", "scores") + field("Reasoning for " + f.label, "reason-" + i, prior[i]?.justification || "", "textarea", "scores")).join("")}</div>`,
  );
  for (const input of form.querySelectorAll('input[type="number"]')) {
    input.min = 0;
    input.max = 10;
    input.step = 1;
  }
  submit(form, async (data) => {
    const entries = [];
    for (const [i, f] of dimensions.entries())
      if (data["score-" + i] !== "") {
        const score = Number(data["score-" + i]);
        if (
          !Number.isFinite(score) ||
          score < 0 ||
          score > 10 ||
          !data["reason-" + i].trim()
        )
          throw Error(
            "Each score needs a value from 0 to 10 and a purpose-specific explanation.",
          );
        entries.push({
          ...prior[i],
          id: prior[i]?.id || uid(),
          kind: "fact",
          entityId: state.doc.subjectId,
          label: f.label,
          value: score + "/10 ? analyst judgment",
          score,
          category: "Analyst scoring",
          knowledge: "known",
          classification: "UNVERIFIED",
          verification: "unreviewed",
          sourceIds: prior[i]?.sourceIds || [],
          justification: data["reason-" + i],
          evidence: prior[i]?.evidence || "",
          collected: today(),
          eventDate: "",
          publicationDate: "",
          internal: true,
        });
      }
    edit((d) => {
      d.assertions = d.assertions.filter(
        (a) =>
          !(
            a.kind === "fact" &&
            a.category === "Analyst scoring" &&
            typeof a.score === "number" &&
            dimensions.some((f) => f.label === a.label)
          ),
      );
      d.assertions.push(...entries);
      d.conclusionIds = d.conclusionIds.filter((id) =>
        d.assertions.some((a) => a.id === id),
      );
      if (!d.modules.includes("Scoring")) d.modules.push("Scoring");
    }, "Updated optional importance scores");
    await saveDraft();
  });
}
function showArchive() {
  dialog(
    "Original migration archive · read only",
    `<p>The original dossier is kept verbatim for recovery and comparison. Current assertions are the maintained records. This archive is excluded from colleague-facing exports.</p><pre>${esc(JSON.stringify(state.doc.legacy || {}, null, 2))}</pre>`,
  );
  $("#submit-editor").hidden = true;
}
function renderTimeline() {
  $("#content").innerHTML =
    '<h2>Timeline</h2><label>Chronology<select id="timeline-mode"><option value="eventDate">Actual events</option><option value="collected">Research collection</option><option value="publicationDate">Publication dates</option></select></label><p>Year-only and month-only dates are approximate periods, not invented exact days. Undated records remain explicit.</p><div id="timeline-list"></div>';
  function list() {
    const key = $("#timeline-mode").value;
    const assertions = state.doc.assertions;
    const dated = assertions
      .filter((a) => a[key])
      .sort((a, b) => a[key].localeCompare(b[key]));
    const sources =
      key === "publicationDate"
        ? state.doc.sources
            .filter((s) => s.published)
            .map((s) => ({ date: s.published, source: s }))
        : [];
    const items: {
      date: string;
      assertion?: Dossier["assertions"][number];
      source?: Dossier["sources"][number];
    }[] = [
      ...dated.map((a) => ({ date: a[key], assertion: a })),
      ...sources,
    ].sort((a, b) => a.date.localeCompare(b.date));
    $("#timeline-list").innerHTML =
      items
        .map(
          (item) =>
            `<h3>${esc(item.date)}${item.date.length < 10 ? " · approximate" : ""}</h3>${item.assertion ? assertionCard(item.assertion) : `<article class="finding">${esc(item.source.title)} ${button("Open source", "source", item.source.id)}</article>`}`,
        )
        .join("") +
      `<details><summary>${assertions.length - dated.length} assertions without this date</summary>${assertions
        .filter((a) => !a[key])
        .map(assertionCard)
        .join("")}</details>`;
    bindActions($("#timeline-list"));
  }
  $("#timeline-mode").onchange = list;
  list();
}
async function renderHistory() {
  const id = state.doc.id;
  $("#content").innerHTML =
    "<h2>History & recovery</h2><p>Loading saved revisions…</p>";
  try {
    const revisions = await request("/api/dossiers/" + id + "/history");
    if (state.doc?.id !== id || state.tab !== "history") return;
    $("#content").innerHTML =
      "<h2>History & recovery</h2><p>Restoring a revision creates a new revision; nothing is overwritten silently.</p>" +
      revisions
        .map(
          (r) =>
            `<article class="finding"><strong>Revision ${r.revision} · ${esc(r.action)}</strong><p>${esc(new Date(r.time).toLocaleString())} · ${r.document.assertions.length} assertions</p><button data-revision="${r.revision}">Inspect / restore</button></article>`,
        )
        .join("");
    $("#content")
      .querySelectorAll("[data-revision]")
      .forEach(
        (button) =>
          (button.onclick = () => {
            const selected = revisions.find(
              (r) => r.revision === Number(button.dataset.revision),
            );
            const form = dialog(
              "Saved revision " + selected.revision,
              `<p>Review the snapshot before restoring.</p><pre>${esc(JSON.stringify(selected.document, null, 2))}</pre>`,
              "",
              "Restore as a new revision",
            );
            submit(form, async () => {
              const revision = state.doc.revision;
              edit(() => {
                state.doc = clone(selected.document);
                state.doc.revision = revision;
              }, "Restored revision " + selected.revision);
              await saveDraft();
            });
          }),
      );
  } catch (error) {
    notify(error.message, true);
  }
}
function renderMap() {
  $("#content").innerHTML =
    '<div class="map-header"><div><h2>Relationship map</h2><p>Start with maintained identities and relationships. Show evidence records only when needed.</p></div><label>Scope<select id="map-scope"><option value="dossier">This dossier</option><option value="case">Whole case</option></select></label></div><div id="relationship-graph"></div>';
  $("#map-scope").value = state.mapScope;
  let generation = 0;
  const owner = state.doc.id;
  const mount = async () => {
    const ticket = ++generation;
    state.mapScope = $("#map-scope").value;
    state.graph?.destroy?.();
    if (state.mapScope === "case") {
      try {
        const docs = await request("/api/dossiers");
        if (
          state.doc?.id !== owner ||
          state.tab !== "map" ||
          ticket !== generation
        )
          return;
        state.docs = docs;
      } catch (error) {
        notify(error.message, true);
        return;
      }
    }
    const docs =
      state.mapScope === "case"
        ? state.docs
            .filter((d) => d.caseId === state.caseId)
            .map((d) => (d.id === state.doc.id ? state.doc : d))
        : [state.doc];
    const model = buildGraph(docs, state.doc.subjectId);
    const view =
      storageGet("osint:view:" + state.doc.id + ":" + state.mapScope) || {};
    state.graph = mountGraph($("#relationship-graph"), model, {
      view,
      onView: (v) =>
        storageSet("osint:view:" + state.doc.id + ":" + state.mapScope, v),
      onOpen: async (record) => {
        if (record.dossierId && record.dossierId !== state.doc.id) {
          if (!state.docs.some((d) => d.id === record.dossierId)) {
            notify(
              "The linked dossier is unavailable. Open its local identity from Connections.",
              true,
            );
            return;
          }
          if (!(await navigate(() => selectDoc(record.dossierId)))) return;
        }
        if (record.kind === "source") openSource(record.id);
        else if (record.kind === "entity") openEntity(record.id);
        else openAssertion(record.id);
      },
    });
  };
  $("#map-scope").onchange = mount;
  mount();
}
/* Export/backup controls are below; all exclusions happen before serialization. */
function scopedDossier(doc, options) {
  const pick = (value, keys) =>
    Object.fromEntries(
      keys
        .filter((k) => value[k] !== undefined)
        .map((k) => [k, clone(value[k])]),
    );
  const assertions = doc.assertions.filter(
    (a) =>
      (options.internal || !a.internal) &&
      (!options.reviewed || a.verification === "reviewed") &&
      (!options.selected || options.selected.includes(a.id)),
  );
  const sourceIds = new Set(assertions.flatMap((a) => a.sourceIds));
  const entityIds = new Set([
    doc.subjectId,
    ...assertions.flatMap((a) =>
      [a.entityId, a.fromId, a.toId].filter(Boolean),
    ),
  ]);
  return {
    schemaVersion: 3,
    id: doc.id,
    revision: doc.revision,
    name: doc.name,
    type: doc.type,
    caseId: doc.caseId,
    subjectId: doc.subjectId,
    created: doc.created,
    updated: doc.updated,
    entities: doc.entities
      .filter((e) => entityIds.has(e.id))
      .map((e) => ({
        ...pick(e, ["id", "name", "type", "dossierId"]),
        aliases: options.internal ? e.aliases : "",
        details: options.internal ? e.details : "",
      })),
    assertions: assertions.map((a) =>
      pick(a, [
        "id",
        "kind",
        "entityId",
        "fromId",
        "toId",
        "relationship",
        "label",
        "value",
        "category",
        "knowledge",
        "classification",
        "verification",
        "sourceIds",
        "evidence",
        "justification",
        "collected",
        "eventDate",
        "publicationDate",
        "internal",
        "score",
      ]),
    ),
    sources: doc.sources
      .filter((s) => sourceIds.has(s.id))
      .map((s) => ({
        ...pick(s, [
          "id",
          "ref",
          "title",
          "publisher",
          "url",
          "published",
          "accessed",
          "archiveUrl",
          "quality",
        ]),
        notes: options.internal ? s.notes : "",
      })),
    notes: options.notes ? doc.notes : "",
    summary: options.summary ? doc.summary : "",
    tasks: options.tasks
      ? doc.tasks.map((t) => pick(t, ["id", "text", "done", "due"]))
      : [],
    conclusionIds: doc.conclusionIds.filter((id) =>
      assertions.some((a) => a.id === id),
    ),
    modules: [],
    warnings: [],
    legacy: options.archive ? clone(doc.legacy || {}) : {},
  };
}
function reportText(doc, options) {
  const scoped = scopedDossier(doc, options),
    lines = [
      doc.name,
      "OSINT dossier report",
      `Snapshot: ${new Date().toLocaleString()}`,
      `Scope: ${options.reviewed ? "reviewed assertions" : "selected assertions"}; confidence and gaps remain explicit.`,
      "",
    ];
  if (options.summary)
    lines.push(
      "INVESTIGATION QUESTION",
      state.cases.find((c) => c.id === doc.caseId)?.objective ||
        "Not specified",
      "",
    );
  if (scoped.summary) {
    lines.push("CONCLUSIONS", scoped.summary, "Supporting records:");
    for (const id of scoped.conclusionIds) {
      const a = scoped.assertions.find((a) => a.id === id);
      if (a)
        lines.push(
          a.label +
            ": " +
            a.value +
            " [" +
            a.sourceIds
              .map((id) => scoped.sources.find((s) => s.id === id)?.ref)
              .filter(Boolean)
              .join(", ") +
            "]",
        );
    }
    lines.push("");
  }
  const entities = new Map(scoped.entities.map((e) => [e.id, e.name]));
  lines.push("FACTS AND CONNECTIONS");
  for (const a of scoped.assertions) {
    lines.push(
      a.kind === "relationship"
        ? `${entities.get(a.fromId)} ${a.relationship} ${entities.get(a.toId)}`
        : `${a.label}: ${a.knowledge === "known" ? a.value : friendly(a.knowledge)}`,
      `Confidence: ${friendly(a.classification)} | ${friendly(a.verification)}`,
      `Evidence: ${a.evidence || a.justification || "No supporting excerpt recorded"}`,
      `Sources: ${
        a.sourceIds
          .map((id) => scoped.sources.find((s) => s.id === id)?.ref)
          .filter(Boolean)
          .join(", ") || "none linked"
      }`,
      `Event: ${a.eventDate || "unknown"} | Published: ${a.publicationDate || "unknown"} | Collected: ${a.collected || "unknown"}`,
      "",
    );
  }
  lines.push("SOURCES");
  for (const s of scoped.sources)
    lines.push(
      `${s.ref}: ${s.title}`,
      `Publisher: ${s.publisher || "not recorded"}`,
      `URL: ${s.url || "not recorded"}`,
      `Published: ${s.published || "unknown"} | Checked: ${s.accessed || "unknown"}`,
      s.archiveUrl ? `Archive: ${s.archiveUrl}` : "",
      "",
    );
  if (scoped.tasks.length)
    lines.push(
      "NEXT STEPS",
      ...scoped.tasks.map((t) => `${t.done ? "[done]" : "[open]"} ${t.text}`),
      "",
    );
  if (scoped.notes) lines.push("INTERNAL WORKING NOTES", scoped.notes, "");
  lines.push(
    "LIMITATIONS",
    "A report is a snapshot. Confidence describes the evidence assessment, not an independent guarantee. Undated facts and unresolved claims remain visible in their records.",
  );
  return { scoped, text: lines.join("\n") };
}
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function fileName() {
  return state.doc.name.replace(/[^a-z0-9_-]/gi, "_");
}
function openExport() {
  const form = dialog(
    "Export preview & controlled inclusion",
    `<p>Hiding nodes on screen is not redaction. These controls remove excluded values from the file itself. A colleague-facing export excludes internal notes, leads, and the migration archive by default.</p>${selectField(
      "Preset",
      "preset",
      [
        ["colleague", "Colleague-facing"],
        ["internal", "Internal archive"],
      ],
      "colleague",
      "summary",
    )}<label><input class="inline-checkbox" type="checkbox" name="reviewed" checked> Reviewed assertions only</label><label><input class="inline-checkbox" type="checkbox" name="notes"> Include internal working notes</label><label><input class="inline-checkbox" type="checkbox" name="tasks"> Include next steps / leads</label><label><input class="inline-checkbox" type="checkbox" name="internal"> Include internal assertions and identity/source notes</label><label><input class="inline-checkbox" type="checkbox" name="archive"> Include original migration archive (JSON only)</label><label><input class="inline-checkbox" type="checkbox" name="summary"> Include investigation question and conclusion (review sensitive content)</label>${selectField(
      "Output",
      "output",
      [
        ["text", "Readable text report"],
        ["html", "Readable HTML report / print to PDF"],
        ["map", "Interactive map · current layout"],
        ["json", "Scoped dossier JSON"],
      ],
      "text",
      "summary",
    )}<details><summary>Choose particular assertions (optional)</summary>${state.doc.assertions.map((a) => `<label><input class="inline-checkbox" type="checkbox" name="include-${a.id}" checked> ${esc(a.label)}: ${esc(a.value)}</label>`).join("")}</details><button type="button" id="preview-export">Refresh exact preview</button><pre id="export-preview"></pre>`,
    "",
    "Download reviewed preview",
  );
  let prepared = null;
  function preview() {
    form.elements.archive.disabled = form.elements.output.value !== "json";
    const data = formData(form),
      options = {
        ...data,
        archive: data.output === "json" && data.archive,
        selected: state.doc.assertions
          .filter((a) => data["include-" + a.id])
          .map((a) => a.id),
      };
    prepared = { data, options, ...reportText(state.doc, options) };
    $("#export-preview").textContent =
      (data.output === "json"
        ? ""
        : prepared.scoped.assertions.length +
          " included assertions, " +
          prepared.scoped.sources.length +
          " linked sources.\n\n") +
      (data.output === "json"
        ? JSON.stringify(prepared.scoped, null, 2)
        : prepared.text);
  }
  form.elements.preset.onchange = () => {
    const internal = form.elements.preset.value === "internal";
    for (const key of ["notes", "tasks", "internal", "archive", "summary"])
      form.elements[key].checked = internal;
    form.elements.reviewed.checked = !internal;
    preview();
  };
  $("#preview-export").onclick = preview;
  form.onchange = preview;
  preview();
  submit(form, async () => {
    preview();
    const { data, scoped, text, options } = prepared;
    const name = fileName();
    if (data.output === "json")
      download(
        name + ".json",
        JSON.stringify(scoped, null, 2),
        "application/json",
      );
    else if (data.output === "text")
      download(name + "_report.txt", text, "text/plain;charset=utf-8");
    else if (data.output === "html")
      download(
        name + "_report.html",
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>${esc(state.doc.name)} · dossier report</title><style>body{font-family:Segoe UI,sans-serif;max-width:900px;margin:40px auto;padding:20px;color:#253b52}pre{font:inherit;white-space:pre-wrap;line-height:1.8;overflow-wrap:anywhere}@media print{body{margin:0}}</style><h1>${esc(state.doc.name)}</h1><pre>${esc(text)}</pre></html>`,
        "text/html;charset=utf-8",
      );
    else {
      if (options.archive)
        throw Error(
          "The graph never embeds the original archive. Use JSON if that archive is intentionally required.",
        );
      const css = await fetch("/graph.css").then((r) => {
        if (!r.ok) throw Error("Export styles unavailable.");
        return r.text();
      });
      const model = buildGraph([scoped], scoped.subjectId);
      const view =
        storageGet("osint:view:" + state.doc.id + ":" + state.mapScope) || {};
      const safe = (v) =>
        JSON.stringify(v)
          .replace(/</g, "\\u003c")
          .replace(/\u2028/g, "\\u2028")
          .replace(/\u2029/g, "\\u2029");
      // Only positions for included IDs are carried into the shareable view.
      const permitted = new Set(model.nodes.map((n) => n.id));
      view.positions = Object.fromEntries(
        Object.entries(view.positions || {}).filter(([id]) =>
          permitted.has(id),
        ),
      );
      view.query = "";
      view.type = "all";
      view.scope = "all";
      for (const key of ["expanded", "collapsed", "manual"])
        view[key] = (view[key] || []).filter((id) => permitted.has(id));
      if (!permitted.has(view.selected)) view.selected = model.subjectId;
      download(
        name + "_map.html",
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(scoped.name)}</title><style>body{font-family:Segoe UI,sans-serif;margin:20px;background:#eef2f6;color:#243c53}${css}</style></head><body><h1>${esc(scoped.name)}</h1><p>Scoped snapshot · ${esc(new Date().toLocaleString())}. Only the previewed assertions and their sources are embedded.</p><div id="map"></div><script>(${mountGraph.toString()})(document.getElementById('map'),${safe(model)},{view:${safe(view)}});</script></body></html>`,
        "text/html;charset=utf-8",
      );
    }
  });
}
function bytes64(bytes: Uint8Array) {
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
}
function from64(value) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
async function backupKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
async function encryptBackup(payload, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12)),
    iterations = 250000;
  const key = await backupKey(password, salt, iterations),
    data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(payload)),
    );
  return {
    format: "osint-mapper-encrypted",
    version: 1,
    iterations,
    salt: bytes64(salt),
    iv: bytes64(iv),
    data: bytes64(new Uint8Array(data)),
  };
}
async function decryptBackup(payload, password) {
  if (
    payload.format !== "osint-mapper-encrypted" ||
    payload.version !== 1 ||
    payload.iterations < 100000 ||
    payload.iterations > 500000
  )
    throw Error("Unsupported encrypted backup parameters.");
  const key = await backupKey(
    password,
    from64(payload.salt),
    payload.iterations,
  );
  try {
    return JSON.parse(
      new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: from64(payload.iv) },
          key,
          from64(payload.data),
        ),
      ),
    );
  } catch {
    throw Error(
      "Wrong password or a damaged encrypted backup. No workspace changes were made.",
    );
  }
}
function workspaceTools() {
  const form = dialog(
    "Workspace backup & recovery",
    `<p>Database: ${esc(state.database || "data/mapper.sqlite3")}. The local workspace has no login and its database is not encrypted. Backups contain all dossiers, history, and Trash. Daily SQLite snapshots are in ${esc(state.backups || "data/backups")}. Encrypted downloads protect the exported backup; keep the password separately.</p>${field("Optional encryption password (never sent to the server)", "password", "", "password", "source")}<p>${button("Choose backup to inspect / restore", "choose-restore")}${button("Check live connection", "check-health")}${button("Stop local server", "stop-server")}</p>`,
    "",
    "Download workspace backup",
  );
  $('#editor-content [data-action="choose-restore"]').onclick = () =>
    $("#restore-file").click();
  $('#editor-content [data-action="check-health"]').onclick = health;
  $('#editor-content [data-action="stop-server"]').onclick = async () => {
    await saveDraft();
    await request("/api/stop", "POST");
    $("#editor").close();
    $("#connection-status").textContent =
      "Server stopped · drafts kept locally";
    notify("Restart using Launch OSINT Mapper.cmd or npm start.");
  };
  submit(form, async (data) => {
    const payload = await request("/api/backup");
    const value = data.password
      ? await encryptBackup(payload, data.password)
      : payload;
    download(
      "OSINT_workspace_" + today() + ".osintbackup",
      JSON.stringify(value),
      "application/json",
    );
  });
}
async function inspectRestore(file) {
  if (file.size > 40_000_000)
    throw Error("Backup is larger than the 40 MB import limit.");
  let payload = JSON.parse(await file.text());
  if (payload.format === "osint-mapper-encrypted") {
    const form = dialog(
      "Unlock encrypted backup",
      field("Backup password", "password", "", "password", "source"),
    );
    submit(form, async (data) => {
      const decoded = await decryptBackup(payload, data.password);
      setTimeout(
        () =>
          confirmRestore(decoded).catch((error) => notify(error.message, true)),
        0,
      );
    });
    return;
  }
  return confirmRestore(payload);
}
async function confirmRestore(payload) {
  const preview = await request("/api/backup/preview", "POST", payload);
  const form = dialog(
    "Restore inspected workspace backup",
    `<p>${preview.cases} cases, ${preview.dossiers} dossiers, ${preview.trash} in Trash. This replaces the current workspace. A safety SQLite backup is made first. Export any current drafts before proceeding.</p>${field("Type RESTORE to explicitly replace this workspace", "confirmation", "", "text", "summary")}`,
    "",
    "Restore workspace",
  );
  submit(form, async (data) => {
    if (data.confirmation !== "RESTORE")
      throw Error("Type RESTORE to confirm replacement.");
    persist();
    for (const timer of state.timers.values()) clearTimeout(timer);
    await Promise.allSettled([...state.pending.values()]);
    for (const timer of state.timers.values()) clearTimeout(timer);
    state.timers.clear();
    persist();
    $("#conflict-dialog").close();
    await request("/api/backup/restore", "POST", payload);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key.startsWith("osint:draft:")) {
        storageSet(
          key.replace("osint:draft:", "osint:recovery:"),
          storageGet(key),
        );
        storageRemove(key);
      }
    }
    state.doc = null;
    state.base = null;
    state.stamp = 0;
    await load();
    notify(
      "Workspace restored. The pre-restore database remains in data/backups.",
    );
  });
}
async function openTrash() {
  const docs = await request("/api/trash");
  dialog(
    "Trash · recoverable deletion",
    `<p>Permanent removal deletes the live dossier, its history, and its drafts/layouts in this browser. It does not erase existing backups or exported files. Review retention copies separately.</p>${docs.map((d) => `<article class="finding"><h3>${esc(d.name)}</h3><button type="button" data-restore="${esc(d.id)}">Restore</button><button class="danger" type="button" data-purge="${esc(d.id)}">Permanently remove</button></article>`).join("") || "<p>Trash is empty.</p>"}`,
  );
  $("#submit-editor").hidden = true;
  $("#editor-content")
    .querySelectorAll("[data-restore]")
    .forEach(
      (button) =>
        (button.onclick = async () => {
          if (button.disabled) return;
          button.disabled = true;
          try {
            const saved = await request(
              "/api/dossiers/" + button.dataset.restore + "/restore",
              "POST",
            );
            updateSaved(saved);
            await openTrash();
          } catch (error) {
            notify(error.message, true);
            button.disabled = false;
          }
        }),
    );
  $("#editor-content")
    .querySelectorAll("[data-purge]")
    .forEach(
      (button) =>
        (button.onclick = async () => {
          if (
            button.disabled ||
            !confirm(
              "Permanently remove this dossier and its saved history? Existing backup/export files remain.",
            )
          )
            return;
          button.disabled = true;
          try {
            const id = button.dataset.purge;
            await request("/api/dossiers/" + id + "?permanent=1", "DELETE");
            clearTimeout(state.timers.get(id));
            for (const key of Object.keys(localStorage))
              if (
                key.startsWith("osint:draft:" + id + ":") ||
                key.startsWith("osint:recovery:" + id + ":") ||
                key.startsWith("osint:view:" + id + ":") ||
                (key.startsWith("osint:entry:") && key.split(":")[3] === id)
              )
                storageRemove(key);
            if (state.doc?.id === id) {
              state.doc = null;
              state.base = null;
              await load();
            }
            await openTrash();
          } catch (error) {
            notify(error.message, true);
            button.disabled = false;
          }
        }),
    );
}
function recoverDrafts() {
  const entries = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (
      key.startsWith("osint:draft:") ||
      key.startsWith("osint:recovery:") ||
      key.startsWith("osint:entry:")
    )
      entries.push({ key, value: storageGet(key) });
  }
  dialog(
    "Recoverable drafts on this device",
    `<p>Each tab keeps a separate dossier draft. Unfinished form entries are kept until saved or explicitly discarded.</p>${entries.map((e, i) => `<article class="finding"><h3>${esc(e.value?.document?.name || e.value?.label || e.value?.title || e.value?.name || e.value?.text || "Unfinished entry")}</h3><p>${e.value?.document ? "Dossier draft - based on revision " + esc(e.value.document.revision) : "Unfinished form entry"}${e.value?.savedAt ? " - " + esc(new Date(e.value.savedAt).toLocaleString()) : ""}</p><button type="button" data-recover="${i}">Resume</button><button type="button" data-export-draft="${i}">Download draft</button><button type="button" data-discard-draft="${i}">Discard</button></article>`).join("") || "<p>No unfinished drafts.</p>"}`,
  );
  $("#submit-editor").hidden = true;
  $("#editor-content")
    .querySelectorAll("[data-export-draft]")
    .forEach(
      (button) =>
        (button.onclick = () =>
          download(
            "OSINT_recovered_draft.json",
            JSON.stringify(
              entries[Number(button.dataset.exportDraft)].value.document ||
                entries[Number(button.dataset.exportDraft)].value,
              null,
              2,
            ),
            "application/json",
          )),
    );
  $("#editor-content")
    .querySelectorAll("[data-discard-draft]")
    .forEach(
      (button) =>
        (button.onclick = () => {
          if (confirm("Discard this local draft?")) {
            storageRemove(entries[Number(button.dataset.discardDraft)].key);
            recoverDrafts();
          }
        }),
    );
  $("#editor-content")
    .querySelectorAll("[data-recover]")
    .forEach(
      (button) =>
        (button.onclick = () => {
          const { key, value } = entries[Number(button.dataset.recover)];
          if (value.document) {
            state.doc = clone(value.document);
            state.base = clone(value.base);
            state.stamp = value.stamp || 1;
            persist();
            status("Recovered draft · review before saving");
            $("#editor").close();
            render();
            return;
          }
          const parts = key.split(":"),
            type = parts[2],
            docId = parts[3],
            id = parts[4];
          if (type === "dossier") return openDossier(false, docId);
          if (state.doc?.id !== docId) selectDoc(docId);
          if (!state.doc || state.doc.id !== docId)
            return notify(
              "Original dossier is missing. Download this draft and import it into a restored dossier.",
              true,
            );
          if (type === "assertion")
            openAssertion(
              id,
              Boolean(value.fromId),
              value.newUrl !== undefined,
            );
          else if (type === "source") openSource(id);
          else if (type === "entity") openEntity(id);
          else if (type === "task") openTask(id);
        }),
    );
}
async function health() {
  try {
    const value = await request("/api/health");
    state.database = value.database;
    state.backups = value.backups;
    $("#connection-status").textContent = "● Online · database reachable";
    $("#connection-status").title = value.database + " · " + value.security;
  } catch (error) {
    $("#connection-status").textContent = "○ Offline · drafts kept locally";
    $("#connection-status").title = error.message;
  }
}
async function load() {
  const [docs, cases, definitions] = await Promise.all([
    request("/api/dossiers"),
    request("/api/cases"),
    request("/api/templates"),
  ]);
  state.docs = docs;
  state.cases = cases;
  templates = definitions;
  if (!cases.some((c) => c.id === state.caseId))
    state.caseId = cases[0]?.id || "default";
  $("#case-filter").innerHTML = cases
    .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
    .join("");
  $("#case-filter").value = state.caseId;
  const candidate = docs.find((d) => d.caseId === state.caseId);
  if (candidate) selectDoc(candidate.id);
  else {
    state.doc = null;
    state.base = null;
    render();
  }
  await health();
}
$("#case-filter").onchange = async (event) => {
  const caseId = event.target.value;
  await navigate(() => {
    state.caseId = caseId;
    const doc = state.docs.find((d) => d.caseId === caseId);
    if (doc) selectDoc(doc.id);
    else {
      state.doc = null;
      state.base = null;
      render();
    }
  });
  $("#case-filter").value = state.caseId;
};
$("#case-settings").onclick = () => {
  const current = state.cases.find((c) => c.id === state.caseId);
  if (!current) return;
  const form = dialog(
    "Case settings",
    field("Case name", "name", current.name, "text", "summary") +
      field(
        "Investigation question / objective",
        "objective",
        current.objective,
        "textarea",
        "summary",
      ),
  );
  submit(form, async (data) => {
    const saved = await request("/api/cases", "POST", {
      ...data,
      id: current.id,
    });
    state.cases = state.cases.map((c) => (c.id === saved.id ? saved : c));
    $("#case-filter").selectedOptions[0].textContent = saved.name;
  });
};
$("#new-case").onclick = () => {
  const form = dialog(
    "New case",
    field("Case name", "name", "", "text", "summary") +
      field(
        "Investigation question / objective",
        "objective",
        "",
        "textarea",
        "summary",
      ),
  );
  submit(form, async (data) => {
    await saveDraft();
    const saved = await request("/api/cases", "POST", data);
    state.cases.push(saved);
    state.caseId = saved.id;
    await load();
  });
};
$("#new").onclick = $("#empty-new").onclick = () => openDossier();
$("#rename").onclick = () => openDossier(true);
$("#capture").onclick = () => openAssertion(null, false, true);
$("#save-now").onclick = () => saveDraft().catch(() => {});
$("#search").oninput = renderNav;
$(".tabs")
  .querySelectorAll("button")
  .forEach(
    (button) =>
      (button.onclick = () => {
        state.tab = button.dataset.tab;
        state.allAssertions = false;
        state.openOnly = false;
        state.reviewFilter = "all";
        renderContent();
      }),
  );
$("#export").onclick = () => navigate(() => openExport());
$("#workspace-tools").onclick = workspaceTools;
$("#trash").onclick = () =>
  openTrash().catch((error) => notify(error.message, true));
$("#drafts").onclick = recoverDrafts;
$("#delete-dossier").onclick = async () => {
  if (!confirm("Move this dossier to Trash? You can restore it.")) return;
  try {
    await saveDraft();
    const id = state.doc.id;
    await request(
      "/api/dossiers/" + id + "?revision=" + state.doc.revision,
      "DELETE",
    );
    storageRemove(draftKey(id));
    state.doc = null;
    state.base = null;
    await load();
    notify("Moved to Trash. Saved history remains recoverable.");
  } catch (error) {
    notify(error.message, true);
  }
};
$("#import").onclick = () => $("#import-file").click();
$("#import-file").onchange = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 30_000_000) throw Error("Dossier import limit is 30 MB.");
    const migrated = await request(
      "/api/import/preview",
      "POST",
      JSON.parse(await file.text()),
    );
    const form = dialog(
      "Import preview",
      `<p>${esc(migrated.name)} · ${migrated.assertions.length} assertions · ${migrated.sources.length} sources. A new copy is created in this case; existing dossiers are unchanged.</p>${(migrated.warnings || []).map((w) => `<p>${esc(w)}</p>`).join("")}`,
      "",
      "Import new copy",
    );
    submit(form, async () => {
      await saveDraft();
      const oldId = migrated.id;
      migrated.id = uid();
      migrated.revision = 0;
      migrated.caseId = state.caseId;
      const sourceMap = new Map(migrated.sources.map((s) => [s.id, uid()]));
      for (const source of migrated.sources)
        source.id = sourceMap.get(source.id);
      for (const a of migrated.assertions)
        a.sourceIds = a.sourceIds.map((id) => sourceMap.get(id));
      const map = new Map(migrated.entities.map((e) => [e.id, uid()]));
      migrated.subjectId = map.get(migrated.subjectId);
      for (const e of migrated.entities) {
        e.id = map.get(e.id);
        if (e.dossierId === oldId) e.dossierId = migrated.id;
      }
      for (const a of migrated.assertions)
        for (const key of ["entityId", "fromId", "toId"])
          if (a[key]) a[key] = map.get(a[key]);
      const saved = await request("/api/dossiers", "POST", migrated);
      updateSaved(saved);
      selectDoc(saved.id);
    });
  } catch (error) {
    notify("Import rejected: " + error.message, true);
  } finally {
    event.target.value = "";
  }
};
$("#restore-file").onchange = (event) => {
  const file = event.target.files[0];
  if (file) inspectRestore(file).catch((error) => notify(error.message, true));
  event.target.value = "";
};
$("#relationship-graph")?.addEventListener("graph-open-record", () => {});
load().catch((error) => notify(error.message, true));
setInterval(health, 15000);

if ((globalThis as any).__OSINT_TEST__)
  Object.assign(window, {
    qa: {
      state,
      edit,
      saveDraft,
      dirty,
      threeWay,
      scopedDossier,
      reportText,
      openAssertion,
      openSource,
      dialog,
      showConflict,
      showModules,
      renderContent,
      renderHeader,
      selectDoc,
      buildGraph,
      mountGraph,
      nextRef,
      recoverDrafts,
      encryptBackup,
      decryptBackup,
    },
  });

$(".tabs").addEventListener("keydown", (event: KeyboardEvent) => {
  const tabs = [
    ...$(".tabs").querySelectorAll("button"),
  ] as HTMLButtonElement[];
  const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (
    index < 0 ||
    !["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)
  )
    return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
          tabs.length;
  tabs[next].click();
  tabs[next].focus();
});
$("#capture").title = "Capture a fact and its source ? Ctrl+Shift+K";
window.addEventListener("keydown", (event) => {
  if (
    event.ctrlKey &&
    event.shiftKey &&
    event.key.toLowerCase() === "k" &&
    state.doc &&
    !$("#editor").open &&
    !$("#conflict-dialog").open
  ) {
    event.preventDefault();
    openAssertion(null, false, true);
  }
});
