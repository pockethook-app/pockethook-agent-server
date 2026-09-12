import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AppleBridgePairingStore } from "../src/apple-bridge-pairing.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function store(): { store: AppleBridgePairingStore; file: string } {
  const directory = mkdtempSync(join(tmpdir(), "apple-bridge-pairing-test-"));
  temporaryDirectories.push(directory);
  const file = join(directory, "apple-bridge.json");
  return { store: new AppleBridgePairingStore(file), file };
}

describe("Apple Bridge pairing", () => {
  test("uses one-time codes and persists only the generated credential", () => {
    const { store: pairing, file } = store();
    const { code } = pairing.createCode();
    const result = pairing.pair("installation-1", code.toLowerCase());

    expect(result.credential).toMatch(/^[0-9a-f-]{36}$/i);
    expect(pairing.activeCredential()?.credential).toBe(result.credential);
    expect(() => pairing.pair("installation-2", code)).toThrow("invalid or expired");
    expect(readFileSync(file, "utf-8")).not.toContain(code);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("rejects invalid codes and reloads credentials", () => {
    const { store: pairing, file } = store();
    expect(() => pairing.pair("installation-1", "BAD-CODE")).toThrow("invalid or expired");
    const { code } = pairing.createCode();
    const { credential } = pairing.pair("installation-1", code);
    expect(new AppleBridgePairingStore(file).activeCredential()?.credential).toBe(credential);
  });

  test("re-pairing replaces a stale local installation", () => {
    const { store: pairing } = store();
    const first = pairing.createCode();
    pairing.pair("old-installation", first.code);
    const second = pairing.createCode();
    pairing.pair("new-installation", second.code);
    expect(pairing.status().paired.map((entry) => entry.installationId)).toEqual(["new-installation"]);
  });
});
