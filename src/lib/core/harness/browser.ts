/**
 * Shared Chromium launcher (SPEC §13). One headless browser is reused across
 * missions; each mission gets a fresh isolated BrowserContext (walk/isolation.ts).
 *
 * HOT-PATH file (SPEC §6.3): imports Playwright, NEVER a provider. Enforced in
 * M3-D by an eslint no-restricted-imports rule + verify-hot-path.
 */
import { chromium, type Browser } from "playwright";

let browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}
