/** Disposable browser fixture. Never reads or writes the live workspace. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/server/storage";
import { createApp } from "../src/server/app";
import { cleanTestWorkspace } from "./temp-workspace";
const directory = mkdtempSync(join(tmpdir(), "osint-browser-check-"));
const store = new Store(join(directory, "mapper.sqlite3"));
store.saveCase({
  id: "default",
  name: "Demo investigation",
  objective:
    "Assess the fictional affiliations and unresolved account ownership.",
});
for (const name of ["sample-person.json", "sample-organization.json"])
  store.save(JSON.parse(readFileSync(join("examples", name), "utf8")));
const server = createApp(store);
server.listen(Number(process.env.PORT ?? 8877), "127.0.0.1");
server.on("close", () => cleanTestWorkspace(directory));
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => server.close());
