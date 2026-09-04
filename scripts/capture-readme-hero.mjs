#!/usr/bin/env node
// Captures the README hero screenshots straight from the running app:
//   .github/assets/hero-{light,dark}.png
//
// A screenshot beats a drawing here because it cannot drift from the product:
// whatever the editor looks like on the day it runs is what the README shows.
// The cost is that it needs a real app instance, so this is a manual step, not
// something CI can do.
//
// Prerequisites:
//   1. A project to photograph (default "Randomized sketching" in DemoPaper)
//      with a compiled PDF already on disk, so the preview pane has a page.
//   2. The app running with the webview debugger exposed:
//        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 \
//          npm run tauri dev
//   3. Whatever app settings you want the README to advertise. This photographs
//      the app AS CONFIGURED, so anything you have switched on that ships off by
//      default (grammar lint is the usual one, and its squiggles plus the "N
//      problems" status-bar item are conspicuous) shows up in the shot. Flip it
//      in Settings first if the hero should look like a default install.
//
// Then: node scripts/capture-readme-hero.mjs
//
// It photographs the same window twice, once per theme, restoring whatever
// theme was set when it started. deviceScaleFactor 2 keeps the shot crisp on
// HiDPI displays at half its pixel width in the README.

import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../bench/lib/cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "..", ".github", "assets");

const PROJECT = process.argv[2] ?? "Randomized sketching";
// Wide enough that the three panes fit without the preview's toolbar running
// off the edge: at 1440 the zoom control is clipped.
const SHOT_W = 1680;
const SHOT_H = 1000;
const SCALE = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const c = await connect();
try {
  const originalTheme = await c.evaluate(
    `document.documentElement.getAttribute("data-theme") ?? ""`,
  );

  // A fixed viewport keeps both shots identical in framing, and makes the
  // README image's aspect ratio independent of the window the app happens to
  // be in when this runs.
  await c.send("Emulation.setDeviceMetricsOverride", {
    width: SHOT_W,
    height: SHOT_H,
    deviceScaleFactor: SCALE,
    mobile: false,
  });

  await c.evaluate(`location.assign("/projects")`);
  await sleep(1500);
  await c.waitFor(`document.body.innerText.includes(${JSON.stringify(PROJECT)})`, 20_000);
  await c.evaluate(`(() => {
    const card = [...document.querySelectorAll("div")]
      .filter((e) => e.textContent.includes(${JSON.stringify(PROJECT)}) && e.textContent.length < 90)
      .sort((a, b) => a.textContent.length - b.textContent.length)[0];
    card.click();
  })()`);

  // Wait for the editor AND a rendered PDF page: a shot taken before the
  // preview paints would show an empty pane, which is the one thing the hero
  // must not show.
  await c.waitFor(`document.querySelector(".cm-content") !== null`, 30_000);
  await c.waitFor(`document.querySelector("canvas") !== null`, 60_000);
  await sleep(1500);

  // Compile for real. Opening a project shows the PREVIOUS build with a "From
  // last build" ribbon and an Idle compile pill; a hero photographed in that
  // state advertises a stale preview and an app that has done nothing.
  await c.evaluate(`(() => {
    const b = [...document.querySelectorAll("button")]
      .find((e) => /^(Recompile|Compile)$/.test(e.textContent.trim().replace(/Ctrl.*$/, "").trim()));
    if (b) b.click();
  })()`);
  await c.waitFor(`document.body.innerText.includes("Compiled")`, 180_000);
  // Let the fresh PDF paint, the ribbon clear, and any debounced pass that
  // draws in the editor (Harper's lint, the LSP's diagnostics) finish BEFORE
  // the first shot. Without this the two themes disagree: the earlier shot
  // catches a pre-lint editor and the later one catches squiggles.
  await sleep(8000);

  for (const [name, theme] of [
    ["light", "daylight"],
    ["dark", "lamplight"],
  ]) {
    await c.evaluate(`document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)})`);
    // Long enough for the theme transition and any re-render to settle.
    await sleep(1200);
    const { data } = await c.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const file = join(outDir, `hero-${name}.png`);
    await writeFile(file, Buffer.from(data, "base64"));
    console.log(`wrote ${file}`);
  }

  if (originalTheme) {
    await c.evaluate(`document.documentElement.setAttribute("data-theme", ${JSON.stringify(originalTheme)})`);
  }
  await c.send("Emulation.clearDeviceMetricsOverride");
} finally {
  c.close();
}
