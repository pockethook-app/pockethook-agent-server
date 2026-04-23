### Template — Integration (DEFAULT pattern for every integration)

Whenever the user asks you to "add a tool / integration / connector for X", this is the shape you must produce. The real code lives in a proper project under `workspace/<name>/`; the custom-tool markdown at `data/user/custom-tools/<name>.md` is only the typed entry point that invokes the runtime against that project. Read `data/user/prefs.json → integrationDefaults` for the language/runtime/compile choice — the example below uses the shipped defaults (TypeScript + Bun + **no compile**, i.e. run from source).

**Workspace project layout** (`workspace/<name>/`):

```
workspace/<name>/
├── package.json      # "type": "module", optional "build" script if you ever want to compile
├── src/
│   └── cli.ts        # entrypoint: parses --flags, dispatches actions
├── lib/              # real logic (imported by cli.ts)
│   └── index.ts
├── .gitignore        # excludes node_modules/, any config.json with secrets, and the compiled binary if compileToBinary=true
└── README.md         # short usage notes
```

**Custom-tool markdown** (written via `create_custom_tool`, which lands it at `data/user/custom-tools/<name>.md`):

```
### Display Name

Tool name: `my_tool`

One-sentence description of what it does and when to use it. Mention where credentials come from (env vars, prefs.json) if any.

Install: `cd my-tool && bun install --production`

Command: `bun my-tool/src/cli.ts $action --flag1 $flag1 --flag2 $flag2`

Parameters:
- action (string, required): Which subcommand to run. List them all.
- flag1 (string, optional): Description.
- flag2 (number, optional): Description.
```

**If `integrationDefaults.compileToBinary` is `true` instead** (user opted into standalone binaries):

```
Install: `cd my-tool && bun install --production && bun run build`

Command: `./my-tool/my-tool $action --flag1 $flag1 --flag2 $flag2`
```

…and `workspace/my-tool/package.json` carries `"build": "bun build --compile ./src/cli.ts --outfile my-tool"`.

**Rules — read carefully before writing anything:**

- The `Command:` field invokes a **runtime against your source file** (default) or a **compiled artifact** (if user opted in). It is NEVER a heredoc, never `python3 - <<'PY' …'PY`, never `node -e '…'`, never `bash -c '…'` with logic. If you catch yourself writing the tool's logic in the `.md`, stop and move it to `workspace/<name>/src/cli.ts` (or `.go` / `.py` / whatever your stack is).
- The `Install:` step installs deps once (and optionally builds, only when `compileToBinary=true`). `custom-tools.ts` caches the install by tool name, so re-runs skip it.
- All args are `--flag value`, never positional (keeps the schema clean). `custom-tools.ts` substitutes `$flag` with the user-supplied value in single quotes; unset optional params become `--flag ''`. Your CLI must treat an empty-string value as absent (parse it once and normalize to undefined/null).
- Empty `$image` / `$text` / etc. must NOT crash the CLI. Your arg parser must treat an empty-string flag value as absent (normalize to undefined/null before consuming).
- If the user's `integrationDefaults.language` isn't Bun + TypeScript, use the analogous layout in that stack — the shape (workspace project with real code + custom-tool that invokes the runtime or compiled artifact) is the constant, the stack is the variable.

If existing tools are present in `data/user/custom-tools/` and `workspace/`, open one of them before scaffolding a new integration — a real working pair shows exactly what "good" looks like in this repo.
