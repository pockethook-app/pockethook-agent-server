import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  APPLE_BRIDGE_APP_NAME,
  APPLE_BRIDGE_BUNDLE_ID,
  APPLE_BRIDGE_BUNDLED_ZIP,
  readBundleValue,
} from "../src/apple-bridge-app.js";

const describeMac = process.platform === "darwin" ? describe : describe.skip;

describeMac("bundled Apple Bridge release", () => {
  const work = mkdtempSync(join(tmpdir(), "pockethook-apple-bridge-package-test-"));
  const appPath = join(work, APPLE_BRIDGE_APP_NAME);

  afterAll(() => rmSync(work, { recursive: true, force: true }));

  test("contains the expected signed and notarized app", () => {
    expect(existsSync(APPLE_BRIDGE_BUNDLED_ZIP)).toBe(true);
    execFileSync("/usr/bin/ditto", ["-x", "-k", APPLE_BRIDGE_BUNDLED_ZIP, work]);

    expect(existsSync(appPath)).toBe(true);
    expect(readBundleValue(appPath, "CFBundleIdentifier")).toBe(APPLE_BRIDGE_BUNDLE_ID);
    expect(readBundleValue(appPath, "CFBundleShortVersionString")).toBe("0.6.0");
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "ignore" });
    execFileSync("/usr/sbin/spctl", ["--assess", "--type", "execute", appPath], { stdio: "ignore" });
    execFileSync("/usr/bin/xcrun", ["stapler", "validate", appPath], { stdio: "ignore" });
  });
});
