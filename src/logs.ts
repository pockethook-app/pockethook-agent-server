/**
 * Cross-platform service log viewer.
 * Usage: bun run logs
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getInstanceName } from "./instance.js";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(PROJECT_ROOT, "data");
const PLATFORM = process.platform;
const INSTANCE_NAME = getInstanceName();

if (PLATFORM === "darwin") {
  const logDir = join(process.env.HOME || "~", "Library", "Logs", `pockethook-${INSTANCE_NAME}`);
  const stdout = join(logDir, "service.stdout.log");
  const stderr = join(logDir, "service.stderr.log");

  if (!existsSync(stdout) && !existsSync(stderr)) {
    console.error("No service logs found. Is the service installed? Run: bun run service install");
    process.exit(1);
  }

  const files = [stdout, stderr].filter(existsSync);
  // Show last 50 lines then follow
  execSync(`tail -n 50 -f ${files.join(" ")}`, { stdio: "inherit" });
} else if (PLATFORM === "linux") {
  try {
    execSync(`journalctl --user -u pockethook-${INSTANCE_NAME} -f --no-pager`, { stdio: "inherit" });
  } catch {
    // Fallback to log files if journalctl is not available
    const stdout = join(DATA_DIR, "service.stdout.log");
    const stderr = join(DATA_DIR, "service.stderr.log");
    const files = [stdout, stderr].filter(existsSync);
    if (files.length === 0) {
      console.error("No service logs found. Is the service installed? Run: bun run service install");
      process.exit(1);
    }
    execSync(`tail -f ${files.join(" ")}`, { stdio: "inherit" });
  }
} else if (PLATFORM === "win32") {
  const stdout = join(DATA_DIR, "service.stdout.log");
  const stderr = join(DATA_DIR, "service.stderr.log");

  if (!existsSync(stdout) && !existsSync(stderr)) {
    console.error("No service logs found. Is the service installed? Run: bun run service install");
    process.exit(1);
  }

  // PowerShell Get-Content -Wait is the Windows equivalent of tail -f
  const files = [stdout, stderr].filter(existsSync).map((f) => `'${f}'`).join(", ");
  execSync(`powershell -Command "Get-Content -Path ${files} -Wait -Tail 50"`, { stdio: "inherit" });
} else {
  console.error(`Unsupported platform: ${PLATFORM}`);
  process.exit(1);
}
