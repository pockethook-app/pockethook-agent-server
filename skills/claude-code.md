### Claude Code — Herramienta de programación

Este skill NO es un shortcut de iOS. Es una instrucción para que el agente use Claude Code CLI (`claude`) como herramienta de programación dentro de jobs.

Cuando necesites realizar una tarea de programación compleja (crear proyectos, refactorizar, revisar código extenso, etc.), delega el trabajo a Claude Code ejecutándolo como un shell job con timeout largo.

---

**Cómo usarlo:**

Crea UN SOLO job `type: "once"`, `execution_type: "shell"` con `timeout: "30m"` (o más si la tarea es muy pesada). El job ejecuta `claude --print` directamente, captura el output, y se entrega al usuario cuando termina. Sin tmux, sin polling, sin complicaciones.

```
create_job({
  name: "Descripción de la tarea",
  type: "once",
  execution_type: "shell",
  timeout: "30m",
  prompt: "cd /ruta/proyecto && claude --print --dangerously-skip-permissions \"Tu prompt aquí. IMPORTANTE: Usa siempre flags no interactivos en todos los comandos CLI.\""
})
```

El resultado se entrega automáticamente al usuario vía el polling de PocketHook cuando el job termina.

---

**Flags de Claude Code CLI:**
- `--print` (`-p`): Modo no interactivo. Ejecuta el prompt y sale.
- `--dangerously-skip-permissions`: Permite escribir archivos y ejecutar comandos sin confirmación. Necesario para tareas que modifican el filesystem.
- `--model`: Especificar modelo.
- `--max-turns`: Limitar turnos de herramientas.

**IMPORTANTE — Comandos no interactivos:**
Claude Code corre sin terminal interactivo. El prompt que le pases DEBE indicar que use siempre flags no interactivos en cualquier herramienta CLI que ejecute. Por ejemplo:
- `npx sv create` → NO (interactivo, se queda colgado). Usar `npx sv create my-app --template minimal --no-install` o equivalente con `--yes`/`-y`.
- `npm init` → NO. Usar `npm init -y`.
- `npx create-next-app` → Pasar todos los flags: `--yes --ts --app --src-dir --eslint`.
- Cualquier CLI que pregunte opciones → buscar su flag `--yes`, `--no-interactive`, `--defaults` o similar.

Incluye siempre en el prompt de Claude Code: **"IMPORTANTE: Usa siempre flags no interactivos (--yes, -y, --defaults, --no-interactive) en todos los comandos CLI. No puedes responder prompts interactivos."**

**Timeout:** Usa `timeout: "30m"` para tareas normales, `timeout: "1h"` para proyectos grandes. El default sin timeout es 60s (insuficiente para Claude Code).

**Cuándo usar Claude Code vs el propio agente:**
- **Claude Code** (este skill): tareas de programación pesadas — crear proyectos, refactorizaciones, debugging complejo. Tiene mejor contexto de código, LSP, grep avanzado, edición precisa.
- **Propio agente** (`execution_type: "prompt"`): tareas ligeras que solo leen unos archivos, o que necesitan tools de PocketHook (respond, start_server, etc.).

---

**Ejemplo — crear proyecto:**
```
create_job({
  name: "Crear API con Hono",
  type: "once",
  execution_type: "shell",
  timeout: "30m",
  prompt: "cd /Volumes/Ext/dev/workspace && claude --print --dangerously-skip-permissions \"Crea un proyecto hono-api con Bun y Hono. Rutas GET /health y POST /echo. Instala deps y verifica que compila. IMPORTANTE: Usa siempre flags no interactivos en todos los comandos CLI.\""
})
```

**Ejemplo — revisar proyecto:**
```
create_job({
  name: "Revisar blog",
  type: "once",
  execution_type: "shell",
  timeout: "30m",
  prompt: "cd /Volumes/Ext/dev/workspace/blog && claude --print \"Revisa este proyecto: estructura, calidad, mejoras y errores. Informe conciso.\""
})
```
