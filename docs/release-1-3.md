---
title: "PocketHook 1.3: compatibility and data flow"
description: "Requirements for durable intents, attachments, photo links and Apple Bridge."
---
These features require PocketHook **1.3**. Durable results and uploads require **Agent Server 0.7.0** or a server implementing the capabilities below. The response SDK is **0.1.3**. A basic HTTPS webhook remains supported for chat and requests that wait for a direct response.

## Compatibility

| Feature | Requirement |
| --- | --- |
| Chat, text, HTTPS links and existing Shortcut responses | Standard PocketHook webhook protocol |
| Send Message without waiting | `intent-jobs-v1`; unavailable in OpenClaw compatibility mode |
| Results retained until the app saves them | `result-acks-v1` and PocketHook 1.3 |
| Image/PDF/file attachment upload | `/uploads` (`uploads-v1` advertised by Agent Server) |
| App deep links and local photo links | PocketHook 1.3; the target app or photo permission as applicable |
| Apple Bridge 0.6.0 | macOS 14 or later; paired Bridge app and granted capabilities |
| Safari companion 1.0 | macOS 26.5 or later for the distributed container app |

PocketHook itself requires iOS 26.0 or later. This release does not depend on a future Siri version. The server uses the model/provider configured by its operator.

## Reliable intent results

`GET /health` advertises `X-PocketHook-Capabilities: intent-jobs-v1,result-acks-v1,uploads-v1`.

A standard authenticated chat request can include:

```http
x-pockethook-intent: 1
x-pockethook-request-id: <unique-request-id>
x-pockethook-wait: 0
x-pockethook-result-acks: 1
```

The request ID identifies one submission. Reusing it with a different session, message, origin or silent mode is rejected. `202` means the job has been persisted. Share Extension submissions use `x-pockethook-share: 1` instead of the intent header. Do not blindly resubmit with a new ID after a network timeout.

`POST /intent-jobs/status` accepts `{"requestIds":["<request-id>"]}` with at most 50 IDs per request. The app splits larger sets into batches. Collect completed results by sending the configured fetch message (default `fetchPendingTasks`) to the chat endpoint. An empty collection returns `[{"msg":"false"}]` without calling the model.

With `x-pockethook-result-acks: 1`, each result step carries `deliveryId`, `messageId` and `deliveryCount`. IDs stay stable across repeated fetches. Save every step in a delivery, deduplicate by `messageId`, then acknowledge:

```http
POST /deliveries/ack
Authorization: Bearer <server-token>
Content-Type: application/json

{"ids":["<delivery-uuid>"]}
```

Acknowledgements are idempotent, accept at most 100 IDs, and apply to that specific result. An old acknowledgement cannot discard a newer run of a recurring job. Results remain available until acknowledged; delivery snapshots are stored in `data/jobs.db`. Legacy clients retain their previous fetch-and-mark-delivered behavior.

The app keeps local receipts even when old chat messages are trimmed. Shortcut actions are claimed before execution and deferred while the app is in the background. An interruption after a claim has an uncertain outcome; actions are not automatically repeated. This protocol does not promise exactly-once execution in another app. Interrupted intent/share jobs are also not automatically rerun after a server restart.

## Attachments and photo links

`POST /uploads` accepts a binary body with its MIME type and Bearer authentication. Supported types: JPEG, PNG, GIF, WebP, PDF, plain text, CSV, Markdown and JSON. The default limit is 25 MiB (`UPLOADS_MAX_MB`). The response includes an ID and stored filename. Messages reference files as `[FILE:<uuid>.<ext>|<display-name>]`.

Downloads at `/uploads/<uuid>.<ext>` also require the server token. The app sends that token only to the configured server's upload endpoint and refuses redirects on those authenticated downloads. External images do not receive the token. Files expire after 30 days by default (`UPLOADS_RETENTION_DAYS`); expired files cannot be downloaded, and cleanup runs at startup and every 12 hours. Backups made by the operator have their own retention.

Uploaded images and extracted document text can be sent to the configured model provider. A photo link such as `pockethook://photos?latest=5` is different: it opens a local photo query, requires enabling photo links in Settings and the appropriate library access, and does not itself upload those photos. Attaching a photo sends it to your server.

Response URLs support HTTPS and custom app schemes. Plain HTTP and the schemes `tel`, `sms`, `facetime`, `facetime-audio`, `itms-services`, `app-prefs`, `javascript`, `data` and `file` are rejected. Deep links require an explicit tap; existing Shortcut response actions keep their configured execution behavior.

## Apple Bridge and Safari

```bash
bun run apple-bridge:install
bun run apple-bridge:code
bun run apple-bridge:status
bun run safari:install
bun run safari:code
```

Open the installed companion, pair it using the one-time code, and grant only the required capabilities. Pairing and operating-system permissions are separate. Apple Bridge connects the server to supported Mac resources; Safari pairs its extension separately.

[Download Apple Bridge 0.6.0](/downloads/PocketHook-Apple-Bridge.zip) · [Download Safari companion 1.0](/downloads/PocketHook-Safari.zip)

## Updating an existing server

Back up SQLite databases coherently before upgrading; copy `.env`, user configuration and workspace separately. Install the published dependencies with `bun install --frozen-lockfile`. Existing per-instance service names and log locations remain in use. Database initialization adds the new delivery table without replacing existing jobs. A code rollback alone does not restore a database backup.

The distributed workspace contains only `.gitkeep` placeholders. Runtime files, credentials, user instructions and memories belong to the installation, not the product repository. The existing unauthenticated dashboard/job overview still needs network restrictions or `DASHBOARD=false`; the new upload and acknowledgement endpoints require authentication.
