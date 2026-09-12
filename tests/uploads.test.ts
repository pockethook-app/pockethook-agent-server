import { describe, expect, test } from "bun:test";
import {
  saveUpload,
  readUpload,
  getUploadById,
  isImageUpload,
  supportedUploadMime,
  UPLOAD_MARKER_RE,
} from "../src/uploads.js";

describe("uploads", () => {
  test("accepts supported mime types and rejects others", () => {
    expect(supportedUploadMime("image/jpeg")).toBe(true);
    expect(supportedUploadMime("application/pdf")).toBe(true);
    expect(supportedUploadMime("application/x-msdownload")).toBe(false);
  });

  test("stores and serves an upload round-trip", () => {
    const bytes = new TextEncoder().encode("hello attachment");
    const meta = saveUpload(bytes, "text/plain", "notas.txt");
    expect(meta.name).toBe("notas.txt");
    expect(meta.file.endsWith(".txt")).toBe(true);

    const served = readUpload(meta.file);
    expect(served).toBeDefined();
    expect(served!.contentType).toBe("text/plain");
    expect(new TextDecoder().decode(served!.data)).toBe("hello attachment");

    const byId = getUploadById(meta.id);
    expect(byId).toBeDefined();
    expect(byId!.name).toBe("notas.txt");
    expect(isImageUpload(byId!)).toBe(false);
  });

  test("rejects empty and oversized names gracefully", () => {
    expect(() => saveUpload(new Uint8Array(), "text/plain")).toThrow("Empty file");
    expect(() => saveUpload(new TextEncoder().encode("x"), "video/mp4")).toThrow("Unsupported");
  });

  test("readUpload refuses traversal and unknown extensions", () => {
    expect(readUpload("../../.env")).toBeUndefined();
    expect(readUpload("00000000-0000-0000-0000-000000000000.exe")).toBeUndefined();
  });

  test("marker regex matches uuids only", () => {
    const text = "mira esto [FILE:123e4567-e89b-12d3-a456-426614174000] y [FILE:nope]";
    const ids = [...text.matchAll(UPLOAD_MARKER_RE)].map((m) => m[1]);
    expect(ids).toEqual(["123e4567-e89b-12d3-a456-426614174000"]);
  });

  test("marker regex accepts file and name suffixes (v2)", () => {
    const text = "foto [FILE:123e4567-e89b-12d3-a456-426614174000.jpg|mi foto.jpg] fin";
    const matches = [...text.matchAll(UPLOAD_MARKER_RE)];
    expect(matches.length).toBe(1);
    expect(matches[0]![1]).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(matches[0]![0]).toBe("[FILE:123e4567-e89b-12d3-a456-426614174000.jpg|mi foto.jpg]");
  });
});
