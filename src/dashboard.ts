/**
 * Dashboard HTML template.
 * Serves a single-page dashboard showing jobs status.
 */

import { listJobs } from "./jobs.js";

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

export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>FlowMate Dashboard</title>
<style>
  :root {
    --bg: #0f1d1d;
    --surface: #1a2f2f;
    --border: #2D9B9B33;
    --text: #f0f4f4;
    --text-dim: #99f6e4;
    --teal: #4dc4c4;
    --teal-light: #99f6e4;
    --teal-dim: #2D9B9B;
    --secondary: #2dd4bf;
    --green: #5eeae4;
    --red: #f87171;
    --yellow: #fbbf24;
    --blue: #99f6e4;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 20px;
    padding-bottom: 100px;
    -webkit-text-size-adjust: 100%;
  }
  h1 {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--teal);
    margin-bottom: 2px;
  }
  .subtitle {
    color: var(--text-dim);
    font-size: 0.8rem;
    margin-bottom: 16px;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin-bottom: 20px;
  }
  .stat {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 8px;
    text-align: center;
    box-shadow: 0 0 12px #2D9B9B15;
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
  }
  .refresh-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }
  .refresh-btn {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.85rem;
    -webkit-tap-highlight-color: transparent;
  }
  .refresh-btn:active { border-color: var(--secondary); }
  .auto-label { font-size: 0.7rem; color: var(--text-dim); }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.7rem;
    font-weight: 600;
  }
  .badge-pending { background: #14b8a622; color: var(--blue); }
  .badge-running { background: #fbbf2422; color: var(--yellow); }
  .badge-completed { background: #2dd4bf22; color: var(--green); }
  .badge-failed { background: #f8717122; color: var(--red); }
  .badge-cron { background: #2D9B9B22; color: var(--secondary); border: 1px solid var(--teal-dim); }
  .badge-once { background: #2D9B9B11; color: var(--text-dim); border: 1px solid var(--border); }
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
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px;
    margin-bottom: 12px;
    box-shadow: 0 0 16px #2D9B9B10;
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
    background: #182525;
    border-radius: 6px;
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
    .stat { padding: 12px 16px; }
    .stat-value { font-size: 1.8rem; }
    .stat-label { font-size: 0.75rem; }
    .refresh-btn:hover { border-color: var(--secondary); }

    .mobile-cards { display: none; }
    .desktop-table { display: block; }

    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }
    th {
      text-align: left;
      padding: 10px 12px;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
      background: var(--bg);
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 10px 12px;
      font-size: 0.85rem;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    tr:last-child td { border-bottom: none; }
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
  <h1>FlowMate</h1>
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
      const res = await fetch("/api/jobs");
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
      stat(cron, "Cron");

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
}
