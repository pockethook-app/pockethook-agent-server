/**
 * Versioning system for user data safety.
 *
 * Two strategies:
 * 1. Git repo in workspace/ — tracks agent-created files (dashboard, projects)
 * 2. Snapshot backups in data/backups/ — tracks config files (agent-instructions, skills, permissions)
 *
 * Git is optional — if not available, workspace changes are unversioned.
 * Config backups always work (plain file copies with timestamps).
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, copyFileSync } from "fs";
import { dirname, join, basename, relative } from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger.js";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKSPACE_DIR = join(PROJECT_ROOT, "workspace");
const BACKUPS_DIR = join(PROJECT_ROOT, "data", "backups");
const MAX_BACKUPS_PER_FILE = 20;

// ── Git availability ──────────────────────────────────────────────────

let gitAvailable: boolean | null = null;

function hasGit(): boolean {
  if (gitAvailable !== null) return gitAvailable;
  try {
    execSync("git --version", { stdio: "ignore" });
    gitAvailable = true;
  } catch {
    gitAvailable = false;
  }
  return gitAvailable;
}

// ── Workspace git repo ──────────────────────────────────────────────────

let workspaceGitInitialized = false;

/**
 * Initialize a git repo in workspace/ if git is available.
 * Safe to call multiple times — only initializes once.
 */
export function initWorkspaceGit(): boolean {
  if (workspaceGitInitialized) return true;
  if (!hasGit()) {
    logger.info("Git not available — workspace versioning disabled");
    return false;
  }

  try {
    if (!existsSync(WORKSPACE_DIR)) {
      mkdirSync(WORKSPACE_DIR, { recursive: true });
    }

    const gitDir = join(WORKSPACE_DIR, ".git");
    if (!existsSync(gitDir)) {
      execSync("git init", { cwd: WORKSPACE_DIR, stdio: "ignore" });
      // Initial commit so we have a base to diff against
      execSync('git commit --allow-empty -m "init: workspace created"', {
        cwd: WORKSPACE_DIR,
        stdio: "ignore",
        env: { ...process.env, GIT_AUTHOR_NAME: "PocketHook", GIT_AUTHOR_EMAIL: "agent@pockethook", GIT_COMMITTER_NAME: "PocketHook", GIT_COMMITTER_EMAIL: "agent@pockethook" },
      });
      logger.info("Workspace git repo initialized");
    }

    workspaceGitInitialized = true;
    return true;
  } catch (err) {
    logger.error("Failed to initialize workspace git", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Auto-commit all changes in workspace/ with a descriptive message.
 */
export function commitWorkspace(message: string): boolean {
  if (!workspaceGitInitialized || !hasGit()) return false;

  try {
    // Check if there are changes to commit
    const status = execSync("git status --porcelain", { cwd: WORKSPACE_DIR, encoding: "utf-8" }).trim();
    if (!status) return false; // Nothing to commit

    execSync("git add -A", { cwd: WORKSPACE_DIR, stdio: "ignore" });
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
      cwd: WORKSPACE_DIR,
      stdio: "ignore",
      env: { ...process.env, GIT_AUTHOR_NAME: "PocketHook", GIT_AUTHOR_EMAIL: "agent@pockethook", GIT_COMMITTER_NAME: "PocketHook", GIT_COMMITTER_EMAIL: "agent@pockethook" },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Revert the last commit in workspace/.
 * Returns the reverted commit message or null if nothing to revert.
 */
export function revertLastWorkspaceCommit(): string | null {
  if (!workspaceGitInitialized || !hasGit()) return null;

  try {
    // Check we have more than the initial commit
    const count = execSync("git rev-list --count HEAD", { cwd: WORKSPACE_DIR, encoding: "utf-8" }).trim();
    if (parseInt(count, 10) <= 1) return null;

    const lastMsg = execSync("git log -1 --pretty=%s", { cwd: WORKSPACE_DIR, encoding: "utf-8" }).trim();
    execSync("git revert HEAD --no-edit", {
      cwd: WORKSPACE_DIR,
      stdio: "ignore",
      env: { ...process.env, GIT_AUTHOR_NAME: "PocketHook", GIT_AUTHOR_EMAIL: "agent@pockethook", GIT_COMMITTER_NAME: "PocketHook", GIT_COMMITTER_EMAIL: "agent@pockethook" },
    });
    return lastMsg;
  } catch {
    return null;
  }
}

/**
 * Get recent workspace commit history.
 */
export function getWorkspaceHistory(limit = 10): string[] {
  if (!workspaceGitInitialized || !hasGit()) return [];

  try {
    const log = execSync(`git log --oneline -${limit}`, { cwd: WORKSPACE_DIR, encoding: "utf-8" }).trim();
    return log ? log.split("\n") : [];
  } catch {
    return [];
  }
}

// ── Config backups ────────────────────────────────────────────────────

/**
 * Files tracked for config backups (relative to PROJECT_ROOT).
 */
const CONFIG_FILES = [
  "agent-instructions.md",
  "permissions.json",
];

function ensureBackupsDir(): void {
  if (!existsSync(BACKUPS_DIR)) {
    mkdirSync(BACKUPS_DIR, { recursive: true });
  }
}

/**
 * Create a backup of a config file before it's modified.
 * Backups are stored as: data/backups/{filename}.{timestamp}
 */
export function backupConfigFile(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) return false;

    ensureBackupsDir();
    const name = basename(filePath);
    const timestamp = Date.now();
    const backupPath = join(BACKUPS_DIR, `${name}.${timestamp}`);
    copyFileSync(filePath, backupPath);

    // Prune old backups
    pruneBackups(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Backup all skill files as a single snapshot.
 * Stored as: data/backups/skills.{timestamp}.json
 */
export function backupSkills(): boolean {
  const skillsDir = join(PROJECT_ROOT, "skills");
  if (!existsSync(skillsDir)) return false;

  try {
    ensureBackupsDir();
    const files = readdirSync(skillsDir).filter(f => f.endsWith(".md") || f.endsWith(".txt"));
    const snapshot: Record<string, string> = {};
    for (const file of files) {
      snapshot[file] = readFileSync(join(skillsDir, file), "utf-8");
    }

    const timestamp = Date.now();
    writeFileSync(
      join(BACKUPS_DIR, `skills.${timestamp}.json`),
      JSON.stringify(snapshot, null, 2),
    );

    pruneBackups("skills", ".json");
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore a config file from the most recent backup.
 * Returns the timestamp of the restored backup or null.
 */
export function restoreConfigFile(filePath: string): number | null {
  try {
    ensureBackupsDir();
    const name = basename(filePath);
    const backups = getBackupsFor(name);
    if (backups.length === 0) return null;

    const latest = backups[0]!; // sorted newest first
    copyFileSync(join(BACKUPS_DIR, latest.filename), filePath);
    return latest.timestamp;
  } catch {
    return null;
  }
}

/**
 * Restore skills from the most recent snapshot.
 */
export function restoreSkills(): number | null {
  const skillsDir = join(PROJECT_ROOT, "skills");

  try {
    ensureBackupsDir();
    const backups = getBackupsFor("skills", ".json");
    if (backups.length === 0) return null;

    const latest = backups[0]!;
    const snapshot = JSON.parse(readFileSync(join(BACKUPS_DIR, latest.filename), "utf-8"));

    if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true });

    // Remove current skills
    const current = readdirSync(skillsDir).filter(f => f.endsWith(".md") || f.endsWith(".txt"));
    for (const file of current) {
      unlinkSync(join(skillsDir, file));
    }

    // Restore from snapshot
    for (const [file, content] of Object.entries(snapshot)) {
      writeFileSync(join(skillsDir, file), content as string);
    }

    return latest.timestamp;
  } catch {
    return null;
  }
}

/**
 * List available backups for a config file.
 */
export function listBackups(name: string, ext = ""): { filename: string; timestamp: number; date: string }[] {
  return getBackupsFor(name, ext).map(b => ({
    ...b,
    date: new Date(b.timestamp).toISOString(),
  }));
}

// ── Internal helpers ──────────────────────────────────────────────────

interface BackupEntry {
  filename: string;
  timestamp: number;
}

function getBackupsFor(name: string, ext = ""): BackupEntry[] {
  if (!existsSync(BACKUPS_DIR)) return [];

  const prefix = name + ".";
  const suffix = ext;
  const entries: BackupEntry[] = [];

  for (const file of readdirSync(BACKUPS_DIR)) {
    if (!file.startsWith(prefix)) continue;
    if (suffix && !file.endsWith(suffix)) continue;

    // Extract timestamp: filename.{timestamp} or filename.{timestamp}.json
    const rest = file.slice(prefix.length);
    const tsStr = suffix ? rest.slice(0, -suffix.length) : rest;
    const ts = parseInt(tsStr, 10);
    if (!isNaN(ts)) {
      entries.push({ filename: file, timestamp: ts });
    }
  }

  // Newest first
  return entries.sort((a, b) => b.timestamp - a.timestamp);
}

function pruneBackups(name: string, ext = ""): void {
  const backups = getBackupsFor(name, ext);
  if (backups.length <= MAX_BACKUPS_PER_FILE) return;

  // Remove oldest backups beyond the limit
  const toRemove = backups.slice(MAX_BACKUPS_PER_FILE);
  for (const entry of toRemove) {
    try {
      unlinkSync(join(BACKUPS_DIR, entry.filename));
    } catch {}
  }
}

// ── Paths for external use ──────────────────────────────────────────────

export const configPaths = {
  agentInstructions: join(PROJECT_ROOT, "agent-instructions.md"),
  permissions: join(PROJECT_ROOT, "permissions.json"),
  skillsDir: join(PROJECT_ROOT, "skills"),
  customToolsDir: join(PROJECT_ROOT, "custom-tools"),
};
