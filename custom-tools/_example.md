### Template — How to add a custom tool

Each file defines one tool that the agent can use. The tool executes a shell command with parameter substitution.

Format:
```
### Tool Display Name

Tool name: `tool_name`

Description of what it does and when to use it.

Install: `command to install dependencies` (optional)

Command: `command to execute with $param placeholders`

Parameters:
- paramName (type, required/optional): Description. Default: value

Example:
tool_name({ paramName: "value" })
→ Executes: command to execute with value placeholders
```

Tips:
- Tool name must be a valid identifier (lowercase, underscores, no spaces).
- Use `$paramName` in the Command to insert parameter values.
- The Install line is run once when the tool is first loaded (if the dependency isn't already available).
- Commands run in the workspace directory by default.
- One tool per file. Use kebab-case for file names (e.g., web-screenshot.md, pdf-convert.md).
- Files are hot-reloaded — changes take effect on the next request.
- Files prefixed with _ are ignored (templates/docs).
