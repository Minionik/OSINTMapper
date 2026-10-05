import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
const root = path.join(__dirname, "..");
const sample = JSON.parse(
  fs.readFileSync(path.join(root, "examples/sample-person.json"), "utf8"),
);
const copy = (v) => structuredClone(v);
const tick = () => new Promise((r) => setTimeout(r, 0));
async function setup() {
  const dom = new JSDOM(
    fs.readFileSync(path.join(root, "static/index.html"), "utf8"),
    {
      url: "http://127.0.0.1:8765",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const w: any = dom.window;
  w.__OSINT_TEST__ = true;
  w.structuredClone = copy;
  Object.defineProperty(w, "crypto", { value: webcrypto });
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  w.confirm = () => true;
  let doc = {
      ...copy(sample),
      revision: 1,
      created: "2026-10-04T12:00:00Z",
      updated: "2026-10-04T12:00:00Z",
    },
    writes = 0,
    onWrite = null;
  w.fetch = async (url, opts = {}) => {
    let value,
      status = 200;
    if (url === "/api/dossiers" && opts.method === "POST") {
      writes++;
      const incoming = JSON.parse(opts.body);
      if (onWrite) return onWrite(incoming);
      doc = { ...incoming, revision: doc.revision + 1 };
      delete doc.action;
      value = copy(doc);
    } else if (url === "/api/dossiers") value = [copy(doc)];
    else if (url === "/api/cases")
      value = [
        {
          id: "default",
          name: "General research",
          objective: "Demo objective",
        },
      ];
    else if (url === "/api/templates")
      value = { person: { sections: [] }, organization: { sections: [] } };
    else if (url === "/api/health")
      value = { status: "online", database: "temporary", security: "test" };
    else value = [];
    return { ok: status === 200, status, json: async () => value };
  };
  w.eval(fs.readFileSync(path.join(root, "dist/public/graph.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(root, "dist/public/app.js"), "utf8"));
  await tick();
  await tick();
  return {
    w,
    qa: w.qa,
    close: () => w.close(),
    get saved() {
      return doc;
    },
    get writes() {
      return writes;
    },
    set onWrite(handler) {
      onWrite = handler;
    },
  };
}
test("delayed save never discards edits typed during the request", async () => {
  const env = await setup();
  try {
    let release;
    env.onWrite = async (incoming) =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            ok: true,
            status: 200,
            json: async () => ({ ...incoming, revision: 2 }),
          });
      });
    env.qa.edit((d) => (d.notes = "first"));
    const pending = env.qa.saveDraft();
    env.qa.edit((d) => (d.notes = "newer typed value"));
    release();
    await pending;
    assert.equal(env.qa.state.doc.notes, "newer typed value");
    assert.equal(env.qa.dirty(), true);
    assert.match(
      env.w.localStorage.getItem(
        "osint:draft:" +
          sample.id +
          ":" +
          env.w.sessionStorage.getItem("osint:tab"),
      ),
      /newer typed value/,
    );
    env.onWrite = null;
    await env.qa.saveDraft();
    assert.equal(env.saved.notes, "newer typed value");
    assert.equal(env.qa.dirty(), false);
  } finally {
    env.close();
  }
});
test("duplicate Save now waits for one request, and closing export does not clear dirty protection", async () => {
  const env = await setup();
  try {
    let release;
    env.onWrite = async (incoming) =>
      new Promise(
        (resolve) =>
          (release = () =>
            resolve({
              ok: true,
              status: 200,
              json: async () => ({ ...incoming, revision: 2 }),
            })),
      );
    env.qa.edit((d) => (d.notes = "unsaved"));
    const first = env.qa.saveDraft(),
      second = env.qa.saveDraft();
    assert.equal(env.writes, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(env.writes, 1);
    env.qa.edit((d) => (d.notes = "another draft"));
    env.qa.dialog("Read only", "Example");
    env.w.document.querySelector("#close-editor").click();
    assert.equal(env.qa.dirty(), true);
  } finally {
    env.close();
  }
});
test("offline failure retains draft and leaves current base revision unchanged", async () => {
  const env = await setup();
  try {
    env.onWrite = async () => {
      throw Error("network lost");
    };
    const revision = env.qa.state.base.revision;
    env.qa.edit((d) => (d.notes = "recover me"));
    await assert.rejects(env.qa.saveDraft());
    assert.equal(env.qa.state.base.revision, revision);
    assert.equal(env.qa.dirty(), true);
    assert.match(
      env.w.document.querySelector("#save-state").textContent,
      /failed/,
    );
  } finally {
    env.close();
  }
});
test("three-way merge combines independent additions and surfaces conflicting edits", async () => {
  const env = await setup();
  try {
    const base = copy(sample),
      mine = copy(base),
      theirs = copy(base);
    mine.notes = "my notes";
    theirs.summary = "their summary";
    mine.tasks.push({ id: "mine", text: "mine", done: false, due: "" });
    theirs.tasks.push({ id: "theirs", text: "theirs", done: false, due: "" });
    let result = env.qa.threeWay(base, mine, theirs);
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.merged.notes, "my notes");
    assert.equal(result.merged.summary, "their summary");
    assert(result.merged.tasks.some((t) => t.id === "mine"));
    assert(result.merged.tasks.some((t) => t.id === "theirs"));
    theirs.notes = "competing notes";
    result = env.qa.threeWay(base, mine, theirs);
    assert(result.conflicts.some((c) => c.path.join(".") === "notes"));
  } finally {
    env.close();
  }
});
test("unfinished capture entry recovers after closing, including source URL", async () => {
  const env = await setup();
  try {
    env.qa.openAssertion("entry-recovery", false, true);
    const form = env.w.document.querySelector("#edit-form");
    form.elements.label.value = "Unfinished lead";
    form.elements.newUrl.value = "https://example.com/draft";
    form.dispatchEvent(new env.w.Event("input", { bubbles: true }));
    env.w.document.querySelector("#close-editor").click();
    env.qa.openAssertion("entry-recovery", false, true);
    assert.equal(
      env.w.document.querySelector("#edit-form").elements.label.value,
      "Unfinished lead",
    );
    assert.equal(
      env.w.document.querySelector("#edit-form").elements.newUrl.value,
      "https://example.com/draft",
    );
  } finally {
    env.close();
  }
});
test("resolving a submitted form conflict closes its stale editor and clears only that entry draft", async () => {
  const env = await setup();
  try {
    const theirs = copy(env.qa.state.doc);
    theirs.revision = 2;
    theirs.notes = "Other tab notes";
    env.onWrite = async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: "Concurrent edit", current: theirs }),
    });
    env.qa.openSource(sample.sources[0].id);
    const form = env.w.document.querySelector("#edit-form");
    form.elements.title.value = "My corrected title";
    form.dispatchEvent(new env.w.Event("input", { bubbles: true }));
    form.dispatchEvent(
      new env.w.Event("submit", { bubbles: true, cancelable: true }),
    );
    await tick();
    await tick();
    assert.equal(env.w.document.querySelector("#conflict-dialog").open, true);
    const entryKey = env.qa.state.dialogKey;
    env.onWrite = null;
    env.w.document.querySelector("#merge-save").click();
    await tick();
    await tick();
    assert.equal(env.w.document.querySelector("#editor").open, false);
    assert.equal(env.w.localStorage.getItem(entryKey), null);
    assert.equal(env.qa.state.doc.sources[0].title, "My corrected title");
    assert.equal(env.qa.state.doc.notes, "Other tab notes");
  } finally {
    env.close();
  }
});
test("stable IDs preserve namesakes and typed entities; duplicated links preserve underlying evidence", async () => {
  const env = await setup();
  try {
    const doc = copy(sample);
    doc.assertions.push({
      ...copy(doc.assertions[0]),
      id: "duplicate-relationship",
      evidence: "SECOND INDEPENDENT RECORD",
    });
    const graph = env.qa.buildGraph([doc], doc.subjectId);
    assert.equal(
      graph.nodes.filter((n) => n.label === "Morgan Example").length,
      2,
    );
    assert(graph.nodes.some((n) => n.type === "domain"));
    assert(graph.nodes.some((n) => n.type === "project"));
    const link = graph.edges.find(
      (e) => e.kind === "relationship" && e.label === "works at",
    );
    assert.equal(link.records.length, 2);
    assert.equal(
      link.assertions[1].properties.Evidence,
      "SECOND INDEPENDENT RECORD",
    );
    for (const edge of graph.edges.filter((e) => e.kind === "evidence"))
      assert(edge.from.startsWith("assertion:"));
  } finally {
    env.close();
  }
});
test("source rename preserves assertion links, and reference generator avoids reuse collisions", async () => {
  const env = await setup();
  try {
    const old = env.qa.state.doc.sources[0].id;
    env.qa.state.doc.sources[0].ref = "NEW-REF";
    assert(env.qa.state.doc.assertions.some((a) => a.sourceIds.includes(old)));
    env.qa.state.doc.sources = env.qa.state.doc.sources.filter(
      (s) => s.ref !== "S02",
    );
    assert.equal(env.qa.nextRef(), "S01");
  } finally {
    env.close();
  }
});
test("public export excludes private notes, tasks, archive, private assertions and unknown private fields", async () => {
  const env = await setup();
  try {
    const doc = copy(sample);
    doc.sources[0].privateExtra = "SECRET_EXTRA";
    doc.assertions[0].privateExtra = "SECRET_EXTRA";
    const options = {
      reviewed: true,
      internal: false,
      notes: false,
      summary: false,
      tasks: false,
      archive: false,
    };
    const { scoped, text } = env.qa.reportText(doc, options);
    const encoded = JSON.stringify(scoped);
    for (const secret of [
      "PRIVATE_DEMO_NOTES",
      "PRIVATE_DEMO_LEAD",
      "Internal demo source notes",
      "SECRET_EXTRA",
    ])
      assert(!encoded.includes(secret), secret);
    assert.equal(scoped.tasks.length, 0);
    assert.equal(Object.keys(scoped.legacy).length, 0);
    assert(text.includes("Confidence:"));
    assert(text.includes("S01"));
    const publicMap = env.qa.buildGraph([scoped], doc.subjectId);
    assert(!JSON.stringify(publicMap).includes("PRIVATE_DEMO_NOTES"));
    const internal = env.qa.scopedDossier(doc, {
      internal: true,
      notes: true,
      summary: true,
      tasks: true,
    });
    const internalMap = env.qa.buildGraph([internal], doc.subjectId);
    assert(JSON.stringify(internalMap).includes("PRIVATE_DEMO_NOTES"));
    assert(
      internalMap.nodes
        .find((n) => n.id === doc.subjectId)
        .properties["Next research steps"].includes("Check account ownership"),
    );
  } finally {
    env.close();
  }
});
test("encrypted backup roundtrips and rejects wrong passwords without workspace writes", async () => {
  const env = await setup();
  try {
    const payload = { format: "demo", notes: "encrypted contents" };
    const cipher = await env.qa.encryptBackup(payload, "test-password");
    assert(!JSON.stringify(cipher).includes("encrypted contents"));
    assert.equal(
      JSON.stringify(await env.qa.decryptBackup(cipher, "test-password")),
      JSON.stringify(payload),
    );
    await assert.rejects(
      env.qa.decryptBackup(cipher, "wrong-password"),
      /Wrong password/,
    );
    assert.equal(env.writes, 0);
  } finally {
    env.close();
  }
});
test("graph keeps keyboard focus, searches edge labels with context, and remembers view positions", async () => {
  const env = await setup();
  try {
    const host = env.w.document.createElement("div");
    env.w.document.body.append(host);
    const graph = env.qa.buildGraph([sample], sample.subjectId);
    let saved;
    const mounted = env.qa.mountGraph(host, graph, {
      view: { positions: { [sample.subjectId]: { x: 123, y: 456 } } },
      onView: (v) => (saved = copy(v)),
    });
    const node = host.querySelector(".graph-node");
    node.focus();
    node.dispatchEvent(
      new env.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    assert.equal(env.w.document.activeElement, node);
    const input = host.querySelector('[data-graph="search"]');
    input.value = "works at";
    input.dispatchEvent(new env.w.Event("input"));
    const visible = [...host.querySelectorAll(".graph-node")].filter(
      (n) => n.style.display !== "none",
    );
    assert(
      visible.some((n) =>
        n.getAttribute("aria-label").includes("Avery Example"),
      ),
    );
    assert(
      visible.some((n) => n.getAttribute("aria-label").includes("Northstar")),
    );
    assert.equal(saved.positions[sample.subjectId].x, 123);
    mounted.destroy();
  } finally {
    env.close();
  }
});
test("fit contains 501 nodes and fullscreen fallback exits without leaked document handlers", async () => {
  const env = await setup();
  try {
    const host = env.w.document.createElement("div");
    env.w.document.body.append(host);
    const model = {
      subjectId: "n0",
      nodes: Array.from({ length: 501 }, (_, i) => ({
        id: "n" + i,
        label: "Entity " + i,
        type: "person",
        properties: {},
        records: [],
      })),
      edges: [],
    };
    const mounted = env.qa.mountGraph(host, model, {
      view: { neighborhood: false },
    });
    mounted.fit();
    const view = mounted.getView();
    for (const p of Object.values(view.positions)) {
      const x = view.camera.x + p.x * view.camera.scale,
        y = view.camera.y + p.y * view.camera.scale;
      assert(x >= 0 && x <= 900 && y >= 0 && y <= 620);
    }
    host.querySelector('[data-graph="fullscreen"]').click();
    assert(host.classList.contains("graph-expanded"));
    await tick();
    env.w.document.dispatchEvent(
      new env.w.KeyboardEvent("keydown", { key: "Escape" }),
    );
    assert(!host.classList.contains("graph-expanded"));
    mounted.destroy();
  } finally {
    env.close();
  }
});
