---
title: "Serving Projects"
description: "How to serve workspace dev projects (static sites, APIs, SPAs) so the user can view them on their device. Load this when starting a server."
---

## Tools

- `start_server` — spawn a long-running dev server. Set `tunnel: true` when the user will access it from their phone.
- `stop_server` — stop by ID.
- `list_servers` — show what's running.

## Pattern

When you create a web project, offer to serve it. Two modes:

1. **Preview only** — `start_server` with `tunnel: false`. Local access only. Use for host-only preview (e.g., if the user is at their Mac).
2. **Expose publicly** — `start_server` with `tunnel: true`. HTTPS tunnel via Tailscale / ngrok / cloudflared. Required for iOS device access.

## How to serve

Use `$PORT` as a placeholder in the command — it's replaced with the assigned port.

Examples:

- Hugo: `start_server({ name: "My Blog", command: "hugo server -p $PORT --bind 0.0.0.0", cwd: "workspace/my-blog" })`
- Vite / Node: `start_server({ name: "React App", command: "npm run dev -- --port $PORT --host", cwd: "workspace/my-app" })`
- Python / Flask: `start_server({ name: "Flask API", command: "python app.py --port $PORT", cwd: "workspace/my-api" })`
- Go: `start_server({ name: "Go Server", command: "go run . -port $PORT", cwd: "workspace/my-server" })`

## Binding

Always include `--bind 0.0.0.0` or `--host` flags when available. Tunnels proxy requests from an external IP; localhost-only binds cannot be reached.

## Reporting

After starting, report the URL to the user:

- With tunnel: use the tunnel URL (returned as the primary URL by `start_server`) in the respond `url` field.
- Without tunnel: do NOT send the URL to the user's iOS device — `localhost` is unreachable. Either restart with `tunnel: true` or tell the user to open it from the Mac.

If the user asks about running services, use `list_servers` to show what this server manages. You can supplement with `shell` commands to scan the full system, but clearly distinguish managed servers from other processes. `pockethook-agent-server` (typically port 3000) is **this** process — don't report it as a separate service.
