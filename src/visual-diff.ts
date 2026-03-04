#!/usr/bin/env bun
/**
 * Visual Diff — compare two URLs (or the same URL twice) and produce a pixel-level diff.
 *
 * Usage:
 *   bun run src/visual-diff.ts <urlA> <urlB> [options]
 *
 * Options:
 *   --wait <ms>        Wait time after load before screenshot (default: 6000)
 *   --threshold <0-1>  Color diff threshold for pixelmatch (default: 0.1)
 *   --output <dir>     Output directory for images (default: ./visual-diff-output)
 *   --viewport <WxH>   Viewport size (default: 1280x720)
 *   --full-page        Capture full scrollable page (default: true)
 *   --wait-for <sel>   Wait for a CSS selector to be visible before screenshot
 *   --wait-images      Wait for all images in viewport to finish loading
 */

import { chromium, type Browser } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Stealth evasions ─────────────────────────────────────────────────
// Instead of depending on playwright-extra (which has compatibility issues),
// we apply stealth evasions directly via addInitScript.

const STEALTH_SCRIPTS = [
  // Hide webdriver flag
  `Object.defineProperty(navigator, 'webdriver', { get: () => false });`,
  // Fake plugins
  `Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5].map(() => ({
      name: 'Chrome PDF Plugin',
      description: 'Portable Document Format',
      filename: 'internal-pdf-viewer',
      length: 1,
    })),
  });`,
  // Fake languages
  `Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });`,
  // Chrome runtime
  `window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}), app: { isInstalled: false } };`,
  // Permissions
  `const originalQuery = window.navigator.permissions.query;
   window.navigator.permissions.query = (parameters) =>
     parameters.name === 'notifications'
       ? Promise.resolve({ state: Notification.permission })
       : originalQuery(parameters);`,
  // WebGL vendor
  `const getParameter = WebGLRenderingContext.prototype.getParameter;
   WebGLRenderingContext.prototype.getParameter = function(parameter) {
     if (parameter === 37445) return 'Intel Inc.';
     if (parameter === 37446) return 'Intel Iris OpenGL Engine';
     return getParameter.call(this, parameter);
   };`,
];

// ── CLI argument parsing ─────────────────────────────────────────────

interface DiffOptions {
  urlA: string;
  urlB: string;
  wait: number;
  threshold: number;
  outputDir: string;
  viewportWidth: number;
  viewportHeight: number;
  fullPage: boolean;
  waitFor: string | null;
  waitImages: boolean;
}

function parseArgs(): DiffOptions {
  const args = process.argv.slice(2);

  if (args.length < 2 || args[0].startsWith("--")) {
    console.error("Usage: bun run src/visual-diff.ts <urlA> <urlB> [options]");
    console.error("Options:");
    console.error("  --wait <ms>        Wait time after load (default: 6000)");
    console.error("  --threshold <0-1>  Pixel match threshold (default: 0.1)");
    console.error("  --output <dir>     Output directory (default: ./visual-diff-output)");
    console.error("  --viewport <WxH>   Viewport size (default: 1280x720)");
    console.error("  --full-page        Capture full scrollable page (default: true)");
    console.error("  --wait-for <sel>   CSS selector that must be visible before screenshot");
    console.error("  --wait-images      Wait for all viewport images to load");
    process.exit(1);
  }

  const opts: DiffOptions = {
    urlA: args[0],
    urlB: args[1],
    wait: 6000,
    threshold: 0.1,
    outputDir: "./visual-diff-output",
    viewportWidth: 1280,
    viewportHeight: 720,
    fullPage: true,
    waitFor: null,
    waitImages: false,
  };

  for (let i = 2; i < args.length; i++) {
    switch (args[i]) {
      case "--wait":
        opts.wait = parseInt(args[++i], 10);
        break;
      case "--threshold":
        opts.threshold = parseFloat(args[++i]);
        break;
      case "--output":
        opts.outputDir = args[++i];
        break;
      case "--viewport": {
        const [w, h] = args[++i].split("x").map(Number);
        opts.viewportWidth = w;
        opts.viewportHeight = h;
        break;
      }
      case "--full-page":
        opts.fullPage = true;
        break;
      case "--no-full-page":
        opts.fullPage = false;
        break;
      case "--wait-for":
        opts.waitFor = args[++i];
        break;
      case "--wait-images":
        opts.waitImages = true;
        break;
    }
  }

  return opts;
}

// ── Core functions ───────────────────────────────────────────────────

async function captureScreenshot(
  browser: Browser,
  url: string,
  opts: DiffOptions,
  label: string,
): Promise<Buffer> {
  const context = await browser.newContext({
    viewport: { width: opts.viewportWidth, height: opts.viewportHeight },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/New_York",
  });

  // Apply stealth evasions
  for (const script of STEALTH_SCRIPTS) {
    await context.addInitScript(script);
  }

  const page = await context.newPage();

  console.log(`[${label}] Navigating to: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

  console.log(`[${label}] Waiting ${opts.wait}ms for page to fully render...`);
  await page.waitForTimeout(opts.wait);

  // Try to wait for network idle too, with a shorter timeout
  try {
    await page.waitForLoadState("networkidle", { timeout: 5000 });
  } catch {
    // Network may not go idle on sites with streaming/polling — that's fine
  }

  // Wait for a specific selector to be visible
  if (opts.waitFor) {
    console.log(`[${label}] Waiting for selector: ${opts.waitFor}`);
    try {
      await page.waitForSelector(opts.waitFor, { state: "visible", timeout: 15_000 });
      console.log(`[${label}] Selector found and visible`);
    } catch {
      console.warn(`[${label}] WARNING: selector "${opts.waitFor}" not found within timeout`);
    }
  }

  // Wait for all images in viewport to finish loading
  if (opts.waitImages) {
    console.log(`[${label}] Waiting for images to load...`);
    const imageStatus = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll("img"));
      const visible = imgs.filter((img) => {
        const rect = img.getBoundingClientRect();
        return rect.top < window.innerHeight * 2 && rect.width > 0;
      });
      const loaded = visible.filter((img) => img.complete && img.naturalWidth > 0);
      return { total: visible.length, loaded: loaded.length };
    });
    console.log(`[${label}] Images: ${imageStatus.loaded}/${imageStatus.total} loaded`);

    // Poll until all visible images are loaded (max 10s)
    if (imageStatus.loaded < imageStatus.total) {
      await page.waitForFunction(
        () => {
          const imgs = Array.from(document.querySelectorAll("img"));
          const visible = imgs.filter((img) => {
            const rect = img.getBoundingClientRect();
            return rect.top < window.innerHeight * 2 && rect.width > 0;
          });
          return visible.every((img) => img.complete && img.naturalWidth > 0);
        },
        { timeout: 10_000 },
      ).catch(() => {
        console.warn(`[${label}] WARNING: some images did not finish loading`);
      });
    }
  }

  console.log(`[${label}] Taking screenshot...`);
  const buffer = await page.screenshot({ fullPage: opts.fullPage });

  await context.close();
  return buffer;
}

function compareImages(
  bufferA: Buffer,
  bufferB: Buffer,
  threshold: number,
): {
  diffPixels: number;
  totalPixels: number;
  diffPercent: number;
  diffPng: Buffer;
  matchedDimensions: boolean;
} {
  const imgA = PNG.sync.read(bufferA);
  const imgB = PNG.sync.read(bufferB);

  // Handle dimension mismatch by padding the smaller image
  const width = Math.max(imgA.width, imgB.width);
  const height = Math.max(imgA.height, imgB.height);

  const matchedDimensions = imgA.width === imgB.width && imgA.height === imgB.height;

  // Create normalized buffers with the max dimensions
  const normalizedA = new PNG({ width, height });
  const normalizedB = new PNG({ width, height });

  // Fill with white background
  normalizedA.data.fill(255);
  normalizedB.data.fill(255);

  // Copy image data
  PNG.bitblt(imgA, normalizedA, 0, 0, imgA.width, imgA.height, 0, 0);
  PNG.bitblt(imgB, normalizedB, 0, 0, imgB.width, imgB.height, 0, 0);

  const diff = new PNG({ width, height });
  const totalPixels = width * height;

  const diffPixels = pixelmatch(
    normalizedA.data,
    normalizedB.data,
    diff.data,
    width,
    height,
    { threshold },
  );

  const diffPercent = (diffPixels / totalPixels) * 100;
  const diffPng = PNG.sync.write(diff);

  return { diffPixels, totalPixels, diffPercent, diffPng, matchedDimensions };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  mkdirSync(opts.outputDir, { recursive: true });

  console.log("=== Visual Diff ===");
  console.log(`URL A: ${opts.urlA}`);
  console.log(`URL B: ${opts.urlB}`);
  console.log(
    `Wait: ${opts.wait}ms | Threshold: ${opts.threshold} | Viewport: ${opts.viewportWidth}x${opts.viewportHeight}`,
  );
  console.log("");

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--no-sandbox",
    ],
  });

  try {
    // Capture both screenshots sequentially (same browser instance for consistency)
    const screenshotA = await captureScreenshot(browser, opts.urlA, opts, "A");
    const screenshotB = await captureScreenshot(browser, opts.urlB, opts, "B");

    // Save screenshots
    const pathA = join(opts.outputDir, "screenshot-a.png");
    const pathB = join(opts.outputDir, "screenshot-b.png");
    const pathDiff = join(opts.outputDir, "diff.png");
    const pathReport = join(opts.outputDir, "report.json");

    writeFileSync(pathA, screenshotA);
    writeFileSync(pathB, screenshotB);

    console.log("\nComparing screenshots...");
    const result = compareImages(screenshotA, screenshotB, opts.threshold);

    writeFileSync(pathDiff, result.diffPng);

    const report = {
      urlA: opts.urlA,
      urlB: opts.urlB,
      viewport: { width: opts.viewportWidth, height: opts.viewportHeight },
      fullPage: opts.fullPage,
      waitMs: opts.wait,
      waitFor: opts.waitFor,
      waitImages: opts.waitImages,
      threshold: opts.threshold,
      matchedDimensions: result.matchedDimensions,
      totalPixels: result.totalPixels,
      diffPixels: result.diffPixels,
      diffPercent: Math.round(result.diffPercent * 100) / 100,
      passed: result.diffPercent === 0,
      files: {
        screenshotA: pathA,
        screenshotB: pathB,
        diff: pathDiff,
      },
      timestamp: new Date().toISOString(),
    };

    writeFileSync(pathReport, JSON.stringify(report, null, 2));

    console.log("\n=== Results ===");
    console.log(`Dimensions match: ${result.matchedDimensions ? "YES" : "NO"}`);
    console.log(`Total pixels: ${result.totalPixels.toLocaleString()}`);
    console.log(`Diff pixels: ${result.diffPixels.toLocaleString()}`);
    console.log(`Diff percent: ${report.diffPercent}%`);
    console.log(`Result: ${report.passed ? "PASS (identical)" : "FAIL (differences found)"}`);
    console.log(`\nOutput: ${opts.outputDir}/`);
    console.log(`  screenshot-a.png`);
    console.log(`  screenshot-b.png`);
    console.log(`  diff.png`);
    console.log(`  report.json`);

    // Exit with code 1 if differences found
    process.exit(report.passed ? 0 : 1);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
