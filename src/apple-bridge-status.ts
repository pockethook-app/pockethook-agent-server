/** Read-only installation and local-service status for PocketHook Apple Bridge. */

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import pc from "picocolors";
import { getAppleBridgeCredential } from "./apple-bridge-pairing.js";
import {
  APPLE_BRIDGE_BUNDLE_ID,
  APPLE_BRIDGE_TARGET,
  fetchAppleBridgeHealth,
  readBundleValue,
} from "./apple-bridge-app.js";

if (process.platform !== "darwin") {
  console.error(pc.red("PocketHook Apple Bridge is macOS-only."));
  process.exit(1);
}

function commandPasses(file: string, args: string[]): boolean {
  try {
    execFileSync(file, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

console.log();
console.log(pc.bold("PocketHook Apple Bridge — status"));

if (!existsSync(APPLE_BRIDGE_TARGET)) {
  console.log(`  Installed: ${pc.red("no")}`);
  console.log(`  Install with: ${pc.cyan("bun run apple-bridge:install")}`);
  console.log();
  process.exit(1);
}

const version = readBundleValue(APPLE_BRIDGE_TARGET, "CFBundleShortVersionString") ?? "unknown";
const bundleID = readBundleValue(APPLE_BRIDGE_TARGET, "CFBundleIdentifier");
const signatureValid = commandPasses("/usr/bin/codesign", ["--verify", "--deep", "--strict", APPLE_BRIDGE_TARGET]);
const gatekeeperAccepted = commandPasses("/usr/sbin/spctl", ["--assess", "--type", "execute", APPLE_BRIDGE_TARGET]);
const pairing = getAppleBridgeCredential();
const health = await fetchAppleBridgeHealth();
const capabilities = health?.permissions?.capabilities ?? {};
const enabledCount = Object.values(capabilities).filter(Boolean).length;

console.log(`  Installed:  ${pc.green("yes")} (${APPLE_BRIDGE_TARGET})`);
console.log(`  Version:    ${pc.cyan(version)}`);
console.log(`  Bundle ID:  ${bundleID === APPLE_BRIDGE_BUNDLE_ID ? pc.green(bundleID) : pc.red(bundleID ?? "missing")}`);
console.log(`  Signature:  ${signatureValid ? pc.green("valid") : pc.red("invalid")}`);
console.log(`  Gatekeeper: ${gatekeeperAccepted ? pc.green("accepted (notarized)") : pc.red("not accepted")}`);
console.log(`  Paired:     ${pairing ? pc.green("yes") : pc.red("no")}`);
console.log(`  Service:    ${health ? pc.green("running and ready") : pc.yellow("not reachable")}`);
if (health) console.log(`  Permissions: ${enabledCount} of ${Object.keys(capabilities).length} actions enabled`);
if (!pairing) console.log(pc.dim("  Start Agent Server, run `bun run apple-bridge:code`, and enter the code in the app."));
else if (!health) console.log(pc.dim("  Launch the app from /Applications or enable Launch at Login in its menu-bar window."));
console.log();
