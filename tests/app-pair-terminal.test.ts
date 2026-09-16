import { describe, expect, test } from "bun:test";
import { terminalQRCode } from "../src/app-pair-terminal.js";

describe("Terminal pairing QR", () => {
  test("uses explicit colors and preserves both modules in each cell", () => {
    expect(terminalQRCode(["01", "10"], 2)).toBe("\x1b[38;2;0;0;0m\x1b[48;2;255;255;255m▄▀\x1b[0m");
    expect(terminalQRCode(["1"], 1)).toContain("▀");
  });

  test("does not wrap a QR in a narrow terminal", () => {
    expect(terminalQRCode(["01", "10"], 1)).toBeUndefined();
    expect(terminalQRCode(["01", "10"])).toBeDefined();
  });

  test("refuses malformed renderer output", () => {
    for (const value of [null, [], ["0", "00"], ["x"], [[1]], Array(186).fill("0".repeat(186))]) {
      expect(() => terminalQRCode(value)).toThrow();
    }
  });
});
