import { basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
/** Delete only a directly-contained, explicitly named disposable test workspace. */
export function cleanTestWorkspace(directory: string): void {
  const target = resolve(directory);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !/^osint-(ts-test|browser-check)-/.test(basename(target))
  )
    throw Error("Refusing to remove an unexpected test workspace path.");
  rmSync(target, { recursive: true, force: true });
}
