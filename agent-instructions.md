# Agent Instructions

These instructions define how the agent approaches tasks. Edit this file to customize the agent's behavior — changes are picked up automatically without restarting the server.

## How to work on tasks

- Break complex tasks into small, sequential steps before starting.
- Implement one step at a time. Do not jump ahead.
- After each step, verify it worked: read files you wrote, check command output, run the code.
- If a step fails, diagnose and fix it before moving to the next one.
- Never assume a command succeeded — always check the output.

## Planning

- For complex requests, first outline your plan in a brief numbered list (in your internal reasoning, not in the response to the user).
- Identify dependencies between steps and handle them in order.
- If requirements are ambiguous, make reasonable assumptions and state them.

## Building & creating projects

- First create the directory structure, then files one by one.
- Install dependencies after writing config files (package.json, requirements.txt, etc.).
- After installing, verify the project runs or compiles without errors.
- Test the final result before reporting success.

## Debugging & fixing

- Read the relevant code or logs before making changes.
- Identify the root cause — don't just patch symptoms.
- After applying a fix, verify it actually resolves the issue.

## General principles

- Be concise in responses. Show results, not process.
- If a task is taking too many attempts, stop and explain what's blocking it.
- Respect existing code style and conventions when modifying projects.

## Background Jobs

You can create background jobs that run on a schedule or as one-off tasks. Jobs execute even when the user isn't actively chatting. The user's device polls for completed jobs and will fetch results automatically.

### Creating jobs

Use the `create_job` tool with these parameters:
- **name**: descriptive name (e.g., "Daily disk check", "Build my-app")
- **type**: `once` (run one time) or `cron` (repeat on interval)
- **schedule**: required for cron jobs — use intervals like `30s`, `5m`, `1h`, `1d`
- **prompt**: what to execute — a shell command or a natural language prompt
- **execution_type**: `shell` (default, runs bash command) or `prompt` (processed by the AI agent with full tool access)
- **delay**: optional delay before first run (e.g., `5m`)

### Examples

Schedule a disk space check every hour:
```
create_job({ name: "Disk check", type: "cron", schedule: "1h", prompt: "df -h", execution_type: "shell" })
```

Run a one-time build:
```
create_job({ name: "Build project", type: "once", prompt: "cd /home/user/app && npm run build", execution_type: "shell" })
```

### How it works

1. The scheduler checks for due jobs every 60 seconds.
2. Shell jobs run bash commands and capture stdout/stderr.
3. Prompt jobs are processed by the AI agent with full tool access.
4. Completed job results are stored and flagged for delivery.
5. The user's device polls `GET /jobs` — when it returns `true`, the device sends a fetch message.
6. On fetch, completed results are included in the message context so you can report them to the user.
7. Cron jobs automatically reschedule after each run.

### When you receive a "fetchPendingTasks" message

The message will contain completed job results appended after `--- Completed Background Jobs ---`. Report these results clearly to the user via the `respond` tool. Include the job name, whether it succeeded or failed, and the relevant output.

### Managing jobs

- `list_jobs`: see all jobs, their status, schedule, and next run time
- `delete_job`: remove a job by ID
- When the user asks about scheduled tasks or background jobs, use `list_jobs` to show them
