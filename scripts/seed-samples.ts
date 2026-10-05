import { readFileSync } from "node:fs";
import type { Dossier } from "../src/shared/model";
async function seed(): Promise<void> {
  const url = `http://127.0.0.1:${Number(process.env.PORT ?? 8765)}`;
  const existing = (await fetch(url + "/api/dossiers").then((r) =>
    r.json(),
  )) as Dossier[];
  for (const file of ["sample-person.json", "sample-organization.json"]) {
    const doc = JSON.parse(readFileSync("examples/" + file, "utf8")) as Dossier;
    if (existing.some((d) => d.id === doc.id)) {
      console.log(`Preserved existing demo: ${doc.name}`);
      continue;
    }
    const response = await fetch(url + "/api/dossiers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });
    if (!response.ok) throw Error(JSON.stringify(await response.json()));
    console.log(`Added fictional demo: ${doc.name}`);
  }
}
seed().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
