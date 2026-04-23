/**
 * Instance identity helpers.
 *
 * A single host may run multiple checkouts of pockethook-agent-server (e.g.
 * personal + demo). Every service label, log dir, and pgrep pattern is
 * derived from the instance name to keep them isolated.
 *
 * Resolution order:
 *   1. `INSTANCE_NAME` env var (slugified).
 *   2. Slug of the project root directory basename.
 */

import { basename, dirname } from "path";
import { fileURLToPath } from "url";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "instance";
}

export function toPascalCase(s: string): string {
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function getInstanceName(): string {
  const override = process.env.INSTANCE_NAME?.trim();
  if (override) return slugify(override);
  const slug = slugify(basename(PROJECT_ROOT));
  return slug.replace(/^pockethook-/, "") || "instance";
}
