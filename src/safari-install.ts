/**
 * Install the PocketHook Safari extension app (macOS only).
 * Usage:
 *   bun run safari:install                  Download the notarized app and install it
 *   bun run safari:install /path/to/zip     Install from a local zip (or .app)
 *
 * The app source: SAFARI_APP_URL in .env, or the official download URL.
 * The app is Developer ID-signed and notarized, so Gatekeeper accepts it
 * without any App Store involvement.
 */

import { execSync } from "child_process";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import pc from "picocolors";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUNDLED_ZIP = join(PROJECT_ROOT, "assets", "safari", "PocketHook-Safari.zip");
const DEFAULT_URL = "https://pockethook.app/downloads/PocketHook-Safari.zip";
const APP_NAME = "Pockethook Safari.app";
const TARGET = join("/Applications", APP_NAME);

if (process.platform !== "darwin") {
  console.error(pc.red("The Safari extension is macOS-only."));
  process.exit(1);
}

// The notarized app ships with the server; a CLI path or SAFARI_APP_URL
// overrides it, and the public download URL is the last resort.
const source = process.argv[2] || process.env.SAFARI_APP_URL || (existsSync(BUNDLED_ZIP) ? BUNDLED_ZIP : DEFAULT_URL);
if (source === BUNDLED_ZIP) console.log(`Using the bundled app (${pc.dim("assets/safari/PocketHook-Safari.zip")}).`);
const work = mkdtempSync(join(tmpdir(), "pockethook-safari-"));

function run(command: string): void {
  execSync(command, { stdio: ["ignore", "ignore", "inherit"] });
}

try {
  let zipPath: string;
  if (source.startsWith("http://") || source.startsWith("https://")) {
    console.log(`Downloading ${pc.cyan(source)}…`);
    zipPath = join(work, "app.zip");
    const response = await fetch(source);
    if (!response.ok) {
      console.error(pc.red(`Download failed: HTTP ${response.status}.`));
      console.error("Set SAFARI_APP_URL in .env or pass a local file: bun run safari:install /path/to/PocketHook-Safari.zip");
      process.exit(1);
    }
    await Bun.write(zipPath, response);
  } else {
    if (!existsSync(source)) {
      console.error(pc.red(`No such file: ${source}`));
      process.exit(1);
    }
    zipPath = source;
  }

  let appPath: string;
  if (zipPath.endsWith(".app")) {
    appPath = zipPath;
  } else {
    console.log("Unpacking…");
    run(`/usr/bin/ditto -x -k "${zipPath}" "${work}"`);
    appPath = join(work, APP_NAME);
    if (!existsSync(appPath)) {
      console.error(pc.red(`The archive does not contain "${APP_NAME}".`));
      process.exit(1);
    }
  }

  console.log(`Installing to ${pc.cyan(TARGET)}…`);
  if (existsSync(TARGET)) rmSync(TARGET, { recursive: true });
  run(`/usr/bin/ditto "${appPath}" "${TARGET}"`);

  console.log("Verifying signature…");
  try {
    run(`/usr/sbin/spctl --assess --type execute "${TARGET}"`);
  } catch {
    console.log(pc.yellow("Gatekeeper did not accept the app (unsigned or un-notarized build). It may still work if you built it locally."));
  }

  run(`/usr/bin/open "${TARGET}"`);

  console.log();
  console.log(pc.green("Installed and launched."));
  console.log("Next steps:");
  console.log("  1. Safari → Settings → Extensions → enable " + pc.bold("PocketHook Safari") + " and grant website access.");
  console.log("  2. Pair it: " + pc.cyan("bun run safari:code") + " and enter the code in the extension popup.");
  console.log("  3. Check:   " + pc.cyan("bun run safari:status"));
} finally {
  rmSync(work, { recursive: true, force: true });
}
