import { spawn, execFile } from "node:child_process";
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  fstatSync,
} from "node:fs";
import { resolve } from "node:path";
import { startupMessage } from "./startup-errors";
async function launch(): Promise<void> {
  const port = Number(process.env.PORT ?? 8765),
    url = `http://127.0.0.1:${port}`;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("PORT must be between 1 and 65535.");
  const online = async () => {
    try {
      const r = await fetch(url + "/api/health", {
        signal: AbortSignal.timeout(1000),
      });
      const h = (await r.json()) as {
        storage?: string;
        runtime?: string;
        database?: string;
      };
      return (
        r.ok &&
        h.storage === "reachable" &&
        h.runtime === "TypeScript / Node.js" &&
        h.database?.toLowerCase() ===
          resolve(
            process.env.OSINT_MAPPER_DB ?? "data/mapper.sqlite3",
          ).toLowerCase()
      );
    } catch {
      return false;
    }
  };
  if (!(await online())) {
    mkdirSync("data", { recursive: true });
    const log = openSync("data/launcher.log", "a");
    const logOffset = fstatSync(log).size;
    const child = spawn(process.execPath, [resolve("dist/main.js")], {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
      env: process.env,
    });
    child.unref();
    closeSync(log);
    for (let i = 0; i < 40 && !(await online()); i++)
      await new Promise<void>((r) => setTimeout(r, 250));
    if (!(await online()))
      throw Error(
        startupMessage(
          readFileSync("data/launcher.log")
            .subarray(logOffset)
            .toString("utf8"),
          port,
        ),
      );
  }
  if (!process.argv.includes("--no-browser") && process.platform === "win32")
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Start-Process '${url}'`],
      { windowsHide: true },
    );
  else if (!process.argv.includes("--no-browser"))
    execFile(process.platform === "darwin" ? "open" : "xdg-open", [url]);
  console.log(
    `Workspace ready: ${url}\nThe server runs in the background. Use Backup & recovery to stop it.`,
  );
}
launch().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
