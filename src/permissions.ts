/**
 * Granular permissions system for agent tools.
 *
 * Config stored in permissions.json (project root).
 * Enforced in each tool's execute method before performing operations.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve, basename } from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger.js";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PERMISSIONS_PATH = join(PROJECT_ROOT, "permissions.json");

// Paths outside working dir that the agent is allowed to access
const ALLOWED_EXTERNAL_PATHS = [
  join(PROJECT_ROOT, "skills"),
  join(PROJECT_ROOT, "docs"),
  join(PROJECT_ROOT, "custom-tools"),
  join(PROJECT_ROOT, "agent-instructions.md"),
];

// ── Types ────────────────────────────────────────────────────────────────

export interface ShellPermissions {
  blockedCommands: string[];
  blockedPatterns: string[];
}

export interface FilesystemPermissions {
  blockedPaths: string[];
  blockedPatterns: string[];
}

export interface Permissions {
  tools: string[];
  shell: ShellPermissions;
  filesystem: FilesystemPermissions;
  enforceWorkingDir: boolean;
}

// ── Defaults ─────────────────────────────────────────────────────────────

export const DEFAULT_PERMISSIONS: Permissions = {
  tools: ["shell", "read", "write", "ls", "create_job", "list_jobs", "delete_job", "web_search", "web_fetch", "start_server", "stop_server", "list_servers"],
  shell: {
    blockedCommands: [
      "rm -rf /",
      "sudo",
      "mkfs",
      "dd if=",
      "chmod -R 777",
      "shutdown",
      "reboot",
      "halt",
      "init 0",
      "init 6",
    ],
    blockedPatterns: [
      "sudo\\s+",
      "rm\\s+-rf\\s+/(?!\\w)",
      ">\\s*/etc/",
      "curl.*\\|.*sh",
      "wget.*\\|.*sh",
      "\\.env\\b",
      "\\.git\\b",
      "\\.key\\b",
      "\\.pem\\b",
      "\\.secret\\b",
      "\\.credentials\\b",
      "\\bid_rsa",
      "\\bprintenv\\b",
      "\\bexport\\s+-p\\b",
    ],
  },
  filesystem: {
    blockedPaths: [".env", ".git"],
    blockedPatterns: ["*.key", "*.pem", "*.secret", "*.credentials", "id_rsa*"],
  },
  enforceWorkingDir: true,
};

// ── Load / Save ──────────────────────────────────────────────────────────

export function loadPermissions(toolsEnvFallback?: string): Permissions {
  if (existsSync(PERMISSIONS_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(PERMISSIONS_PATH, "utf-8"));
      return {
        tools: Array.isArray(raw.tools) ? raw.tools : DEFAULT_PERMISSIONS.tools,
        shell: {
          blockedCommands: raw.shell?.blockedCommands ?? DEFAULT_PERMISSIONS.shell.blockedCommands,
          blockedPatterns: raw.shell?.blockedPatterns ?? DEFAULT_PERMISSIONS.shell.blockedPatterns,
        },
        filesystem: {
          blockedPaths: raw.filesystem?.blockedPaths ?? DEFAULT_PERMISSIONS.filesystem.blockedPaths,
          blockedPatterns: raw.filesystem?.blockedPatterns ?? DEFAULT_PERMISSIONS.filesystem.blockedPatterns,
        },
        enforceWorkingDir: raw.enforceWorkingDir ?? DEFAULT_PERMISSIONS.enforceWorkingDir,
      };
    } catch (err) {
      logger.warn("Invalid permissions.json, using defaults", { error: err instanceof Error ? err.message : String(err) });
      return DEFAULT_PERMISSIONS;
    }
  }

  // Migration: if TOOLS env var exists, use it for tool list
  if (toolsEnvFallback) {
    const PRESETS: Record<string, string[]> = {
      all: ["shell", "read", "write", "ls"],
      readonly: ["read", "ls"],
    };
    const tools = PRESETS[toolsEnvFallback] ?? toolsEnvFallback.split(",").map((s) => s.trim());
    return { ...DEFAULT_PERMISSIONS, tools };
  }

  return DEFAULT_PERMISSIONS;
}

export function savePermissions(perms: Permissions): void {
  writeFileSync(PERMISSIONS_PATH, JSON.stringify(perms, null, 2) + "\n");
}

export function permissionsPath(): string {
  return PERMISSIONS_PATH;
}

// ── Check: Shell ─────────────────────────────────────────────────────────

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

export function checkShellPermission(command: string, perms: Permissions): PermissionResult {
  if (!perms.tools.includes("shell")) {
    return { allowed: false, reason: "Shell tool is disabled" };
  }

  // Normalize: collapse whitespace, trim
  const normalized = command.replace(/\s+/g, " ").trim();
  const cmdLower = normalized.toLowerCase();

  // Extract the base command (first word, handles pipes/chains)
  const segments = normalized.split(/[|;&]/).map((s) => s.trim());

  // Check blocked commands — match against each segment's leading command
  for (const blocked of perms.shell.blockedCommands) {
    const blockedLower = blocked.toLowerCase();
    // Check full command substring
    if (cmdLower.includes(blockedLower)) {
      return { allowed: false, reason: `Blocked command: ${blocked}` };
    }
    // Check each pipe/chain segment start
    for (const seg of segments) {
      if (seg.toLowerCase().startsWith(blockedLower)) {
        return { allowed: false, reason: `Blocked command: ${blocked}` };
      }
    }
  }

  // Check blocked patterns (regex match) against full command and each segment
  for (const pattern of perms.shell.blockedPatterns) {
    try {
      const regex = new RegExp(pattern, "i");
      if (regex.test(normalized)) {
        return { allowed: false, reason: `Blocked pattern: ${pattern}` };
      }
      for (const seg of segments) {
        if (regex.test(seg)) {
          return { allowed: false, reason: `Blocked pattern: ${pattern}` };
        }
      }
    } catch (err) {
      logger.warn("Invalid shell blocked pattern, skipping", { pattern, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { allowed: true };
}

// ── Check: Filesystem ────────────────────────────────────────────────────

export function checkPathPermission(
  filePath: string,
  operation: "read" | "write" | "ls",
  workingDir: string,
  perms: Permissions,
): PermissionResult {
  const toolMap: Record<string, string> = { read: "read", write: "write", ls: "ls" };
  const toolName = toolMap[operation]!;

  if (!perms.tools.includes(toolName)) {
    return { allowed: false, reason: `${toolName} tool is disabled` };
  }

  const resolvedCwd = resolve(workingDir);
  const resolvedPath = resolve(workingDir, filePath);

  // Boundary check: prevent escaping working directory
  if (perms.enforceWorkingDir) {
    const inWorkingDir = resolvedPath === resolvedCwd || resolvedPath.startsWith(resolvedCwd + "/");
    const inAllowedExternal = ALLOWED_EXTERNAL_PATHS.some(
      (allowed) => resolvedPath === allowed || resolvedPath.startsWith(allowed + "/"),
    );
    if (!inWorkingDir && !inAllowedExternal) {
      return { allowed: false, reason: `Path escapes working directory: ${filePath}` };
    }
  }

  // Check blocked paths (segment match)
  const pathSegments = resolvedPath.split("/");
  for (const blocked of perms.filesystem.blockedPaths) {
    if (pathSegments.includes(blocked)) {
      return { allowed: false, reason: `Blocked path: ${blocked}` };
    }
  }

  // Check blocked patterns (glob match on filename)
  const fileName = basename(resolvedPath);
  for (const pattern of perms.filesystem.blockedPatterns) {
    if (globMatch(fileName, pattern)) {
      return { allowed: false, reason: `Blocked file pattern: ${pattern}` };
    }
  }

  return { allowed: true };
}

// ── Glob helper ──────────────────────────────────────────────────────────

function globMatch(str: string, pattern: string): boolean {
  // Convert simple glob to regex: * -> .*, ? -> ., escape rest
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  try {
    return new RegExp(`^${regex}$`, "i").test(str);
  } catch {
    return false;
  }
}
