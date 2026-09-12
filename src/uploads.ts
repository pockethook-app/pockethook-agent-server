/**
 * File uploads from the PocketHook app / Share Extension.
 *
 * Files are stored in data/uploads as <uuid>.<ext> with a <uuid>.json
 * metadata sidecar. Downloads require the same authentication as uploads.
 * Chat messages reference uploads with
 * [FILE:<uuid>] markers; the chat pipeline turns image uploads into
 * vision input and inlines the text of textual files.
 */

import { randomUUID } from "crypto";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { logger } from "./logger.js";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const UPLOADS_DIR = join(PROJECT_ROOT, "data", "uploads");

export const MAX_UPLOAD_BYTES = (Number(process.env.UPLOADS_MAX_MB) || 25) * 1024 * 1024;
const RETENTION_DAYS = Number(process.env.UPLOADS_RETENTION_DAYS) || 30;

/**
 * Marker the app embeds in chatInput to reference an upload. Newer app
 * builds append the stored filename and display name so the chat UI can
 * render attachments without a lookup: [FILE:<uuid>.<ext>|<name>]. Only
 * the uuid matters here.
 */
export const UPLOAD_MARKER_RE =
  /\[FILE:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.[a-z0-9]+)?(?:\|[^\]]*)?\]/gi;

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
};

const EXT_TO_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_TO_EXT).map(([mime, ext]) => [ext, mime]),
);

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_MIMES = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);

/** Max characters of extracted file text inlined into the prompt. */
const MAX_INLINE_TEXT = 50_000;

export interface UploadMeta {
  id: string;
  file: string;
  name: string;
  mimeType: string;
  size: number;
  uploadedAt: number;
}

function ensureDir(): void {
  if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true, mode: 0o700 });
}

export function supportedUploadMime(mimeType: string): boolean {
  return Object.hasOwn(MIME_TO_EXT, mimeType);
}

export function saveUpload(bytes: Uint8Array, mimeType: string, originalName?: string): UploadMeta {
  const ext = MIME_TO_EXT[mimeType];
  if (!ext) throw new Error(`Unsupported file type: ${mimeType}`);
  if (bytes.byteLength === 0) throw new Error("Empty file");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(`File too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)`);
  }
  ensureDir();
  const id = randomUUID();
  const file = `${id}.${ext}`;
  const meta: UploadMeta = {
    id,
    file,
    name: (originalName || file).slice(0, 200),
    mimeType,
    size: bytes.byteLength,
    uploadedAt: Date.now(),
  };
  writeFileSync(join(UPLOADS_DIR, file), bytes, { mode: 0o600 });
  writeFileSync(join(UPLOADS_DIR, `${id}.json`), JSON.stringify(meta), { mode: 0o600 });
  logger.info("Upload stored", { id, mimeType, size: meta.size });
  return meta;
}

/** Serve a stored upload by its <uuid>.<ext> filename. */
export function readUpload(file: string): { data: Uint8Array<ArrayBuffer>; contentType: string } | undefined {
  const match = /^([0-9a-f-]{36})\.([a-z0-9]+)$/.exec(file);
  if (!match) return undefined;
  const meta = getUploadById(match[1]!);
  if (!meta || meta.file !== file) return undefined;
  const contentType = EXT_TO_MIME[match[2] ?? ""];
  if (!contentType) return undefined;
  const path = join(UPLOADS_DIR, file);
  if (!existsSync(path)) return undefined;
  return { data: Uint8Array.from(readFileSync(path)), contentType };
}

export function getUploadById(id: string): (UploadMeta & { path: string }) | undefined {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return undefined;
  const metaPath = join(UPLOADS_DIR, `${id}.json`);
  if (!existsSync(metaPath)) return undefined;
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as UploadMeta;
    if (meta.id !== id || !new RegExp(`^${id}\\.[a-z0-9]+$`).test(meta.file) ||
        !Number.isFinite(meta.uploadedAt) || Date.now() - meta.uploadedAt > RETENTION_DAYS * 86400_000) return undefined;
    const path = join(UPLOADS_DIR, meta.file);
    if (!existsSync(path)) return undefined;
    return { ...meta, path };
  } catch {
    return undefined;
  }
}

export function isImageUpload(meta: UploadMeta): boolean {
  return IMAGE_MIMES.has(meta.mimeType);
}

/**
 * Extracts inline-able text from a textual or PDF upload. Returns null for
 * images and anything that can't be extracted.
 */
export async function extractUploadText(meta: UploadMeta & { path: string }): Promise<string | null> {
  try {
    if (TEXT_MIMES.has(meta.mimeType)) {
      return readFileSync(meta.path, "utf8").slice(0, MAX_INLINE_TEXT);
    }
    if (meta.mimeType === "application/pdf") {
      const { default: pdfParse } = await import("pdf-parse");
      const parsed = await pdfParse(readFileSync(meta.path));
      const text = (parsed.text || "").trim();
      return text ? text.slice(0, MAX_INLINE_TEXT) : null;
    }
  } catch (err) {
    logger.warn("Upload text extraction failed", {
      id: meta.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

/** Deletes uploads (and their sidecars) older than the retention window. */
export function cleanupUploads(): number {
  if (!existsSync(UPLOADS_DIR)) return 0;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of readdirSync(UPLOADS_DIR)) {
    const path = join(UPLOADS_DIR, entry);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        unlinkSync(path);
        removed++;
      }
    } catch {
      // Raced with another cleanup — ignore.
    }
  }
  if (removed > 0) logger.info(`Cleaned ${removed} expired upload file(s)`);
  return removed;
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function initUploads(): void {
  ensureDir();
  cleanupUploads();
  if (!cleanupTimer) {
    cleanupTimer = setInterval(cleanupUploads, 12 * 60 * 60 * 1000);
  }
}
