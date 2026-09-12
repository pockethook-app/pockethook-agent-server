/**
 * Install PocketHook Apple Bridge (macOS only).
 *
 * Usage:
 *   bun run apple-bridge:install
 *   bun run apple-bridge:install /path/to/PocketHook-Apple-Bridge.zip
 *   bun run apple-bridge:install /path/to/PocketHook\ Apple\ Bridge.app
 *
 * Source precedence: CLI path, APPLE_BRIDGE_APP_URL, bundled notarized ZIP,
 * then the official download URL.
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pc from "picocolors";
import {
  APPLE_BRIDGE_APP_NAME,
  APPLE_BRIDGE_BUNDLE_ID,
  APPLE_BRIDGE_BUNDLED_ZIP,
  APPLE_BRIDGE_EXECUTABLE_NAME,
  APPLE_BRIDGE_TARGET,
  fetchAppleBridgeHealth,
  readBundleValue,
  resolveAppleBridgeInstallSource,
} from "./apple-bridge-app.js";
import { getAppleBridgeCredential } from "./apple-bridge-pairing.js";

if (process.platform !== "darwin") {
  console.error(pc.red("PocketHook Apple Bridge is macOS-only."));
  process.exit(1);
}

function run(file: string, args: string[], quiet = false): void {
  execFileSync(file, args, { stdio: quiet ? "ignore" : ["ignore", "ignore", "inherit"] });
}

function verifyApp(appPath: string): void {
  const bundleID = readBundleValue(appPath, "CFBundleIdentifier");
  if (bundleID !== APPLE_BRIDGE_BUNDLE_ID) {
    throw new Error(`Unexpected bundle identifier: ${bundleID ?? "missing"}`);
  }
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  run("/usr/sbin/spctl", ["--assess", "--type", "execute", appPath]);
}

async function waitUntilReady(attempts = 20): Promise<Awaited<ReturnType<typeof fetchAppleBridgeHealth>>> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const health = await fetchAppleBridgeHealth();
    if (health) return health;
    await Bun.sleep(250);
  }
  return null;
}

const source = resolveAppleBridgeInstallSource();
if (source === APPLE_BRIDGE_BUNDLED_ZIP) {
  console.log(`Using the bundled notarized app (${pc.dim("assets/apple-bridge/PocketHook-Apple-Bridge.zip")}).`);
}

const work = mkdtempSync(join(tmpdir(), "pockethook-apple-bridge-"));
const backupPath = join(work, "previous", APPLE_BRIDGE_APP_NAME);
let backedUp = false;

try {
  let packagePath = source;
  if (source.startsWith("http://") || source.startsWith("https://")) {
    console.log(`Downloading ${pc.cyan(source)}…`);
    packagePath = join(work, "app.zip");
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    await Bun.write(packagePath, await response.arrayBuffer());
  } else if (!existsSync(source)) {
    throw new Error(`No such file: ${source}`);
  }

  let appPath = packagePath;
  if (!packagePath.endsWith(".app")) {
    console.log("Unpacking…");
    run("/usr/bin/ditto", ["-x", "-k", packagePath, work]);
    appPath = join(work, APPLE_BRIDGE_APP_NAME);
    if (!existsSync(appPath)) throw new Error(`The archive does not contain "${APPLE_BRIDGE_APP_NAME}".`);
  }

  console.log("Verifying bundle and notarized signature…");
  verifyApp(appPath);

  // Close only Apple Bridge itself; Agent Server and unrelated apps keep running.
  try {
    run("/usr/bin/pkill", ["-x", APPLE_BRIDGE_EXECUTABLE_NAME], true);
    await Bun.sleep(300);
  } catch { /* It was not running. */ }

  if (existsSync(APPLE_BRIDGE_TARGET)) {
    console.log("Backing up the installed app…");
    mkdirSync(join(work, "previous"), { recursive: true });
    run("/usr/bin/ditto", [APPLE_BRIDGE_TARGET, backupPath]);
    backedUp = true;
    rmSync(APPLE_BRIDGE_TARGET, { recursive: true });
  }

  console.log(`Installing to ${pc.cyan(APPLE_BRIDGE_TARGET)}…`);
  try {
    run("/usr/bin/ditto", [appPath, APPLE_BRIDGE_TARGET]);
    verifyApp(APPLE_BRIDGE_TARGET);
  } catch (error) {
    rmSync(APPLE_BRIDGE_TARGET, { recursive: true, force: true });
    if (backedUp) run("/usr/bin/ditto", [backupPath, APPLE_BRIDGE_TARGET]);
    throw error;
  }

  const launchServices = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  if (existsSync(launchServices)) run(launchServices, ["-f", APPLE_BRIDGE_TARGET], true);
  run("/usr/bin/open", [APPLE_BRIDGE_TARGET]);

  const health = await waitUntilReady();
  const paired = Boolean(getAppleBridgeCredential());
  console.log();
  console.log(pc.green(`Installed and launched PocketHook Apple Bridge${health?.version ? ` ${health.version}` : ""}.`));
  if (!health) {
    console.log(pc.yellow(paired
      ? "The app launched but its authenticated local service is not ready yet."
      : "The app launched and is blocking all requests until it is paired."));
  }
  console.log("Next steps:");
  console.log("  1. Start Agent Server and generate a code: " + pc.cyan("bun run apple-bridge:code"));
  console.log("  2. Enter the code in the menu-bar app, then enable only the resources and actions you want to share.");
  console.log("  3. Optionally enable Launch at Login in Apple Bridge.");
  console.log("  4. Check: " + pc.cyan("bun run apple-bridge:status"));
} catch (error) {
  console.error(pc.red(error instanceof Error ? error.message : String(error)));
  console.error(`Retry with ${pc.cyan("bun run apple-bridge:install")} or pass a local signed ZIP/app.`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
