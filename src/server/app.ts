import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { readFileSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { Store, Conflict, NotFound } from "./storage";
import { previewImport } from "./migration";
import { record, validateSnapshot } from "./validation";
import { TEMPLATES } from "../shared/templates";
const root = resolve(process.env.OSINT_MAPPER_ROOT ?? process.cwd());
function reply(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json")
    throw new TypeError("Use application/json.");
  const size = Number(req.headers["content-length"] ?? 0);
  if (!Number.isInteger(size) || size < 1 || size > 30_000_000)
    throw new TypeError("Request must be between 1 byte and 30 MB.");
  let received = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    received += chunk.length;
    if (received > 30_000_000) throw new TypeError("Request exceeds 30 MB.");
    chunks.push(chunk);
  }
  if (received !== size)
    throw new TypeError(
      "The request was incomplete. Retry with your protected draft.",
    );
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new TypeError("Invalid JSON.");
  }
}
export function createApp(
  store: Store,
  staticRoot = join(root, "dist", "public"),
): Server {
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? "",
        origin = req.headers.origin;
      let hostname = "";
      try {
        hostname = new URL("http://" + host).hostname;
      } catch {}
      if (
        !["127.0.0.1", "localhost", "[::1]"].includes(hostname) ||
        (origin && origin !== "http://" + host)
      )
        return reply(res, 403, {
          error: "Only the local workspace host is allowed.",
        });
      const url = new URL(req.url ?? "/", "http://" + host),
        path = url.pathname;
      const match = path.match(
          /^\/api\/dossiers\/([^/]+)(?:\/(history|restore))?$/,
        ),
        id = match ? decodeURIComponent(match[1]) : "";
      if (req.method === "GET") {
        if (path === "/api/health") {
          store.db.prepare("SELECT 1").get();
          return reply(res, 200, {
            status: "online",
            storage: "reachable",
            database: store.path,
            backups: store.backups,
            security: "Local single-user workspace; database is not encrypted.",
            runtime: "TypeScript / Node.js",
          });
        }
        if (path === "/api/templates") return reply(res, 200, TEMPLATES);
        if (path === "/api/dossiers" || path === "/api/trash")
          return reply(res, 200, store.list(path.endsWith("trash")));
        if (path === "/api/cases") return reply(res, 200, store.cases());
        if (match?.[2] === "history") return reply(res, 200, store.history(id));
        if (path === "/api/backup") return reply(res, 200, store.snapshot());
        if (
          [
            "/",
            "/style.css",
            "/graph.css",
            "/app.js",
            "/graph.js",
            "/favicon.svg",
          ].includes(path)
        ) {
          const file = path === "/" ? "index.html" : path.slice(1),
            data = readFileSync(join(staticRoot, file));
          const mime: Record<string, string> = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
          };
          res.writeHead(200, {
            "Content-Type": mime[extname(file)],
            "Content-Length": data.length,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          });
          res.end(data);
          return;
        }
      } else if (req.method === "POST") {
        if (path === "/api/stop") {
          reply(res, 200, { stopping: true });
          setImmediate(() => server.close());
          return;
        }
        if (match?.[2] === "restore") return reply(res, 200, store.restore(id));
        if (path === "/api/import/preview")
          return reply(res, 200, previewImport(await body(req)));
        if (path === "/api/cases")
          return reply(res, 200, store.saveCase(await body(req)));
        if (path === "/api/backup/preview")
          return reply(res, 200, validateSnapshot(await body(req)));
        if (path === "/api/backup/restore")
          return reply(res, 200, store.restoreSnapshot(await body(req)));
        if (path === "/api/dossiers") {
          const input = await body(req);
          record(input, "Dossier");
          const doc = previewImport(input);
          return reply(
            res,
            200,
            store.save(doc, (input.action ?? "Saved") as string),
          );
        }
      } else if (req.method === "DELETE" && match && !match[2]) {
        const expected = url.searchParams.has("revision")
          ? Number(url.searchParams.get("revision"))
          : undefined;
        if (expected !== undefined && !Number.isInteger(expected))
          throw new TypeError("Invalid expected revision.");
        store.delete(id, url.searchParams.get("permanent") === "1", expected);
        return reply(res, 200, {
          deleted: true,
          permanent: url.searchParams.get("permanent") === "1",
        });
      }
      reply(res, 404, { error: "Not found." });
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof Conflict)
        reply(res, 409, { error: error.message, current: error.current });
      else if (error instanceof NotFound)
        reply(res, 404, { error: error.message });
      else if (error instanceof TypeError || error instanceof SyntaxError)
        reply(res, 400, { error: error.message });
      else {
        console.error(error);
        reply(res, 503, {
          error:
            "Storage is unavailable. Your draft is retained. Check the database path, free disk space, and file permissions.",
        });
      }
    }
  });
  server.on("close", () => store.close());
  return server;
}
