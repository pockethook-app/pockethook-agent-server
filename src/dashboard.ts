/**
 * Dashboard serving.
 *
 * Serves the dashboard with the following priority:
 *   1. Built project: workspace/dashboard/dist/index.html (+ static assets)
 *   2. Custom single file: workspace/dashboard/dashboard.html
 *   3. Built-in default HTML
 *
 * All custom files are hot-reloaded on change (checked via mtime).
 * Built projects can include JS/CSS/image assets under dist/.
 *
 * The dashboard can fetch `/api/jobs` for job data.
 */

import { existsSync, readFileSync, statSync } from "fs";
import { randomBytes } from "crypto";
import { dirname, join, extname } from "path";
import { fileURLToPath } from "url";
import { listJobs } from "./jobs.js";
import { logger } from "./logger.js";

const dashboardToken = randomBytes(32).toString("hex");

export function getDashboardToken(): string {
  return dashboardToken;
}

function injectToken(html: string): string {
  const script = `<script>window.__DASHBOARD_TOKEN__="${dashboardToken}";</script>`;
  if (html.includes("</head>")) return html.replace("</head>", `${script}\n</head>`);
  if (html.includes("<body")) return html.replace("<body", `${script}\n<body`);
  return script + html;
}

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DASHBOARD_DIR = join(PROJECT_ROOT, "workspace", "dashboard");
const DIST_DIR = join(DASHBOARD_DIR, "dist");
const CUSTOM_DASHBOARD_PATH = join(DASHBOARD_DIR, "dashboard.html");

let cachedCustomHtml: string | null = null;
let cachedCustomMtime: number = 0;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

export function getJobsJson(): object {
  const jobs = listJobs();
  return jobs.map((j) => ({
    id: j.id,
    name: j.name,
    type: j.type,
    schedule: j.schedule,
    execution_type: j.execution_type,
    status: j.status,
    result: j.result?.slice(0, 500) ?? null,
    error: j.error?.slice(0, 500) ?? null,
    created_at: j.created_at,
    completed_at: j.completed_at,
    next_run_at: j.next_run_at,
    delivered: !!j.delivered,
    enabled: !!j.enabled,
  }));
}

/**
 * Check if a built project exists (dist/index.html).
 */
export function hasDistDashboard(): boolean {
  return existsSync(join(DIST_DIR, "index.html"));
}

/**
 * Serve a static file from workspace/dashboard/dist/.
 * Returns null if the file doesn't exist or the path escapes dist/.
 */
export function serveDashboardAsset(subpath: string): Response | null {
  // Normalize: empty or "/" → index.html
  const cleaned = subpath.replace(/^\/+/, "") || "index.html";

  const filePath = join(DIST_DIR, cleaned);

  // Prevent path traversal
  if (!filePath.startsWith(DIST_DIR)) {
    return null;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return null;
  }

  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const content = readFileSync(filePath);

  return new Response(content, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    },
  });
}

/**
 * Get the dashboard index HTML.
 * Priority: dist/index.html > dashboard.html > built-in default.
 */
export function getDashboardHtml(): string {
  // 1. Check for built project (dist/index.html)
  const distIndex = join(DIST_DIR, "index.html");
  try {
    if (existsSync(distIndex)) {
      const mtime = statSync(distIndex).mtimeMs;
      if (mtime !== cachedCustomMtime || cachedCustomHtml === null) {
        cachedCustomHtml = readFileSync(distIndex, "utf-8");
        cachedCustomMtime = mtime;
        logger.info("Dashboard dist/index.html reloaded");
      }
      return injectToken(cachedCustomHtml);
    }
  } catch {}

  // 2. Check for custom dashboard.html (hot-reloaded)
  try {
    if (existsSync(CUSTOM_DASHBOARD_PATH)) {
      const mtime = statSync(CUSTOM_DASHBOARD_PATH).mtimeMs;
      if (mtime !== cachedCustomMtime || cachedCustomHtml === null) {
        cachedCustomHtml = readFileSync(CUSTOM_DASHBOARD_PATH, "utf-8");
        cachedCustomMtime = mtime;
        logger.info("Custom dashboard.html reloaded");
      }
      return injectToken(cachedCustomHtml);
    }
  } catch {}

  // Reset cache if custom files were deleted
  if (cachedCustomHtml !== null && !existsSync(distIndex) && !existsSync(CUSTOM_DASHBOARD_PATH)) {
    cachedCustomHtml = null;
    cachedCustomMtime = 0;
    logger.info("Custom dashboard removed, using default");
  }

  return DEFAULT_DASHBOARD_HTML.replace("__DASHBOARD_TOKEN__", dashboardToken);
}

const DEFAULT_DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>PocketHook Dashboard</title>
<style>
  :root {
    --bg: #000000;
    --surface: rgba(255, 255, 255, 0.06);
    --surface-solid: #000000;
    --border: rgba(255, 255, 255, 0.08);
    --text: #f5f5f7;
    --text-dim: rgba(255, 255, 255, 0.45);
    --accent-green: #34d399;
    --accent-blue: #60a5fa;
    --gradient: linear-gradient(to right, #34d399, #60a5fa);
    --green: #34d399;
    --red: #f87171;
    --yellow: #fbbf24;
    --blue: #60a5fa;
    --cyan: #67e8f9;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 20px;
    padding-bottom: 100px;
    -webkit-text-size-adjust: 100%;
  }
  h1 {
    font-size: 1.25rem;
    font-weight: 600;
    background: var(--gradient);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    width: fit-content;
    margin-bottom: 2px;
  }
  .subtitle {
    color: var(--text-dim);
    font-size: 0.8rem;
    margin-bottom: 20px;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin-bottom: 20px;
  }
  .stat {
    border: 1.5px solid transparent;
    border-radius: 14px;
    padding: 12px 8px;
    text-align: center;
    background:
      linear-gradient(var(--surface-solid), var(--surface-solid)) padding-box,
      linear-gradient(135deg, var(--accent-green), var(--accent-blue)) border-box;
  }
  .stat-value {
    font-size: 1.3rem;
    font-weight: 700;
  }
  .stat-label {
    font-size: 0.6rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-top: 2px;
  }
  .refresh-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }
  .refresh-btn {
    border: 1.5px solid transparent;
    border-radius: 20px;
    color: var(--text);
    padding: 6px 16px;
    cursor: pointer;
    font-size: 0.85rem;
    -webkit-tap-highlight-color: transparent;
    transition: transform 0.1s ease;
    background:
      linear-gradient(var(--surface-solid), var(--surface-solid)) padding-box,
      linear-gradient(to right, var(--accent-green), var(--accent-blue)) border-box;
  }
  .refresh-btn:active { transform: scale(0.97); }
  .auto-label { font-size: 0.7rem; color: var(--text-dim); }
  .badge {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 10px;
    font-size: 0.7rem;
    font-weight: 600;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }
  .badge-pending { background: rgba(96, 165, 250, 0.12); color: var(--blue); border: 1px solid rgba(96, 165, 250, 0.2); }
  .badge-running { background: rgba(251, 191, 36, 0.12); color: var(--yellow); border: 1px solid rgba(251, 191, 36, 0.2); }
  .badge-completed { background: rgba(52, 211, 153, 0.12); color: var(--green); border: 1px solid rgba(52, 211, 153, 0.2); }
  .badge-failed { background: rgba(248, 113, 113, 0.12); color: var(--red); border: 1px solid rgba(248, 113, 113, 0.2); }
  .badge-cron { background: rgba(103, 232, 249, 0.12); color: var(--cyan); border: 1px solid rgba(103, 232, 249, 0.2); }
  .badge-once { background: rgba(255, 255, 255, 0.06); color: var(--text-dim); border: 1px solid var(--border); }
  .mono { font-family: "SF Mono", "Fira Code", ui-monospace, monospace; font-size: 0.75rem; }
  .dim { color: var(--text-dim); }
  .empty {
    text-align: center;
    padding: 48px 16px;
    color: var(--text-dim);
    font-size: 0.9rem;
  }

  /* Mobile-first: card layout */
  .job-card {
    border: 1.5px solid transparent;
    border-radius: 16px;
    padding: 14px;
    margin-bottom: 12px;
    background:
      linear-gradient(var(--surface-solid), var(--surface-solid)) padding-box,
      linear-gradient(135deg, var(--accent-green), var(--accent-blue)) border-box;
  }
  .job-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .job-name {
    font-weight: 600;
    font-size: 0.9rem;
  }
  .job-id {
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
    color: var(--text-dim);
  }
  .job-badges {
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
  }
  .job-row {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    font-size: 0.8rem;
  }
  .job-row-label {
    color: var(--text-dim);
    font-size: 0.75rem;
  }
  .job-row-value {
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    text-align: right;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .job-output {
    margin-top: 8px;
    padding: 8px 10px;
    background: rgba(0, 0, 0, 0.4);
    border-radius: 10px;
    border: 1px solid var(--border);
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    word-break: break-word;
    white-space: pre-wrap;
    max-height: 80px;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  /* Desktop: table layout */
  .desktop-table { display: none; }

  @media (min-width: 768px) {
    body {
      padding: 24px;
      max-width: 960px;
      margin: 0 auto;
    }
    h1 { font-size: 1.5rem; }
    .stats {
      grid-template-columns: repeat(6, 1fr);
      gap: 12px;
      margin-bottom: 24px;
    }
    .stat { padding: 14px 16px; }
    .stat-value { font-size: 1.8rem; }
    .stat-label { font-size: 0.75rem; }

    .mobile-cards { display: none; }
    .desktop-table { display: block; }

    table {
      width: 100%;
      border-collapse: collapse;
      border: 1.5px solid transparent;
      border-radius: 16px;
      overflow: hidden;
      background:
        linear-gradient(var(--surface-solid), var(--surface-solid)) padding-box,
        linear-gradient(135deg, var(--accent-green), var(--accent-blue)) border-box;
    }
    th {
      text-align: left;
      padding: 10px 12px;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
      background: rgba(0, 0, 0, 0.3);
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 10px 12px;
      font-size: 0.85rem;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }
    .result-cell {
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
</style>
</head>
<body>
  <h1>PocketHook</h1>
  <p class="subtitle">Agent Server Dashboard</p>

  <div class="stats" id="stats"></div>

  <div class="refresh-bar">
    <span class="auto-label" id="last-update"></span>
    <button class="refresh-btn" onclick="load()">Refresh</button>
  </div>

  <div id="content"></div>

<script>
  async function load() {
    try {
      const res = await fetch("/api/jobs", { headers: { "X-Dashboard-Token": "__DASHBOARD_TOKEN__" } });
      const jobs = await res.json();
      render(jobs);
      document.getElementById("last-update").textContent = "Updated " + new Date().toLocaleTimeString();
    } catch (err) {
      document.getElementById("content").innerHTML = '<p class="empty">Failed to load jobs.</p>';
    }
  }

  function render(jobs) {
    const total = jobs.length;
    const pending = jobs.filter(j => j.status === "pending").length;
    const running = jobs.filter(j => j.status === "running").length;
    const completed = jobs.filter(j => j.status === "completed").length;
    const failed = jobs.filter(j => j.status === "failed").length;
    const cron = jobs.filter(j => j.type === "cron").length;

    document.getElementById("stats").innerHTML =
      stat(total, "Total") +
      stat(pending, "Pending", "var(--blue)") +
      stat(running, "Running", "var(--yellow)") +
      stat(completed, "Completed", "var(--green)") +
      stat(failed, "Failed", "var(--red)") +
      stat(cron, "Cron", "var(--cyan)");

    if (jobs.length === 0) {
      document.getElementById("content").innerHTML = '<p class="empty">No jobs yet.</p>';
      return;
    }

    // Mobile cards
    let cards = '<div class="mobile-cards">';
    for (const j of jobs) {
      const output = j.result || j.error || null;
      cards += '<div class="job-card">';
      cards += '<div class="job-header"><span class="job-name">' + esc(j.name) + '</span><span class="job-id">#' + j.id + '</span></div>';
      cards += '<div class="job-badges"><span class="badge badge-' + j.type + '">' + j.type + '</span><span class="badge badge-' + j.status + '">' + j.status + '</span></div>';
      if (j.schedule) {
        cards += '<div class="job-row"><span class="job-row-label">Schedule</span><span class="job-row-value">' + esc(j.schedule) + '</span></div>';
      }
      if (j.status === "pending") {
        cards += '<div class="job-row"><span class="job-row-label">Next run</span><span class="job-row-value">' + relTime(j.next_run_at) + '</span></div>';
      }
      if (output) {
        const color = j.error ? ' style="color:var(--red)"' : '';
        cards += '<div class="job-output"' + color + '>' + esc(output.slice(0, 300)) + '</div>';
      }
      cards += '</div>';
    }
    cards += '</div>';

    // Desktop table
    let table = '<div class="desktop-table"><table><thead><tr>';
    table += '<th>#</th><th>Name</th><th>Type</th><th>Status</th><th>Schedule</th><th>Next Run</th><th>Output</th>';
    table += '</tr></thead><tbody>';
    for (const j of jobs) {
      table += '<tr>';
      table += '<td class="mono dim">' + j.id + '</td>';
      table += '<td>' + esc(j.name) + '</td>';
      table += '<td><span class="badge badge-' + j.type + '">' + j.type + '</span></td>';
      table += '<td><span class="badge badge-' + j.status + '">' + j.status + '</span></td>';
      table += '<td class="mono">' + (j.schedule ? esc(j.schedule) : '<span class="dim">\\u2014</span>') + '</td>';
      table += '<td class="mono">' + (j.status === "pending" ? relTime(j.next_run_at) : '<span class="dim">\\u2014</span>') + '</td>';
      table += '<td class="result-cell">' + (j.result ? esc(j.result) : j.error ? '<span style="color:var(--red)">' + esc(j.error) + '</span>' : '<span class="dim">\\u2014</span>') + '</td>';
      table += '</tr>';
    }
    table += '</tbody></table></div>';

    document.getElementById("content").innerHTML = cards + table;
  }

  function stat(value, label, color) {
    const c = color ? ' style="color:' + color + '"' : '';
    return '<div class="stat"><div class="stat-value"' + c + '>' + value + '</div><div class="stat-label">' + label + '</div></div>';
  }

  function relTime(ts) {
    if (!ts) return '<span class="dim">\\u2014</span>';
    const diff = ts - Date.now();
    if (diff < 0) return '<span class="dim">overdue</span>';
    if (diff < 60000) return Math.round(diff / 1000) + "s";
    if (diff < 3600000) return Math.round(diff / 60000) + "m";
    if (diff < 86400000) return Math.round(diff / 3600000) + "h";
    return Math.round(diff / 86400000) + "d";
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  load();
  setInterval(load, 30000);
</script>
</body>
</html>`;
