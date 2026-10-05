import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
async function main(): Promise<void> {
  await mkdir("dist/public", { recursive: true });
  await build({
    entryPoints: ["src/server/main.ts", "scripts/launch.ts"],
    outdir: "dist",
    entryNames: "[name]",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    sourcemap: true,
  });
  await build({
    entryPoints: ["src/client/app.ts", "src/client/graph.ts"],
    outdir: "dist/public",
    bundle: true,
    format: "iife",
    target: "es2022",
    sourcemap: true,
  });
  await Promise.all(
    ["index.html", "style.css", "graph.css", "favicon.svg"].map((file) =>
      copyFile(`static/${file}`, `dist/public/${file}`),
    ),
  );
  console.log("Built TypeScript server, launcher, and browser workspace.");
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
