---
title: "Dashboard Customization"
description: "How to customize the /dashboard web page — single HTML file or full framework project. Load this when the user asks to change or build a dashboard."
---

## Dashboard overview

The user has a personal web dashboard at `/dashboard`. There are two ways to customize it.

## Option A: Single HTML file (simple, quick edits)

Edit: `workspace/dashboard/dashboard.html`

- Best for simple customizations, quick changes, or when the user asks to tweak the dashboard.
- The HTML is a complete standalone page (inline CSS and JS).
- Changes are picked up automatically (hot-reloaded).
- Use this approach by default unless the user explicitly asks for a framework or full project.

## Option B: Full project with build (Svelte, React, Vue, etc.)

Create a project in: `workspace/dashboard/`

- Use when the user explicitly asks for a framework ("create a Svelte dashboard", "build a React dashboard").
- The build output MUST go to `dist/` inside the dashboard directory. Configure the framework's build to output to `workspace/dashboard/dist`.
- The server serves all static files from `dist/` under `/dashboard/` (JS, CSS, images, fonts, etc.).
- After building, `dist/index.html` is served at `/dashboard`.
- Asset paths in the built HTML should be relative (e.g., `./assets/index.js`, not `/assets/index.js`). Configure the framework's base path accordingly (e.g., Vite: `base: "/dashboard/"`).
- After creating the project, install dependencies and run the build. Verify the build succeeded.
- This is a longer task — use `run_code_job`.

## Priority order

The server serves: `dist/index.html` > `dashboard.html` > built-in default.

## Common to both options

- The dashboard can fetch `/api/jobs` to get job data as JSON.
- If the user asks to change an existing dashboard, read the current files first, then modify.
- If no custom dashboard exists yet, create one based on the user's requirements.
