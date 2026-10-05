import type { Dossier, EntityType } from "../shared/model";
export interface GraphRecord {
  kind: string;
  id: string;
  dossierId: string;
  dossierName?: string;
}
export interface GraphNode {
  id: string;
  label: string;
  type: EntityType | "source" | "assertion";
  properties: Record<string, string>;
  records: GraphRecord[];
  record: GraphRecord;
}
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  kind: string;
  assertions?: { id: string; properties: Record<string, string> }[];
  records?: GraphRecord[];
}
export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  subjectId: string;
}
export interface GraphView {
  positions?: Record<string, { x: number; y: number }>;
  collapsed?: string[];
  manual?: string[];
  neighborLimit?: number;
  selected?: string;
  query?: string;
  type?: string;
  evidence?: boolean;
  neighborhood?: boolean;
  expanded?: string[];
  camera?: { x: number; y: number; scale: number };
  details?: boolean;
}
export interface GraphOptions {
  view?: GraphView;
  onView?: (view: GraphView) => void;
  onOpen?: (record: GraphRecord) => void;
}
/* Names are labels; stable IDs are identities. No inferred connections. */
export function buildGraph(docs: Dossier[], subjectId: string): GraphModel {
  const nodes: GraphNode[] = [],
    edges: GraphEdge[] = [],
    byId = new Map<string, GraphNode>(),
    links = new Map<string, GraphEdge>();
  const add = (n: GraphNode) => {
    if (!byId.has(n.id)) {
      nodes.push(n);
      byId.set(n.id, n);
    }
    return byId.get(n.id);
  };
  const sourceNodeId = (doc: Dossier, s: Dossier["sources"][number]) => {
    if (s.url) {
      try {
        const u = new URL(s.url);
        return (
          "source-url:" + u.origin + u.pathname.replace(/\/+$/, "") + u.search
        );
      } catch {}
    }
    return `source:${doc.caseId}:${s.id}`;
  };
  for (const doc of docs) {
    for (const e of doc.entities) {
      const n = add({
        id: e.id,
        label: e.name,
        type: e.type,
        properties: { Type: e.type, Aliases: e.aliases, Details: e.details },
        records: [],
        record: { kind: "entity", id: e.id, dossierId: e.dossierId || doc.id },
      });
      if (e.id === doc.subjectId) {
        n.label = e.name;
        n.type = e.type;
        n.properties = { Type: e.type, Aliases: e.aliases, Details: e.details };
        n.record = { kind: "entity", id: e.id, dossierId: doc.id };
      }
    }
    const root = byId.get(doc.subjectId);
    if (root) {
      if (doc.notes) root.properties["Working notes · internal"] = doc.notes;
      if (doc.summary) root.properties["Conclusion narrative"] = doc.summary;
      if (doc.tasks?.length)
        root.properties["Next research steps"] = doc.tasks
          .map(
            (t) =>
              (t.done ? "[done] " : "[open] ") +
              t.text +
              (t.due ? " · due " + t.due : ""),
          )
          .join("\n");
      if (doc.conclusionIds?.length)
        root.properties["Supporting conclusion records"] = doc.conclusionIds
          .map((id) => doc.assertions.find((a) => a.id === id))
          .filter(Boolean)
          .map((a) => a.label + " · " + a.classification)
          .join("\n");
    }
    for (const s of doc.sources) {
      const record = {
        kind: "source",
        id: s.id,
        dossierId: doc.id,
        dossierName: doc.name,
      };
      const n = add({
        id: sourceNodeId(doc, s),
        label: s.title,
        type: "source",
        properties: {
          Title: s.title,
          Publisher: s.publisher,
          URL: s.url,
          Published: s.published,
          Archive: s.archiveUrl,
        },
        records: [],
        record,
      });
      n.records.push(record);
      n.properties["Reference · " + doc.name] =
        s.ref +
        " · checked " +
        (s.accessed || "unknown") +
        " · quality " +
        s.quality;
      if (s.notes) n.properties["Internal notes · " + doc.name] = s.notes;
    }
    for (const a of doc.assertions) {
      const id = `assertion:${doc.id}:${a.id}`,
        record = { kind: "assertion", id: a.id, dossierId: doc.id };
      const properties = {
        Value: a.knowledge === "known" ? a.value : a.knowledge,
        Confidence: a.classification,
        Review: a.verification,
        Evidence: a.evidence,
        Justification: a.justification,
        Event: a.eventDate,
        Collected: a.collected,
        Published: a.publicationDate,
        Sources:
          a.sourceIds
            .map((s) => doc.sources.find((x) => x.id === s)?.ref)
            .join(", ") || "None linked",
      };
      add({
        id,
        label: a.label,
        type: "assertion",
        properties,
        records: [record],
        record,
      });
      byId.get(a.entityId)?.records.push(record);
      if (a.kind === "relationship") {
        const key = JSON.stringify([
          a.fromId,
          a.toId,
          a.relationship.trim().toLowerCase(),
        ]);
        let edge = links.get(key);
        if (!edge) {
          edge = {
            id: "relationship:" + id,
            from: a.fromId,
            to: a.toId,
            label: a.relationship,
            kind: "relationship",
            assertions: [],
            records: [],
          };
          links.set(key, edge);
          edges.push(edge);
        }
        edge.assertions.push({ id, properties });
        edge.records.push(record);
        edges.push(
          {
            id: "subject:" + id,
            from: a.fromId,
            to: id,
            label: "relationship claim",
            kind: "record",
          },
          {
            id: "endpoint:" + id,
            from: id,
            to: a.toId,
            label: a.relationship,
            kind: "record",
          },
        );
      } else
        edges.push({
          id: "fact:" + id,
          from: a.entityId,
          to: id,
          label: "recorded fact",
          kind: "record",
        });
      for (const s of a.sourceIds) {
        const source = doc.sources.find((record) => record.id === s);
        if (source)
          edges.push({
            id: "evidence:" + id + ":" + s,
            from: id,
            to: sourceNodeId(doc, source),
            label: "supported by",
            kind: "evidence",
          });
      }
    }
  }
  return { nodes, edges, subjectId };
}
/* Self-contained for offline HTML exports. Keyed SVG nodes preserve focus. */
export function mountGraph(
  host: HTMLElement,
  model: GraphModel,
  options: GraphOptions = {},
) {
  const escape = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const NS = "http://www.w3.org/2000/svg",
    colors = {
      person: "#a6c4b1",
      organization: "#c9b08a",
      account: "#adc9d2",
      domain: "#b8c792",
      project: "#c0acc5",
      entity: "#bac2ba",
      assertion: "#d6dcd0",
      source: "#e3cd9a",
    };
  const byId = new Map(model.nodes.map((n) => [n.id, n])),
    view = options.view || {},
    positions = { ...(view.positions || {}) };
  const collapsed = new Set(view.collapsed || []),
    manual = new Set(view.manual || Object.keys(view.positions || {}));
  let layoutSignature = "";
  let neighborLimit = view.neighborLimit || 40;
  let selected = byId.has(view.selected) ? view.selected : model.subjectId,
    query = view.query || "",
    type = view.type || "all",
    evidence = !!view.evidence,
    neighborhood =
      view.neighborhood ??
      model.nodes.filter((n) => !["source", "assertion"].includes(n.type))
        .length > 30,
    expanded = new Set(view.expanded || [model.subjectId]),
    camera = view.camera || null,
    visible = [],
    shownEdges = [],
    destroyed = false,
    drag = null,
    details = view.details !== false;
  host.innerHTML = `<div class="graph-toolbar"><label class="graph-search-label">Search names, facts, or relationship labels<input type="search" data-graph="search" value="${escape(query)}" placeholder="Search map and keep connected context"></label><label>Type<select data-graph="type"><option value="all">All types</option>${Object.keys(
    colors,
  )
    .filter((k) => !["source", "assertion"].includes(k))
    .map((k) => `<option value="${k}">${k}</option>`)
    .join(
      "",
    )}</select></label><div class="graph-toolbar-actions"><button data-graph="evidence" aria-pressed="${evidence}">Evidence records</button><button data-graph="neighborhood" aria-pressed="${neighborhood}">Selected neighborhood</button><button data-graph="all">Show all / expand</button><button data-graph="more">More neighbors</button><button data-graph="fit">Fit visible</button><button data-graph="details" aria-pressed="${details}">Details</button><button data-graph="fullscreen" aria-pressed="false">Full screen</button></div></div><div class="graph-body"><div class="graph-canvas"><svg role="group" aria-label="Interactive relationship map"><defs><marker id="arrow-${escape(model.subjectId)}" markerWidth="8" markerHeight="8" refX="22" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L8,4 L0,8" fill="#6d89ac"/></marker></defs><g data-layer="camera"><g data-layer="edges"></g><g data-layer="nodes"></g></g></svg><div class="graph-zoom"><button data-graph="in" aria-label="Zoom in">+</button><button data-graph="out" aria-label="Zoom out">−</button></div><div class="graph-legend">${Object.entries(
    colors,
  )
    .filter(([type]) => !["source", "assertion"].includes(type))
    .map(
      ([type, color]) =>
        `<span><i style="background:${color}"></i>${type}</span>`,
    )
    .join(
      "",
    )}</div><div class="graph-caption">Drag node to arrange · drag background to pan · wheel to zoom · Enter for details</div></div><aside class="graph-inspector" aria-label="Map details"></aside></div><div class="graph-status" aria-live="polite"></div><details class="graph-accessible"><summary>Accessible record list / keyboard navigation</summary><div data-graph="list"></div></details>`;
  const find = (s: string): any => host.querySelector(s),
    svg = find("svg"),
    layer = find('[data-layer="camera"]'),
    nodeLayer = find('[data-layer="nodes"]'),
    edgeLayer = find('[data-layer="edges"]'),
    inspector = find(".graph-inspector"),
    elements = new Map(),
    edgeElements = new Map();
  find('[data-graph="type"]').value = type;
  host.classList.toggle("graph-details-hidden", !details);
  function dimensions() {
    return { w: svg.clientWidth || 900, h: svg.clientHeight || 620 };
  }
  function emit() {
    if (!destroyed)
      options.onView?.({
        positions,
        selected,
        query,
        type,
        evidence,
        neighborhood,
        expanded: [...expanded],
        collapsed: [...collapsed],
        manual: [...manual],
        neighborLimit,
        camera,
        details,
      });
  }
  function neighbors(id, edges = model.edges) {
    return new Set(
      edges.flatMap((e) =>
        e.from === id ? [e.to] : e.to === id ? [e.from] : [],
      ),
    );
  }
  function filter() {
    const allowed = new Set(
      model.nodes
        .filter((n) => evidence || !["source", "assertion"].includes(n.type))
        .map((n) => n.id),
    );
    let ids = new Set(allowed);
    if (neighborhood) {
      ids = new Set([selected, ...expanded]);
      for (const id of expanded)
        if (!collapsed.has(id))
          for (const adjacent of [...neighbors(id)]
            .filter((id) => allowed.has(id))
            .slice(0, neighborLimit))
            ids.add(adjacent);
      if (!collapsed.has(selected))
        for (const adjacent of [...neighbors(selected)]
          .filter((id) => allowed.has(id))
          .slice(0, neighborLimit))
          ids.add(adjacent);
    }
    if (query.trim()) {
      const q = query.toLowerCase(),
        matched = new Set(
          model.nodes
            .filter((n) =>
              (n.label + " " + JSON.stringify(n.properties))
                .toLowerCase()
                .includes(q),
            )
            .map((n) => n.id),
        );
      ids = new Set(matched);
      for (const e of model.edges)
        if (e.label.toLowerCase().includes(q)) {
          ids.add(e.from);
          ids.add(e.to);
        }
      for (const id of matched) {
        for (const adjacent of neighbors(id)) {
          ids.add(adjacent);
          if (byId.get(id)?.type === "source")
            for (const endpoint of neighbors(adjacent))
              if (!["source", "assertion"].includes(byId.get(endpoint)?.type))
                ids.add(endpoint);
        }
        if (["source", "assertion"].includes(byId.get(id)?.type)) {
          allowed.add(id);
          for (const adjacent of neighbors(id)) allowed.add(adjacent);
        }
      }
    }
    if (type !== "all") {
      const matched = new Set(
        [...ids].filter((id) => byId.get(id)?.type === type),
      );
      ids = new Set(matched);
      for (const id of matched)
        for (const adjacent of neighbors(id)) ids.add(adjacent);
    }
    visible = model.nodes.filter((n) => allowed.has(n.id) && ids.has(n.id));
    const shown = new Set(visible.map((n) => n.id));
    shownEdges = model.edges.filter(
      (e) =>
        shown.has(e.from) &&
        shown.has(e.to) &&
        (evidence || e.kind === "relationship" || query.trim()),
    );
    const signature = query + "|" + visible.map((n) => n.id).join("|");
    if (query.trim() && visible.length <= 20 && signature !== layoutSignature) {
      const tiers = [
          visible.filter((n) => !["assertion", "source"].includes(n.type)),
          visible.filter((n) => n.type === "assertion"),
          visible.filter((n) => n.type === "source"),
        ],
        cols = Math.max(
          1,
          Math.ceil(Math.sqrt(Math.max(...tiers.map((t) => t.length)))),
        );
      for (const [tier, items] of tiers.entries())
        for (const [index, n] of items.entries())
          if (!manual.has(n.id))
            positions[n.id] = {
              x:
                (index % cols) * 300 +
                (cols - Math.min(items.length, cols)) * 150,
              y: tier * 230 + Math.floor(index / cols) * 120,
            };
      layoutSignature = signature;
    }
    const ordered = [...model.nodes].sort(
        (a, b) =>
          Number(["source", "assertion"].includes(a.type)) -
          Number(["source", "assertion"].includes(b.type)),
      ),
      cols = Math.ceil(
        Math.sqrt(
          ordered.filter((n) => !["source", "assertion"].includes(n.type))
            .length || 1,
        ),
      );
    // A subject-centred constellation prevents small graphs from placing
    // several identities directly on top of another connection's line.
    const identities = ordered.filter(
      (n) => !["source", "assertion"].includes(n.type),
    );
    const constellation = identities.length <= 24;
    const groups = [
      identities.filter((n) => n.id !== model.subjectId),
      ordered.filter((n) => n.type === "assertion"),
      ordered.filter((n) => n.type === "source"),
    ];
    const defaults = new Map<string, { x: number; y: number }>([
      [model.subjectId, { x: 0, y: 0 }],
    ]);
    if (constellation)
      for (const [tier, group] of groups.entries()) {
        const radius = Math.max(250 + tier * 280, group.length * 42);
        group.forEach((n, i) => {
          const angle =
            -Math.PI / 2 + (i * Math.PI * 2) / Math.max(1, group.length);
          defaults.set(n.id, {
            x: Math.cos(angle) * radius,
            y: Math.sin(angle) * radius,
          });
        });
      }
    for (const [i, n] of ordered.entries())
      if (
        !positions[n.id] ||
        !Number.isFinite(positions[n.id].x) ||
        !Number.isFinite(positions[n.id].y)
      )
        positions[n.id] = constellation
          ? defaults.get(n.id)!
          : {
              x: (i % cols) * 220,
              y: Math.floor(i / cols) * 130,
            };
  }
  function create(tag, attributes = {}, text?: string) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attributes)) el.setAttribute(k, v);
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function activate(id) {
    selected = id;
    draw();
    inspect();
    emit();
  }
  function draw() {
    filter();
    const ids = new Set(visible.map((n) => n.id)),
      edgeIds = new Set(shownEdges.map((e) => e.id));
    for (const [id, el] of elements)
      el.style.display = ids.has(id) ? "" : "none";
    for (const [id, el] of edgeElements)
      el.style.display = edgeIds.has(id) ? "" : "none";
    const pairs = new Map();
    for (const edge of shownEdges) {
      const pair = [edge.from, edge.to].sort().join("|");
      if (!pairs.has(pair)) pairs.set(pair, []);
      pairs.get(pair).push(edge);
    }
    for (const edge of shownEdges) {
      let el = edgeElements.get(edge.id);
      if (!el) {
        el = create("g", {
          class: "graph-edge",
          tabindex: "0",
          role: "button",
          "aria-label": edge.label,
        });
        el.append(
          create("path", {
            "marker-end": `url(#arrow-${model.subjectId})`,
            fill: "none",
          }),
          create("text", { "text-anchor": "middle" }),
        );
        el.addEventListener("click", () => inspectEdge(edge));
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inspectEdge(edge);
          }
        });
        edgeLayer.append(el);
        edgeElements.set(edge.id, el);
      }
      el.style.display = "";
      const assessments = (edge.assertions || []).map((a) => a.properties);
      el.classList.toggle(
        "uncertain",
        assessments.some(
          (a) =>
            a.Review !== "reviewed" ||
            !["CONFIRMED", "CORROBORATED"].includes(a.Confidence),
        ),
      );
      el.classList.toggle(
        "contradicted",
        assessments.some((a) => a.Confidence === "CONTRADICTED"),
      );
      const a = positions[edge.from],
        b = positions[edge.to],
        pair = pairs.get([edge.from, edge.to].sort().join("|")),
        i = pair.indexOf(edge),
        offset = (i - (pair.length - 1) / 2) * 42,
        dx = b.x - a.x,
        dy = b.y - a.y,
        length = Math.hypot(dx, dy) || 1,
        cx = (a.x + b.x) / 2 - (dy / length) * offset,
        cy = (a.y + b.y) / 2 + (dx / length) * offset;
      el.children[0].setAttribute(
        "d",
        edge.from === edge.to
          ? `M${a.x},${a.y} C${a.x + 100},${a.y - 100} ${a.x - 100},${a.y - 100} ${a.x},${a.y}`
          : `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`,
      );
      el.children[1].setAttribute("x", cx);
      el.children[1].setAttribute("y", cy - 8);
      el.children[1].textContent =
        edge.label +
        (edge.records?.length > 1 ? ` (${edge.records.length} records)` : "");
    }
    for (const n of visible) {
      let el = elements.get(n.id);
      if (!el) {
        el = create("g", {
          class: "graph-node",
          tabindex: "0",
          role: "button",
          "aria-label": n.label + " · " + n.type,
        });
        el.append(
          create("circle", { r: 27, class: "node-halo" }),
          create("circle", { r: 20, fill: colors[n.type] || colors.entity }),
          create(
            "text",
            { class: "node-symbol", x: 0, y: 6, "text-anchor": "middle" },
            {
              person: "P",
              organization: "O",
              account: "@",
              domain: "D",
              project: "J",
              source: "S",
              assertion: "F",
            }[n.type] || "E",
          ),
          create(
            "text",
            { class: "node-label", x: 0, y: 42, "text-anchor": "middle" },
            n.label.length > 32 ? n.label.slice(0, 29) + "…" : n.label,
          ),
          create("title", {}, n.label),
        );
        el.addEventListener("click", () => activate(n.id));
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate(n.id);
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            collapsed.delete(n.id);
            expanded.add(n.id);
            draw();
            emit();
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            collapsed.add(n.id);
            expanded.delete(n.id);
            draw();
            emit();
          }
        });
        el.addEventListener("pointerdown", (e) => {
          e.stopPropagation();
          drag = {
            id: n.id,
            x: e.clientX,
            y: e.clientY,
            start: { ...positions[n.id] },
          };
          svg.setPointerCapture?.(e.pointerId);
        });
        nodeLayer.append(el);
        elements.set(n.id, el);
      }
      el.style.display = "";
      el.setAttribute(
        "transform",
        `translate(${positions[n.id].x},${positions[n.id].y})`,
      );
      el.classList.toggle("selected", selected === n.id);
    }
    if (!camera) fit(false);
    transform();
    find(".graph-status").textContent =
      `${visible.length} visible nodes - ${visible.filter((n) => !["source", "assertion"].includes(n.type)).length} of ${model.nodes.filter((n) => !["source", "assertion"].includes(n.type)).length} identities · ${shownEdges.length} visible edges · ${neighborhood ? "neighborhood" : "whole map"}${visible.length > 80 ? " · Dense map: use a selected neighborhood for readable labels" : ""}`;
    const list = find('[data-graph="list"]');
    list.innerHTML = "";
    for (const n of visible) {
      const b = document.createElement("button");
      b.textContent = n.label + " · " + n.type;
      b.onclick = () => {
        activate(n.id);
        elements.get(n.id)?.focus();
      };
      list.append(b);
    }
  }
  function transform() {
    layer.setAttribute(
      "transform",
      `translate(${camera.x},${camera.y}) scale(${camera.scale})`,
    );
    const dense = visible.length > 80;
    for (const n of visible) {
      const el = elements.get(n.id);
      if (!el) continue;
      const radius = Math.max(
        20,
        (dense && n.id !== selected ? 4 : 12) / camera.scale,
      );
      el.children[0].setAttribute("r", radius + 5 / camera.scale);
      el.children[1].setAttribute("r", radius);
      el.children[2].style.fontSize = Math.max(16, 12 / camera.scale) + "px";
      el.children[2].setAttribute("y", Math.max(6, 4 / camera.scale));
      el.children[2].style.display =
        dense && camera.scale < 0.4 && n.id !== selected ? "none" : "";
      const label = el.children[3];
      const font = Math.max(12, 11 / camera.scale);
      label.style.fontSize = font + "px";
      label.setAttribute("y", radius + 15 / camera.scale);
      const limit = dimensions().w < 700 ? 14 : 28,
        words = n.label.split(" "),
        lines = [""];
      for (const word of words) {
        if ((lines.at(-1) + " " + word).trim().length > limit && lines.at(-1))
          lines.push("");
        lines[lines.length - 1] += (lines.at(-1) ? " " : "") + word;
      }
      label.textContent = "";
      for (const [i, line] of lines.slice(0, 2).entries()) {
        const part = create(
          "tspan",
          { x: 0, dy: i ? font * 1.25 : 0 },
          line.length > limit
            ? line.slice(0, limit - 1) + "?"
            : line + (i === 1 && lines.length > 2 ? "?" : ""),
        );
        label.append(part);
      }
      label.style.display =
        dense && camera.scale < 0.4 && n.id !== selected ? "none" : "";
    }
    for (const el of edgeElements.values()) {
      el.children[0].setAttribute("vector-effect", "non-scaling-stroke");
      el.children[1].style.fontSize = Math.max(9, 9 / camera.scale) + "px";
      el.children[1].style.display = dense && camera.scale < 0.4 ? "none" : "";
    }
  }
  function fit(save = true) {
    const { w, h } = dimensions();
    if (!visible.length) {
      camera = { x: w / 2, y: h / 2, scale: 1 };
      transform();
      if (save) emit();
      return;
    }
    const p = visible.map((n) => positions[n.id]),
      minX = Math.min(...p.map((p) => p.x)) - 100,
      maxX = Math.max(...p.map((p) => p.x)) + 100,
      minY = Math.min(...p.map((p) => p.y)) - 80,
      maxY = Math.max(...p.map((p) => p.y)) + 80,
      scale = Math.min(1.3, (w - 60) / (maxX - minX), (h - 60) / (maxY - minY));
    camera = {
      x: w / 2 - ((minX + maxX) / 2) * scale,
      y: h / 2 - ((minY + maxY) / 2) * scale,
      scale: Math.max(0.0001, scale),
    };
    transform();
    if (save) emit();
  }
  function zoom(factor: number, x?: number, y?: number) {
    const { w, h } = dimensions();
    x = x ?? w / 2;
    y = y ?? h / 2;
    const scale = Math.max(0.0001, Math.min(6, camera.scale * factor)),
      ratio = scale / camera.scale;
    camera = {
      x: x - (x - camera.x) * ratio,
      y: y - (y - camera.y) * ratio,
      scale,
    };
    transform();
    emit();
  }
  function properties(p) {
    return `<dl>${Object.entries(p)
      .filter(([, v]) => v !== "" && v !== undefined)
      .map(
        ([k, v]) =>
          `<div class="graph-property"><dt>${escape(k)}</dt><dd>${/^https?:\/\//.test(String(v)) ? `<a href="${escape(v)}" target="_blank" rel="noopener noreferrer">${escape(v)}</a>` : escape(v)}</dd></div>`,
      )
      .join("")}</dl>`;
  }
  function openButtons(records) {
    if (!options.onOpen) return "";
    return records
      .map(
        (r, i) =>
          `<button data-open="${i}">${r.kind === "entity" ? "Open / edit identity" : r.kind === "source" ? "Edit source - " + escape(r.dossierName || "source record") : "Edit: " + escape(byId.get("assertion:" + r.dossierId + ":" + r.id)?.label || "assertion")}</button>`,
      )
      .join("");
  }
  function bindOpen(records) {
    inspector
      .querySelectorAll("[data-open]")
      .forEach(
        (b) =>
          (b.onclick = () => options.onOpen?.(records[Number(b.dataset.open)])),
      );
  }
  function inspect() {
    const n = byId.get(selected);
    if (!n) return;
    const records = (n.type === "source" ? n.records : [n.record]).filter(
      Boolean,
    );
    inspector.innerHTML = `<span class="inspector-kicker">${escape(n.type)}</span><h3>${escape(n.label)}</h3><div class="inspector-actions">${openButtons(records)}<button data-expand>Expand neighbors</button><button data-collapse>Collapse neighbors</button></div>${properties(n.properties)}<h4>Connected records</h4><div class="inspector-connections"></div>`;
    bindOpen(records);
    inspector.querySelector("[data-expand]").onclick = () => {
      collapsed.delete(n.id);
      expanded.add(n.id);
      neighborhood = true;
      find('[data-graph="neighborhood"]').setAttribute("aria-pressed", "true");
      draw();
      emit();
    };
    inspector.querySelector("[data-collapse]").onclick = () => {
      collapsed.add(n.id);
      expanded.delete(n.id);
      neighborhood = true;
      draw();
      emit();
    };
    const list = inspector.querySelector(".inspector-connections");
    for (const e of model.edges.filter(
      (e) => e.from === n.id || e.to === n.id,
    )) {
      const other = byId.get(e.from === n.id ? e.to : e.from);
      if (!other) continue;
      const b = document.createElement("button");
      b.textContent = e.label + " → " + other.label;
      b.onclick = () => {
        if (["source", "assertion"].includes(other.type)) {
          evidence = true;
          find('[data-graph="evidence"]').setAttribute("aria-pressed", "true");
        }
        collapsed.delete(n.id);
        expanded.add(n.id);
        activate(other.id);
      };
      list.append(b);
    }
  }
  function inspectEdge(edge) {
    inspector.innerHTML = `<span class="inspector-kicker">Recorded relationship</span><h3>${escape(byId.get(edge.from)?.label)} → ${escape(edge.label)} → ${escape(byId.get(edge.to)?.label)}</h3><p>${edge.records?.length || 1} underlying record(s). Each retains its own evidence and confidence.</p><div class="inspector-actions">${openButtons(edge.records || [])}</div>${(edge.assertions || []).map((a) => properties(a.properties)).join("")}`;
    bindOpen(edge.records || []);
  }
  async function full() {
    if (host.classList.contains("graph-expanded")) {
      if (document.fullscreenElement === host)
        await document.exitFullscreen?.();
      host.classList.remove("graph-expanded");
    } else {
      host.classList.add("graph-expanded");
      try {
        await host.requestFullscreen?.();
      } catch {}
    }
    find('[data-graph="fullscreen"]').setAttribute(
      "aria-pressed",
      host.classList.contains("graph-expanded"),
    );
    find('[data-graph="fullscreen"]').textContent = host.classList.contains(
      "graph-expanded",
    )
      ? "Exit full screen"
      : "Full screen";
    fit();
  }
  async function onKey(e) {
    if (e.key === "Escape" && host.classList.contains("graph-expanded")) {
      if (document.fullscreenElement === host)
        try {
          await document.exitFullscreen?.();
        } catch {}
      host.classList.remove("graph-expanded");
      find('[data-graph="fullscreen"]').setAttribute("aria-pressed", "false");
      find('[data-graph="fullscreen"]').textContent = "Full screen";
      fit();
    }
  }
  function onFullscreen() {
    if (!document.fullscreenElement) {
      host.classList.remove("graph-expanded");
      find('[data-graph="fullscreen"]').textContent = "Full screen";
      find('[data-graph="fullscreen"]').setAttribute("aria-pressed", "false");
      fit();
    }
  }
  document.addEventListener("keydown", onKey);
  document.addEventListener("fullscreenchange", onFullscreen);
  find('[data-graph="search"]').oninput = (e) => {
    query = e.target.value;
    draw();
    fit();
    emit();
  };
  find('[data-graph="type"]').onchange = (e) => {
    type = e.target.value;
    draw();
    fit();
    emit();
  };
  for (const key of ["evidence", "neighborhood", "details"])
    find(`[data-graph="${key}"]`).onclick = () => {
      if (key === "evidence") evidence = !evidence;
      if (key === "neighborhood") neighborhood = !neighborhood;
      if (key === "details") {
        details = !details;
        host.classList.toggle("graph-details-hidden", !details);
      }
      find(`[data-graph="${key}"]`).setAttribute(
        "aria-pressed",
        key === "evidence"
          ? evidence
          : key === "neighborhood"
            ? neighborhood
            : details,
      );
      draw();
      fit();
      emit();
    };
  find('[data-graph="more"]').onclick = () => {
    neighborLimit += 40;
    neighborhood = true;
    find('[data-graph="neighborhood"]').setAttribute("aria-pressed", "true");
    draw();
    fit();
    emit();
  };
  find('[data-graph="all"]').onclick = () => {
    neighborhood = false;
    query = "";
    type = "all";
    find('[data-graph="search"]').value = "";
    find('[data-graph="type"]').value = "all";
    find('[data-graph="neighborhood"]').setAttribute("aria-pressed", "false");
    draw();
    fit();
    emit();
  };
  find('[data-graph="fit"]').onclick = () => fit();
  find('[data-graph="in"]').onclick = () => zoom(1.25);
  find('[data-graph="out"]').onclick = () => zoom(0.8);
  find('[data-graph="fullscreen"]').onclick = full;
  svg.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      zoom(
        e.deltaY < 0 ? 1.12 : 0.89,
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
    },
    { passive: false },
  );
  svg.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".graph-node,.graph-edge")) return;
    drag = { x: e.clientX, y: e.clientY, start: { ...camera } };
    svg.setPointerCapture?.(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x,
      dy = e.clientY - drag.y;
    if (drag.id) {
      manual.add(drag.id);
      positions[drag.id] = {
        x: drag.start.x + dx / camera.scale,
        y: drag.start.y + dy / camera.scale,
      };
      draw();
    } else {
      camera.x = drag.start.x + dx;
      camera.y = drag.start.y + dy;
      transform();
    }
  });
  svg.addEventListener("pointerup", () => {
    drag = null;
    emit();
  });
  svg.addEventListener("pointercancel", () => {
    drag = null;
    emit();
  });
  let lastSize = dimensions();
  const observer =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          if (destroyed) return;
          const size = dimensions();
          if (size.w !== lastSize.w || size.h !== lastSize.h) {
            camera.x += (size.w - lastSize.w) / 2;
            camera.y += (size.h - lastSize.h) / 2;
            lastSize = size;
            transform();
            emit();
          }
        })
      : null;
  observer?.observe(svg);
  draw();
  inspect();
  emit();
  return {
    destroy() {
      destroyed = true;
      observer?.disconnect();
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFullscreen);
      if (document.fullscreenElement === host) document.exitFullscreen?.();
      host.classList.remove("graph-expanded");
    },
    getView() {
      return {
        positions,
        selected,
        query,
        type,
        evidence,
        neighborhood,
        expanded: [...expanded],
        collapsed: [...collapsed],
        manual: [...manual],
        neighborLimit,
        camera,
        details,
      };
    },
    fit,
  };
}

Object.assign(window, { buildGraph, mountGraph });
