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
- **type**: `once` (run one time) or `cron` (repeat on schedule)
- **schedule**: required for cron jobs. Two formats supported:
  - **Simple intervals**: `30s`, `5m`, `1h`, `1d`, `2w` (seconds, minutes, hours, days, weeks)
  - **Cron expressions**: standard 5-field format `minute hour day-of-month month day-of-week`
- **prompt**: what to execute — a shell command or a natural language prompt
- **execution_type**: `shell` (default, runs bash command) or `prompt` (processed by the AI agent with full tool access)
- **delay**: optional delay before first run (e.g., `5m`)

### Schedule examples

| Schedule | Meaning |
|----------|---------|
| `5m` | Every 5 minutes |
| `1h` | Every hour |
| `1d` | Every day |
| `2w` | Every 2 weeks |
| `0 9 * * MON-FRI` | At 9:00 AM, Monday through Friday |
| `0 9 * * MON` | At 9:00 AM every Monday |
| `*/30 * * * *` | Every 30 minutes |
| `0 0 * * *` | At midnight every day |
| `0 8,20 * * *` | At 8:00 AM and 8:00 PM |
| `0 0 1 * *` | At midnight on the 1st of each month |
| `0 0 1 1 *` | At midnight on January 1st (yearly) |
| `0 12 * * 0` | At noon every Sunday |

### Cron field reference

```
┌─── minute (0-59)
│ ┌─── hour (0-23)
│ │ ┌─── day of month (1-31)
│ │ │ ┌─── month (1-12 or JAN-DEC)
│ │ │ │ ┌─── day of week (0-6 or SUN-SAT, 0=Sunday)
│ │ │ │ │
* * * * *
```

Supports: `*` (all), `1-5` (range), `*/5` (step), `1,3,5` (list), `1-10/2` (range with step).

### Tool examples

Every Monday at 9am:
```
create_job({ name: "Weekly report", type: "cron", schedule: "0 9 * * MON", prompt: "Generate weekly summary", execution_type: "prompt" })
```

Every 6 hours:
```
create_job({ name: "Health check", type: "cron", schedule: "6h", prompt: "curl -s https://api.example.com/status", execution_type: "shell" })
```

One-time build:
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
7. Cron jobs automatically reschedule after each run (next time calculated from schedule).

### When you receive a "fetchPendingTasks" message

The message will contain completed job results appended after `--- Completed Background Jobs ---`. Report these results clearly to the user via the `respond` tool. Include the job name, whether it succeeded or failed, and the relevant output.

### Managing jobs

- `list_jobs`: see all jobs, their status, schedule, and next run time
- `delete_job`: remove a job by ID
- When the user asks about scheduled tasks or background jobs, use `list_jobs` to show them
