import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, utimesSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const USER_DIR = join(PROJECT_ROOT, "data", "user");
const USER_PREFS = join(USER_DIR, "prefs.json");
const USER_INSTRUCTIONS = join(USER_DIR, "instructions.md");
const USER_SKILLS_DIR = join(USER_DIR, "skills");

// Back up and restore any existing user files so the test is non-destructive
// when run against a real deployment.
let prefsBackup: string | null = null;
let instructionsBackup: string | null = null;

beforeEach(() => {
  if (existsSync(USER_PREFS)) prefsBackup = readFileSync(USER_PREFS, "utf-8");
  if (existsSync(USER_INSTRUCTIONS)) instructionsBackup = readFileSync(USER_INSTRUCTIONS, "utf-8");
  if (!existsSync(USER_SKILLS_DIR)) mkdirSync(USER_SKILLS_DIR, { recursive: true });
});

afterEach(() => {
  if (prefsBackup !== null) writeFileSync(USER_PREFS, prefsBackup, "utf-8");
  else if (existsSync(USER_PREFS)) rmSync(USER_PREFS);
  if (instructionsBackup !== null) writeFileSync(USER_INSTRUCTIONS, instructionsBackup, "utf-8");
  else if (existsSync(USER_INSTRUCTIONS)) rmSync(USER_INSTRUCTIONS);
  prefsBackup = null;
  instructionsBackup = null;
});

// The prefs loader caches by mtime. Tests run fast enough that consecutive
// writes may share the same mtime, so we stamp each write with a monotonic
// future timestamp to force the cache to refresh.
let mtimeTick = Date.now();
function writePrefs(data: unknown): void {
  writeFileSync(USER_PREFS, JSON.stringify(data));
  mtimeTick += 1000;
  const t = new Date(mtimeTick);
  utimesSync(USER_PREFS, t, t);
}

describe("interpolatePrefs", () => {
  test("substitutes top-level keys in skill content", async () => {
    writePrefs({ routeOrigin: "Madrid" });
    const { interpolatePrefs } = await import("../src/config.js");
    const out = interpolatePrefs("Start from {{prefs.routeOrigin}} by default.");
    expect(out).toBe("Start from Madrid by default.");
  });

  test("leaves unknown keys untouched so typos are visible", async () => {
    writePrefs({ routeOrigin: "Madrid" });
    const { interpolatePrefs } = await import("../src/config.js");
    const out = interpolatePrefs("No default for {{prefs.somethingElse}}.");
    expect(out).toBe("No default for {{prefs.somethingElse}}.");
  });

  test("supports nested keys", async () => {
    writePrefs({ tunnel: { domain: "foo.ts.net" } });
    const { interpolatePrefs } = await import("../src/config.js");
    const out = interpolatePrefs("Use {{prefs.tunnel.domain}} for exposure.");
    expect(out).toBe("Use foo.ts.net for exposure.");
  });

  test("returns text unchanged when there are no placeholders", async () => {
    const { interpolatePrefs } = await import("../src/config.js");
    expect(interpolatePrefs("plain text")).toBe("plain text");
  });
});

describe("system prompt — user customization layout", () => {
  test("mentions the user-writable directories and the read-only base rule", async () => {
    const { getSystemPrompt } = await import("../src/config.js");
    const prompt = getSystemPrompt("TestBot");
    expect(prompt).toContain("data/user/skills");
    expect(prompt).toContain("data/user/custom-tools");
    expect(prompt).toContain("data/user/instructions.md");
    expect(prompt).toContain("data/user/prefs.json");
    expect(prompt.toLowerCase()).toContain("read-only");
  });
});
