import { defineConfig } from "@playwright/test";
const browser = process.env.DONA_WEB_TEST_BROWSER;
if (browser !== undefined && browser !== "chrome") throw Error("unsupported fixture browser");
export default defineConfig({ testDir: "./browser-test", timeout: 15000, expect: { timeout: 3000 }, retries: 0, workers: 1,
  reporter: "line", use: { browserName: "chromium", ...(browser === "chrome" ? { channel: "chrome" } : {}),
    headless: true, serviceWorkers: "block", reducedMotion: "reduce", trace: "off" } });
