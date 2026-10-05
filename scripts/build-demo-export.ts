/* Regenerate the fictional, scoped offline example using production exporters. */
import fs from "node:fs";
import { JSDOM } from "jsdom";
import { webcrypto } from "node:crypto";
async function main() {
  const sample = JSON.parse(
    fs.readFileSync("examples/sample-person.json", "utf8"),
  );
  const dom = new JSDOM(fs.readFileSync("static/index.html", "utf8"), {
      url: "http://127.0.0.1:8765",
      runScripts: "outside-only",
    }),
    w: any = dom.window;
  w.__OSINT_TEST__ = true;
  w.structuredClone = structuredClone;
  Object.defineProperty(w, "crypto", { value: webcrypto });
  w.fetch = async (url: string) => ({
    ok: true,
    status: 200,
    json: async () =>
      url === "/api/dossiers"
        ? [sample]
        : url === "/api/cases"
          ? [{ id: "default", name: "Fictional demo", objective: "" }]
          : url === "/api/templates"
            ? {}
            : { status: "online", database: "Demo", security: "fictional" },
  });
  try {
    w.eval(fs.readFileSync("dist/public/graph.js", "utf8"));
    w.eval(fs.readFileSync("dist/public/app.js", "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const { scopedDossier, buildGraph, mountGraph } = w.qa,
      scoped = scopedDossier(sample, {
        reviewed: true,
        internal: false,
        notes: false,
        tasks: false,
        archive: false,
        summary: false,
      });
    const graph = buildGraph([scoped], scoped.subjectId),
      payload = JSON.stringify(graph)
        .replace(/</g, "\\u003c")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OSINT Mapper - fictional scoped demonstration</title><style>body{font-family:Segoe UI,sans-serif;margin:16px;background:#eef2f6;color:#243c53}${fs.readFileSync("static/graph.css", "utf8")}</style></head><body><h1>Avery Example - fictional demonstration</h1><p>Reviewed assertions only. Working notes, leads, internal assertions and the migration archive are excluded from this file.</p><div id="map"></div><script>(${mountGraph.toString()})(document.getElementById('map'),${payload});</script></body></html>`;
    fs.writeFileSync("examples/sample-relationship-map.html", html);
    console.log("Updated scoped offline example.");
  } finally {
    w.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
