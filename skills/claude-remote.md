### Claude Remote Control

Shortcut name: `claudeRemote`

Abre una sesión remota interactiva de Claude Code dentro de una sesión **tmux** persistente. El usuario podrá conectarse desde su iPhone vía claude.ai/code.

Cuando el usuario diga "abre una sesión con Claude en [directorio/proyecto]", usa el directorio indicado como working directory. Si no especifica directorio, usa el workspace por defecto.

**Pasos:**

1. Si ya existe una sesión tmux `claude-remote`, mátala primero: `tmux kill-session -t claude-remote`
2. Crea la nueva sesión con el directorio adecuado:
```
tmux new-session -d -s claude-remote 'cd <DIRECTORIO> && claude remote-control'
```

**Directorio por defecto:** `/Volumes/Ext/dev/pockethook-agent-server/workspace`

**Ejemplos de directorio:**
- "abre una sesión con Claude en el blog" → `cd /Volumes/Ext/dev/workspace/blog && claude remote-control`
- "abre una sesión de Claude en pockethook" → `cd /Volumes/Ext/dev/pockethook-agent-server && claude remote-control`
- "abre Claude" (sin proyecto) → `cd /Volumes/Ext/dev/pockethook-agent-server/workspace && claude remote-control`

Data fields:
- action (string, required): Acción a ejecutar, por defecto "start"
- directory (string, optional): Directorio de trabajo para la sesión
- message (string, optional): Mensaje o contexto adicional para la sesión

Example:
```json
{ "msg": "Abriendo sesión remota de Claude en el blog...", "shortcut": "claudeRemote", "data": { "action": "start", "directory": "/Volumes/Ext/dev/workspace/blog" } }
```
