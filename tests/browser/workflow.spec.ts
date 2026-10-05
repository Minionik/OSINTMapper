import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
const sampleId = "sample-person-demo-v3";
async function openSample(page: Page) {
  await page.goto("/");
  await page
    .locator("#dossiers button")
    .filter({ hasText: "SAMPLE - Avery Example" })
    .click();
  await expect(page.locator("#title")).toContainText("Avery");
}
async function createDossier(page: Page, name: string) {
  await page.locator("#new").click();
  await page.locator('#edit-form [name="name"]').fill(name);
  await page.locator("#submit-editor").click();
  await expect(page.locator("#title")).toHaveText(name);
}
test("core workflow, quick capture, meaningful states, accessible help and no horizontal overflow", async ({
  page,
}, info) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openSample(page);
  await expect(page.locator(".tabs")).toContainText("Sources");
  await page.locator("#capture").click();
  await page.locator('#edit-form [name="label"]').fill("Browser test fact");
  await page.locator('#edit-form [name="value"]').fill("Synthetic observation");
  await page
    .locator('#edit-form [name="newUrl"]')
    .fill("https://example.com/browser-test-" + info.project.name);
  await page.locator('#edit-form [data-help="fact"]').first().click();
  await expect(page.locator("#help-panel")).toBeVisible();
  await expect(page.locator("#help-panel")).toContainText("official profile");
  await page.locator("#close-help").click();
  await page.locator("#submit-editor").click();
  await expect(page.locator("#editor")).not.toBeVisible();
  await page.locator('[data-tab="facts"]').click();
  await expect(page.locator("#content")).toContainText("Browser test fact");
  const width = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    view: innerWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.view + 1);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: path.join(info.outputDir, "facts.png"),
    fullPage: true,
  });
});
test("real two-tab conflict preserves both versions and allows three-way merge", async ({
  page,
  context,
}, info) => {
  await page.goto("/");
  await createDossier(page, "Concurrency " + info.project.name);
  const second = await context.newPage();
  await second.goto("/");
  await second
    .locator("#dossiers button")
    .filter({ hasText: "Concurrency " + info.project.name })
    .click();
  await page.locator("#notes").fill("First tab notes");
  await page.locator("#save-now").click();
  await expect(page.locator("#save-state")).toContainText("Saved");
  await second.locator("#summary").fill("Second tab conclusion");
  await second.locator("#save-now").click();
  await expect(second.locator("#conflict-dialog")).toBeVisible();
  await second.locator("#merge-save").click();
  await expect(second.locator("#save-state")).toContainText("Saved");
  await page.reload();
  await page
    .locator("#dossiers button")
    .filter({ hasText: "Concurrency " + info.project.name })
    .click();
  await expect(page.locator("#notes")).toHaveValue("First tab notes");
  await expect(page.locator("#summary")).toHaveValue("Second tab conclusion");
});
test("map search, exact claim evidence, keyboard focus, remembered layout and fullscreen", async ({
  page,
}, info) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openSample(page);
  await page.locator('[data-tab="map"]').click();
  const graph = page.locator("#relationship-graph");
  await expect(graph.locator("svg")).toBeVisible();
  const search = graph.locator('[data-graph="search"]');
  await search.fill("works at");
  await expect(graph.locator(".graph-status")).toContainText("nodes");
  const edge = graph
    .locator(".graph-edge")
    .filter({ hasText: "works at" })
    .first();
  await edge.click();
  await expect(graph.locator(".graph-inspector")).toContainText(
    "Synthetic statement",
  );
  await expect(graph.locator(".graph-inspector")).toContainText("CONFIRMED");
  const node = graph.locator(".graph-node:visible").first();
  await node.focus();
  await node.press("Enter");
  await expect(node).toBeFocused();
  await graph.locator('[data-graph="fullscreen"]').click();
  await expect(graph).toHaveClass(/graph-expanded/);
  const rect = await graph.boundingBox();
  expect(rect.width).toBeGreaterThan(info.project.use.viewport.width - 40);
  await page.screenshot({ path: path.join(info.outputDir, "fullscreen.png") });
  await page.keyboard.press("Escape");
  await expect(graph).not.toHaveClass(/graph-expanded/);
  await graph.locator('[data-graph="search"]').fill("Northstar");
  await page.locator('[data-tab="facts"]').click();
  await page.locator('[data-tab="map"]').click();
  await expect(graph.locator('[data-graph="search"]')).toHaveValue("Northstar");
  expect(errors).toEqual([]);
});
test("cancelled entry draft is recovered and double-submit creates one fact", async ({
  page,
}, info) => {
  await page.goto("/");
  await createDossier(page, "Draft recovery " + info.project.name);
  await page.locator("#capture").click();
  await page.locator('#edit-form [name="label"]').fill("Protected form draft");
  await page.locator('#edit-form [name="value"]').fill("Never lose this text");
  await page.locator("#close-editor").click();
  await page.locator("#drafts").click();
  await page
    .getByRole("button", { name: "Resume", exact: true })
    .first()
    .click();
  await expect(page.locator('#edit-form [name="value"]')).toHaveValue(
    "Never lose this text",
  );
  await page.locator("#submit-editor").dblclick();
  await expect(page.locator("#editor")).not.toBeVisible();
  await page.locator('[data-tab="facts"]').click();
  await expect(
    page.locator(".finding").filter({ hasText: "Protected form draft" }),
  ).toHaveCount(1);
});
test("export preview and downloaded HTML map remove excluded content and work offline", async ({
  page,
  browser,
}, info) => {
  await openSample(page);
  await page.locator("#export").click();
  await expect(page.locator("#export-preview")).not.toContainText(
    "PRIVATE_DEMO",
  );
  await page.locator('#edit-form [name="output"]').selectOption("map");
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#submit-editor").click();
  const download = await downloadPromise;
  const output = path.join(info.outputDir, "scoped-map.html");
  await download.saveAs(output);
  const file = fs.readFileSync(output, "utf8");
  expect(file).not.toContain("PRIVATE_DEMO");
  expect(file).not.toContain("Internal demo source notes");
  const context = await browser.newContext();
  await context.setOffline(true);
  const exported = await context.newPage();
  const errors = [];
  exported.on("pageerror", (e) => errors.push(e.message));
  await exported.goto("file:///" + output.replace(/\\/g, "/"));
  await expect(exported.locator("svg")).toBeVisible();
  await exported.locator('[data-graph="evidence"]').click();
  await expect(exported.locator(".graph-status")).toContainText("nodes");
  expect(errors).toEqual([]);
  await context.close();
});
test("trash and restore preserve revisions; permanent removal is deliberate", async ({
  page,
}, info) => {
  await page.goto("/");
  const name = "Trash test " + info.project.name;
  await createDossier(page, name);
  page.on("dialog", (d) => d.accept());
  await page.locator("#delete-dossier").click();
  await page.locator("#trash").click();
  const entry = page
    .locator("#editor-content .finding")
    .filter({ hasText: name });
  await expect(entry).toBeVisible();
  await entry.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.locator("#dossiers")).toContainText(name);
  await page.locator("#close-editor").click();
  await page.locator("#dossiers button").filter({ hasText: name }).click();
  await expect(page.locator("#subtitle")).toContainText("revision 3");
  await page.locator("#delete-dossier").click();
  await page.locator("#trash").click();
  await page
    .locator("#editor-content .finding")
    .filter({ hasText: name })
    .getByRole("button", { name: "Permanently remove" })
    .click();
  await expect(page.locator("#editor-content")).not.toContainText(name);
});
test("invalid imported values are rejected before creation and unknown states remain explicit", async ({
  page,
}, info) => {
  await page.goto("/");
  const invalid = {
    ...JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "../../examples/sample-person.json"),
        "utf8",
      ),
    ),
    schemaVersion: 999,
  };
  await page
    .locator("#import-file")
    .setInputFiles({
      name: "invalid.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(invalid)),
    });
  await expect(page.locator("#notice")).toContainText(
    "Unsupported import version",
  );
  await createDossier(page, "Unknown states " + info.project.name);
  await page.locator("#capture").click();
  await page.locator('#edit-form [name="label"]').fill("Unknown owner");
  await page.locator('#edit-form [name="knowledge"]').selectOption("not_found");
  await page
    .locator('#edit-form [name="evidence"]')
    .fill("Checked the synthetic directory; no result for this query.");
  await page.locator("#submit-editor").click();
  await expect(page.locator("#editor")).not.toBeVisible();
  await page.locator('[data-tab="facts"]').click();
  await expect(page.locator("#content")).toContainText("Not found");
});
test("500-node map stays focused by default; true fit and long source details stay usable", async ({
  page,
  request,
}, info) => {
  const doc = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../../examples/sample-person.json"),
      "utf8",
    ),
  );
  doc.id = "large-" + info.project.name;
  doc.revision = 0;
  doc.name = "Large graph " + info.project.name;
  doc.legacy = {};
  doc.assertions = [];
  doc.conclusionIds = [];
  doc.entities = doc.entities.slice(0, 1);
  doc.subjectId = doc.entities[0].id = "root-" + doc.id;
  doc.entities[0].dossierId = doc.id;
  doc.sources[0].notes = "Long evidence note ".repeat(300);
  for (let i = 1; i <= 500; i++) {
    const id = "entity-" + doc.id + "-" + i;
    doc.entities.push({
      id,
      name: "Entity " + i,
      type: i % 2 ? "organization" : "person",
      aliases: "",
      details: "Synthetic load-test identity",
      dossierId: "",
    });
    doc.assertions.push({
      id: "edge-" + i,
      kind: "relationship",
      entityId: doc.subjectId,
      fromId: doc.subjectId,
      toId: id,
      relationship: "recorded connection",
      label: "Connection " + i,
      value: "recorded connection",
      category: "General",
      knowledge: "known",
      classification: "UNVERIFIED",
      verification: "unreviewed",
      sourceIds: [],
      evidence: "Synthetic load-test record",
      justification: "",
      collected: "",
      eventDate: "",
      publicationDate: "",
      internal: false,
    });
  }
  const response = await request.post("/api/dossiers", { data: doc });
  expect(response.ok()).toBeTruthy();
  await page.goto("/");
  await page.locator("#dossiers button").filter({ hasText: doc.name }).click();
  await page.locator('[data-tab="map"]').click();
  const graph = page.locator("#relationship-graph");
  await expect(graph.locator(".graph-status")).toContainText("neighborhood");
  await expect(graph.locator(".graph-node:visible")).toHaveCount(41);
  await graph.locator('[data-graph="all"]').click();
  await expect(graph.locator(".graph-node:visible")).toHaveCount(501);
  await graph.locator('[data-graph="fit"]').click();
  const bounds = await graph.locator("svg").evaluate((svg) => {
    const rect = svg.getBoundingClientRect();
    return [...svg.querySelectorAll(".graph-node")]
      .filter((n) => getComputedStyle(n).display !== "none")
      .every((n) => {
        const p = n.getBoundingClientRect();
        return (
          p.x >= rect.x - 1 &&
          p.y >= rect.y - 1 &&
          p.right <= rect.right + 1 &&
          p.bottom <= rect.bottom + 1
        );
      });
  });
  expect(bounds).toBeTruthy();
  await page.screenshot({
    path: path.join(info.outputDir, "large-map.png"),
    fullPage: true,
  });
  await page.locator('[data-tab="sources"]').click();
  await page
    .locator("#content .finding")
    .first()
    .getByRole("button", { name: "Edit source" })
    .click();
  await expect(page.locator('#edit-form [name="notes"]')).toHaveValue(
    doc.sources[0].notes,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  await page.locator("#close-editor").click();
});
test("encrypted workspace backup unlocks, rejects wrong passwords, and restores inspected contents", async ({
  page,
}, info) => {
  await openSample(page);
  await page.locator("#workspace-tools").click();
  await page
    .locator('#edit-form [name="password"]')
    .fill("fictional-backup-password");
  const promise = page.waitForEvent("download");
  await page.locator("#submit-editor").click();
  const file = await promise;
  const location = path.join(info.outputDir, "workspace.osintbackup");
  await file.saveAs(location);
  const payload = fs.readFileSync(location, "utf8");
  expect(payload).not.toContain("PRIVATE_DEMO_NOTES");
  await page.locator("#restore-file").setInputFiles(location);
  await page.locator('#edit-form [name="password"]').fill("wrong");
  await page.locator("#submit-editor").click();
  await expect(page.locator("#form-error")).toContainText("Wrong password");
  await page
    .locator('#edit-form [name="password"]')
    .fill("fictional-backup-password");
  await page.locator("#submit-editor").click();
  await expect(page.locator("#editor-content")).toContainText(
    "Restore inspected workspace backup",
  );
  await page.locator('#edit-form [name="confirmation"]').fill("RESTORE");
  await page.locator("#submit-editor").click();
  await expect(page.locator("#notice")).toContainText("Workspace restored");
  await expect(page.locator("#dossiers")).toContainText("Avery Example");
});
test("custom module preset, shared case source and linked dossier identities are maintained records", async ({
  page,
}, info) => {
  await page.goto("/");
  await page.locator("#new-case").click();
  await page
    .locator('#edit-form [name="name"]')
    .fill("Shared case " + info.project.name);
  await page
    .locator('#edit-form [name="objective"]')
    .fill("Check the synthetic organization links.");
  await page.locator("#submit-editor").click();
  await createDossier(page, "Subject A " + info.project.name);
  await page
    .getByRole("button", { name: "Optional modules & presets" })
    .click();
  await page.locator('#edit-form [name="module-Ownership"]').check();
  await page
    .locator('#edit-form [name="customLabel"]')
    .fill("Registry identifier");
  await page.locator('#edit-form [name="customCategory"]').fill("Ownership");
  await page.locator('#edit-form [name="savePreset"]').check();
  await page.locator("#submit-editor").click();
  await page.locator('[data-tab="sources"]').click();
  await page.getByRole("button", { name: "Add source", exact: false }).click();
  await page
    .locator('#edit-form [name="title"]')
    .fill("Shared synthetic register");
  await page
    .locator('#edit-form [name="url"]')
    .fill("https://example.com/shared-" + info.project.name);
  await page.locator("#submit-editor").click();
  await page.locator("#new").click();
  await page
    .locator('#edit-form [name="name"]')
    .fill("Subject B " + info.project.name);
  await page.locator('#edit-form [name="usePreset"]').check();
  await page.locator("#submit-editor").click();
  await page.locator('[data-tab="facts"]').click();
  await expect(page.locator("#content")).toContainText("Registry identifier");
  await expect(page.locator("#content")).toContainText("Not checked");
  await page.locator('[data-tab="sources"]').click();
  await page.getByRole("button", { name: "Add source", exact: false }).click();
  await page.locator('#edit-form [name="reuseSource"]').selectOption("0");
  await page.locator("#submit-editor").click();
  await page.getByRole("button", { name: "Edit source" }).click();
  await page
    .locator('#edit-form [name="title"]')
    .fill("Corrected shared register title");
  await page.locator("#submit-editor").click();
  await page.locator('[data-tab="connections"]').click();
  await page.getByRole("button", { name: "Record connection" }).click();
  await page
    .locator('#edit-form [name="toId"]')
    .selectOption({
      label: "Subject A " + info.project.name + " · existing dossier",
    });
  await page.locator('#edit-form [name="relationship"]').fill("works with");
  await page.locator("#submit-editor").click();
  await page.locator('[data-tab="map"]').click();
  await page.locator("#map-scope").selectOption("case");
  await expect(
    page.locator(".graph-node").filter({ hasText: "Subject A" }),
  ).toHaveCount(1);
  await page
    .locator("#dossiers button")
    .filter({ hasText: "Subject A " + info.project.name })
    .click();
  await page.locator('[data-tab="sources"]').click();
  await expect(page.locator("#content")).toContainText(
    "Corrected shared register title",
  );
});
