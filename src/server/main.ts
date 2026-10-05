import { resolve } from "node:path";
import { Store } from "./storage";
import { createApp } from "./app";
const port = Number(process.env.PORT ?? 8765);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new TypeError("PORT must be an integer from 1 to 65535.");
const store = new Store(
  resolve(process.env.OSINT_MAPPER_DB ?? "data/mapper.sqlite3"),
);
const server = createApp(store);
server.on("error", (error) => {
  console.error(`Could not open the workspace: ${error.message}`);
  store.close();
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () =>
  console.log(`OSINT Mapper: http://127.0.0.1:${port} · TypeScript workspace`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => server.close());
