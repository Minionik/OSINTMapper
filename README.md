# OSINT Mapper

OSINT Mapper is a local, single-user browser workspace for organizing person and organization investigations. It combines case and dossier management, evidence and source tracking, identity review, an interactive relationship map, reports, and workspace backup and recovery. Version 4 presents these tools as the Investigation Folio: ink-dark navigation, warm paper surfaces, an analyst notebook, and a dedicated map studio. Fonts and assets are served locally without external requests.

## Start the app

### Windows launcher

1. Install **Node.js 24 or newer**. `node` and `npm` must be available on `PATH`.
2. Double-click **Launch OSINT Mapper.cmd**.
3. On first launch, the launcher installs dependencies if needed, builds the app, starts the local server, and opens the workspace in your browser.
4. Use **Backup & recovery** in the app to check server status or stop the local server.

`start.ps1` is an alternative shortcut that opens the same launcher. Python is not required.

### Terminal

From the project directory, run:

```sh
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:8765>. Press **Ctrl+C** in the terminal to stop the server. To run directly from TypeScript during development, use `npm run dev`. Start the application from the project directory so that its static assets and default data directory resolve correctly.

The server binds to loopback only. Set `PORT` to change the port, or `OSINT_MAPPER_DB` to use a different SQLite database path. The default database is `data/mapper.sqlite3`. Rebuild with `npm run build` after changing TypeScript or static assets before starting the production build with `npm start`.

The server, SQLite storage, validation, legacy import migration, browser controller, interactive graph, launcher controller, sample tools, and tests are TypeScript sources. HTML/CSS/SVG provide presentation, and the CMD/PowerShell files are Windows startup wrappers. `dist/` contains generated JavaScript for Node and browsers; it is build output, not a second implementation. Shared schema types live in `src/shared/model.ts`.

## First investigation

1. Create a case and describe the investigation question in **Case settings**.
2. Add a **Person** or **Organization** dossier. Complete **Basic identity** with enough distinguishing detail to separate namesakes.
3. Use **Quick capture** to record a fact, the supporting evidence excerpt, and its source together. Record the source URL and publication/access dates when available.
4. Add explicit **Connections** between typed identities. Reuse an identity only when you have established that it is the same entity; otherwise keep separate records and document the uncertainty.
5. Review assertions and their sources. Mark what remains **Not checked**, **Not found**, or **Not applicable**, and add concrete **Next steps** rather than treating missing information as a negative finding.
6. Use the **Relationship map** to explore the records, then open **Export & report** to preview and export only the information appropriate for the audience.

The default workflow does not require a large worksheet. **Optional modules & presets** provides prompts from the supplied person/organization templates, ownership prompts, and custom fields. Add only relevant prompts, save a personal preset, and optionally apply it to new dossiers. Optional scoring uses 0/2/5/8/10 anchors, requires an explanation, and is labeled analyst judgment; scoring is internal by default. Hover or focus a **?** button for guidance, or click it to keep the guidance open.

## Investigation records

Available entity types are Person, Organization, Account, Domain, Project, and Other entity. Facts, connections, timeline entries, conclusions, and the map use the same maintained assertions. Namesakes keep separate IDs. Identity review can suggest matches, but an analyst must confirm a merge.

Within a case, reusing an identity ID shares its identity metadata. Reusing a source ID shares its title, publisher, URL, publication date, and archive address. Source reference labels, access dates, quality assessments, and notes remain local to each dossier. Updates create revisions in linked live dossiers; stale tabs must merge changes before saving. Whole-case maps refresh case records before rendering.

## Saving and recovery

Edits save automatically, and Save now is always available. The status distinguishes protected unsaved drafts, pending saves, failures and saved revisions. Typing during a pending save does not replace the newer text with the earlier snapshot.

Dossier drafts are separate for each live browser page, including duplicated tabs. Unfinished fact/source/identity/task forms are kept on the device until saved or explicitly discarded. Recover drafts can resume or download them. If browser storage is unavailable, the app reports that draft protection is limited.

A stale save receives a conflict instead of replacing newer work. Compare conflicting fields and combine independent changes in the conflict dialog. Keep the draft for later if you are not ready. History stores saved revisions and can restore an older snapshot as a new revision. Removed assertions have immediate Undo and remain recoverable through saved history.

## Map controls

The map starts with identities and explicit relationships. Evidence records adds assertion and source nodes; sources attach to the assertion they support. Repeated relationships share one labeled edge and preserve each underlying evidence record. Parallel relationships are separated. Dashed relationship lines indicate provisional assessments; contradicted relationships use a red dotted line. Inspect an edge for its precise sources, evidence, confidence and review state.

Choose This dossier or Whole case. Search includes relationship labels and keeps relevant endpoints and evidence context. Select a node to inspect, edit or jump to its dossier. Expand neighbors and Collapse neighbors operate on the selected node. Selected neighborhood limits dense maps to useful context; More neighbors increases that limit. Show all and Fit visible provide an overview. Drag nodes to arrange, drag the background to pan and use the wheel or +/- to zoom. Positions, selection, filters, expansions and the camera are saved separately per dossier/scope. Small search results use a focused layout while preserving manually arranged nodes.

Full screen fills the display where supported and falls back to filling the browser window. Exit full screen or Escape returns to the workspace. Details can be hidden to give the graph more space. Small graphs start around their subject, with typed identities and a color key. The accessible record list and Enter/arrow keys provide keyboard navigation; inspecting a node retains its focus. Dossier view tabs also support Arrow keys, Home and End. Ctrl+Shift+K opens Quick capture.

## Reports, import and exports

Export & report acts on the selected dossier. The colleague-facing preset includes reviewed assertions and excludes internal assertions, working notes, leads, identity/source notes, and the original archive. Choose assertions and explicit inclusion controls, then read the exact preview. Graph filters are exploration controls; hiding a node does not redact data. Excluded values and their layout metadata are removed from the exported payload.

Outputs are a readable text report, a readable HTML report that can be printed to PDF, a scoped JSON dossier, or an interactive offline HTML map. Reports include evidence confidence, source citations, dates, limitations and optional questions/conclusions and next steps. Graph exports carry the included layout and the graph controls without external libraries. Internal archive exports can include the original migration archive in JSON. A full workspace backup is the recovery format for all cases, dossiers and history.

Import accepts dossier versions 1, 2 and 3, validates the structure, dates, HTTP/HTTPS addresses, source uniqueness and referenced IDs, then shows a preview. It creates a new copy in the chosen case. Older dossiers are converted conservatively; their original JSON stays in a read-only migration archive. Unknown old sections and ambiguous identities are flagged for review. Unsupported strong confidence is flagged and downgraded for review while its original value remains in the archive. External legacy endpoint occurrences are not merged by name. Existing data also receives a pre-migration SQLite backup.

## Backup, storage and retention

The default database is `data/mapper.sqlite3`. Backup & recovery shows the actual location. The server makes dated SQLite snapshots under the database folder's `backups` directory each day it is started, before migration and before workspace restoration. Node's built-in SQLite engine uses `VACUUM INTO` to make transaction-consistent snapshots, including committed WAL data.

Download a full workspace backup from Backup & recovery. An optional password encrypts the download in the browser using AES-GCM and PBKDF2-SHA256; the password is never sent to the server. Keep that password separately: there is no password recovery. To restore, choose the backup, unlock it if encrypted, inspect the counts, and type RESTORE. Restoration replaces the workspace atomically after validation and creates a safety SQLite backup. Existing browser dossier drafts are retained separately for deliberate recovery, rather than automatically applied over the restored workspace.

The app binds to loopback, checks the local Host/Origin, and blocks cross-origin writes. It is a local single-user tool with no login. The live SQLite database, automatic SQLite backups, browser drafts, and ordinary dossier exports are not encrypted; encrypted backup downloads protect only those downloaded files.

Investigation records may contain sensitive information. Use the app only for an authorized purpose, collect only what you need, and take care when sharing reports or backups. Store the project data and downloaded files in a location appropriate to their sensitivity. A local-only server and encrypted backup download do not encrypt the live database, automatic snapshots, or browser drafts.

Delete moves a dossier to Trash, preserving recovery and history. Restore brings it back. Permanently remove explicitly deletes that live dossier, its saved history and its local drafts/layouts in this browser. It does not erase existing backups, downloaded exports or copies on other devices. Removing one dossier also does not erase assertions deliberately stored in another dossier.

## Fictional examples

Run `npm run sample` against the running app to add both current demonstrations. Re-running it preserves existing records and edits. Select **SAMPLE - Avery Example - updated demo (fictional)** or **SAMPLE - Northstar Demo Labs (fictional)**. They share selected identities and sources, include distinct namesakes, account/domain/project nodes, unknown states and unresolved steps. All records are synthetic; example.com addresses are placeholders.

The fixtures are `examples/sample-person.json` and `examples/sample-organization.json`. The older sample is preserved in `examples/legacy-sample-person.json` and existing legacy sample records are retained. `examples/sample-relationship-map.html` is a scoped, fictional offline export.

## Verification

- `npm ci` installs dependencies; `npm run typecheck` checks the TypeScript source, and `npm run build` produces the server, launcher, and browser bundles.
- `npm test` runs backend, concurrency, migration, validation, shared-record and recovery checks using temporary databases, plus DOM regressions for save races, stale merging, drafts, graph identities/evidence, focus, large-map geometry, selective exports and encryption.
- `npx playwright install chromium`, then `npm run test:browser` runs Chromium workflows at laptop and mobile sizes against a disposable server/database on port 8877. It covers entry, two tabs, keyboard/fullscreen controls, offline exports, import rejection, 500-node maps, long source notes, Trash, encryption/restore, and case/preset reuse. Screenshots and failure traces are written to `test-results/`.
- `npx tsx scripts/build-demo-export.ts` regenerates the scoped offline demonstration using the production bundles. Build first.
- `npx tsx scripts/verify-install.ts <backup-path>` compares all dossiers, cases and saved history with a SQLite backup and checks integrity without writing.

## Troubleshooting

- **The launcher says Node.js is missing or too old:** install Node.js 24 or newer, ensure `node` is on `PATH`, and reopen the launcher.
- **The launcher cannot build or start:** run `npm ci` and `npm run build` from the project directory and read the error output. The launcher also writes diagnostics to `data/launcher.log`.
- **The browser does not open automatically:** start the app from a terminal and open <http://127.0.0.1:8765> yourself. If you changed `PORT`, use that port instead.
- **The port is already in use:** stop the other local service or set `PORT` to an available port before starting OSINT Mapper.
- **Records are not where expected:** check the database path shown in **Backup & recovery**. A custom `OSINT_MAPPER_DB` path uses a different database from the default `data/mapper.sqlite3`.

The original review is `OSINT-mapper-analyst-review.txt`. The historical implementation checklist is `OSINT-mapper-review-fixes.txt`; version 4 carries those workflows into TypeScript. Desktop and mobile screenshots of the design are in `docs/previews/`. Automated browser checks cover Chromium; other browser engines have not been verified.
