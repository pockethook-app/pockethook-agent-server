import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getAppleBridgeCredential } from "./apple-bridge-pairing.js";

export const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const APPLE_BRIDGE_APP_NAME = "PocketHook Apple Bridge.app";
export const APPLE_BRIDGE_EXECUTABLE_NAME = "PocketHookAppleBridge";
export const APPLE_BRIDGE_BUNDLE_ID = "app.pockethook.apple-bridge";
export const APPLE_BRIDGE_TARGET = join("/Applications", APPLE_BRIDGE_APP_NAME);
export const APPLE_BRIDGE_BUNDLED_ZIP = join(
  PROJECT_ROOT,
  "assets",
  "apple-bridge",
  "PocketHook-Apple-Bridge.zip",
);
export const APPLE_BRIDGE_DEFAULT_URL = "https://pockethook.app/downloads/PocketHook-Apple-Bridge.zip";
export const APPLE_BRIDGE_DEFAULT_SERVICE_URL = "http://127.0.0.1:32123";

export interface AppleBridgeHealth {
  name: string;
  version: string;
  permissions?: {
    capabilities?: Record<string, boolean>;
    [key: string]: unknown;
  };
}

interface AppleBridgeHealthEnvelope {
  result?: AppleBridgeHealth;
}

export function resolveAppleBridgeInstallSource(
  cliSource = process.argv[2],
  envSource = process.env.APPLE_BRIDGE_APP_URL,
  bundledExists = existsSync(APPLE_BRIDGE_BUNDLED_ZIP),
): string {
  return cliSource || envSource || (bundledExists ? APPLE_BRIDGE_BUNDLED_ZIP : APPLE_BRIDGE_DEFAULT_URL);
}

export function readBundleValue(appPath: string, key: string): string | null {
  try {
    return execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(appPath, "Contents", "Info.plist")], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export async function fetchAppleBridgeHealth(
  serviceUrl = process.env.APPLE_BRIDGE_URL || APPLE_BRIDGE_DEFAULT_SERVICE_URL,
  timeoutMs = 2_000,
  credential = getAppleBridgeCredential()?.credential,
): Promise<AppleBridgeHealth | null> {
  if (!credential) return null;
  try {
    const response = await fetch(`${serviceUrl.replace(/\/$/, "")}/health`, {
      headers: { Authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const envelope = await response.json() as AppleBridgeHealthEnvelope;
    return envelope.result ?? null;
  } catch {
    return null;
  }
}
