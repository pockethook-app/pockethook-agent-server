#!/usr/bin/env bun
/**
 * sync-docs
 *
 * Standalone utility that copies the English documentation from
 * pockethook-web to pockethook-agent-server-public/docs/ so the agent can
 * load docs on-demand via its `load_doc` tool.
 *
 * Source:  ../../pockethook-web/content/docs/*.md  (files without a locale suffix)
 * Dest:    ../../pockethook-agent-server-public/docs/*.md
 *
 * Run manually from this folder:
 *   bun run sync-docs.ts [source-directory] [destination-directory] [one-file.md]
 *
 * Not invoked from either project's package.json — keep it that way.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

if (!process.argv[2] || !process.argv[3]) {
  console.error("Usage: bun scripts/sync-docs.ts <website-docs> <server-docs> [one-file.md]");
  process.exit(1);
}
const SRC_DIR = resolve(process.argv[2]);
const DEST_DIR = resolve(process.argv[3]);
const ONLY = process.argv[4];

// Files we do not copy: index/landing pages are navigation, not docs.
const EXCLUDED_SOURCES = new Set(["_index.md"]);

// Only the English originals — any file containing a locale suffix
// (e.g. foo.es.md, foo.en-gb.md) is a Hugo translation and skipped.
function isEnglishSource(filename: string): boolean {
  if (!filename.endsWith(".md")) return false;
  if (EXCLUDED_SOURCES.has(filename)) return false;
  // Strip the .md extension, then check for a locale suffix like ".es" or ".en-gb".
  const base = filename.slice(0, -3);
  // A locale suffix is ".xx" or ".xx-yy" at the end. Detect by looking for a dot.
  return !base.includes(".");
}

interface ParsedDoc {
  title: string;
  description: string;
  body: string;
}

/**
 * Parse Hugo frontmatter (YAML between ---) and return the fields we keep
 * plus the remaining body.
 */
function parseHugoDoc(content: string, filename: string): ParsedDoc | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    console.warn(`[skip] ${filename}: no frontmatter found`);
    return null;
  }
  const fm = fmMatch[1]!;
  const body = fmMatch[2] ?? "";

  const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const descMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);

  if (!titleMatch) {
    console.warn(`[skip] ${filename}: no title in frontmatter`);
    return null;
  }

  const title = titleMatch[1]!.trim();
  const description = descMatch?.[1]?.trim() ?? "";

  return { title, description, body };
}

/**
 * Strip Hugo shortcodes that aren't useful to the LLM.
 * Shortcodes look like {{< name args >}} or {{% name %}} and come in
 * paired/unpaired forms. We remove the tags but keep any inner text.
 */
function stripShortcodes(body: string): string {
  let out = body;
  // Remove opening/closing rawhtml tags completely; keep inner HTML.
  out = out.replace(/\{\{<\s*\/?\s*rawhtml\s*>\}\}/g, "");
  // Drop any other Hugo shortcodes entirely (opening and closing).
  out = out.replace(/\{\{<[^>]*>\}\}/g, "");
  out = out.replace(/\{\{%[^%]*%\}\}/g, "");
  // Collapse runs of blank lines introduced by removed tags.
  out = out.replace(/\n{3,}/g, "\n\n").trimStart();
  return out;
}

function escapeYamlValue(value: string): string {
  // Wrap in double quotes and escape internal double quotes / backslashes.
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function buildDocFile(doc: ParsedDoc): string {
  const fm = [
    "---",
    `title: ${escapeYamlValue(doc.title)}`,
    `description: ${escapeYamlValue(doc.description)}`,
    "---",
    "",
  ].join("\n");
  const body = stripShortcodes(doc.body).trim();
  return fm + body + "\n";
}

function contentsMatch(path: string, nextContent: string): boolean {
  try {
    const current = readFileSync(path, "utf-8");
    return current === nextContent;
  } catch {
    return false;
  }
}

function main(): number {
  if (SRC_DIR === DEST_DIR) throw new Error("Source and destination must differ");
  if (!existsSync(SRC_DIR)) {
    console.warn(`[sync-docs] source missing: ${SRC_DIR}`);
    console.warn("[sync-docs] nothing to do — is pockethook-web checked out?");
    return 1;
  }
  if (!existsSync(DEST_DIR)) {
    mkdirSync(DEST_DIR, { recursive: true });
    console.log(`[sync-docs] created ${DEST_DIR}`);
  }

  const srcFiles = readdirSync(SRC_DIR).filter(isEnglishSource).filter((file) => !ONLY || file === ONLY).sort();
  const expectedDest = new Set<string>();

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const file of srcFiles) {
    const srcPath = join(SRC_DIR, file);
    const raw = readFileSync(srcPath, "utf-8");
    const parsed = parseHugoDoc(raw, file);
    if (!parsed) continue;

    const outContent = buildDocFile(parsed);
    const destPath = join(DEST_DIR, file);
    expectedDest.add(file);

    if (!existsSync(destPath)) {
      writeFileSync(destPath, outContent, "utf-8");
      created++;
      console.log(`  + ${file}`);
      continue;
    }
    if (contentsMatch(destPath, outContent)) {
      unchanged++;
      continue;
    }
    writeFileSync(destPath, outContent, "utf-8");
    updated++;
    console.log(`  ~ ${file}`);
  }

  // Destination-only framework guides belong to the server; never delete them.
  const total = created + updated + unchanged;
  console.log(
    `\n[sync-docs] synced ${total} docs (${created} created, ${updated} updated, ${unchanged} unchanged)`,
  );
  return 0;
}

process.exit(main());
