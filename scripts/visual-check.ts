/** Read-only screen checks against the disposable server on port 8988. */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
async function check(): Promise<void> {
  mkdirSync("docs/previews", { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto("http://127.0.0.1:8988");
      await page
        .locator("#dossiers button")
        .filter({ hasText: "SAMPLE - Avery Example" })
        .click();
      const mode = viewport.width > 1000 ? "desktop" : "mobile";
      await page.screenshot({
        path: `docs/previews/overview-${mode}.png`,
        fullPage: true,
      });
      const width = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        view: innerWidth,
      }));
      if (width.scroll > width.view + 1)
        throw Error(`Horizontal overflow on ${mode}`);
      if (mode === "desktop") {
        await page.locator("#capture").click();
        await page.screenshot({ path: "docs/previews/capture-desktop.png" });
        await page.locator("#close-editor").click();
      }
      await page.locator('[data-tab="map"]').click();
      await page.locator('[data-graph="fullscreen"]').click();
      await page.screenshot({ path: `docs/previews/map-${mode}.png` });
      if (errors.length) throw Error(errors.join("\n"));
      await page.close();
    }
    console.log(
      "Desktop/mobile screenshots captured without page errors or horizontal overflow.",
    );
  } finally {
    await browser.close();
  }
}
check().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
