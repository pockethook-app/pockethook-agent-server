# Agent Server 0.8.0 and PocketHook 1.4

This release adds QR setup for PocketHook's saved server profiles. Existing 1.3 clients and the 0.7.0 chat, attachment and delivery protocols remain supported. The app can also connect manually to older Agent Server versions or other compatible HTTPS servers.

## Connect the app

Start the configured server and its HTTPS tunnel. On macOS, run `bun run app:qr` in that installation's directory. The command uses the existing agent name and detects the Tailscale route that forwards to this instance's port. It does not create or modify tunnels. Use `--url https://server.example` for another HTTPS endpoint or to choose explicitly.

The CLI renders the QR in the terminal, saves a PNG in a restricted temporary directory, and opens it only with `--open`. Rendering requires the Swift toolchain from Xcode or Command Line Tools. The HTTP invitation endpoints are platform-independent; manual app setup remains available on every platform.

In PocketHook 1.4, use **Settings → Manage servers → Add server → Scan QR**, or import the PNG. Check the host before confirming. The configuration includes the endpoint, owner token, health check, pending jobs, fetch message and optional Personal UI. See the [complete QR guide](app-pairing.md).

Invitations contain a random 256-bit code, never the permanent token. They expire after five minutes, are consumed once, and are invalidated by regeneration or restart. The app receives the token over HTTPS after redemption and stores it separately in its device-local Keychain.

## Separate profiles, existing owner access

- One app profile and QR setup are available without Pro. Multiple profiles require Pro, the active trial or an existing legacy entitlement. A single app purchase covers every profile.
- Each profile retains its own endpoint, token, chat, draft, session, links, queue, delivery receipts and server-specific settings. Work started against one profile keeps that destination when the selected profile changes.
- Shortcuts and the Share Extension can select a profile. Existing Shortcuts without an explicit destination retain the original profile.
- Adding profiles does not create separate users on a server. Scanning a server owner's QR grants that owner's existing access. For isolated deployments, use separate server instances with separate runtime directories and credentials.
- The app's original profile keeps its existing iCloud behavior. Additional profiles stay local in 1.4 and must be configured separately on each device.

## Upgrade an existing installation

1. Stop the instance using its usual service command. Make a coherent backup of its SQLite databases, `.env`, `data/` and `workspace/`; keep that backup outside Git and release archives.
2. Inspect local source changes before updating. Keep custom instructions, skills and tools under `data/user/`. Do not overwrite installation files with a fresh repository checkout.
3. Update the product source to the published 0.8.0 release and run `bun install --frozen-lockfile`.
4. Restart using the existing service configuration and confirm `/health` and a normal chat request. This release retains the existing service names and log locations.
5. Generate a fresh invitation and test the new app profile. Check pending results, attachments and Personal UI if enabled.

No new job database migration is introduced by 0.8.0. Updating from a version older than 0.7.0 also requires its [delivery and attachment migration notes](release-1-3.md). A source rollback is not a database restore.

Dependencies remain SDK 0.1.3 and pi packages 0.85.0. Apple Bridge 0.6.0 and Safari companion 1.0 do not need a new release for app pairing.

## Development and publication

Product changes are developed on branches of this public repository. Run a separate checkout/instance with synthetic data, its own port and credentials, then connect it using another app profile. Private installations consume reviewed public releases while retaining their ignored runtime data; do not copy a private Git history or personal workspace into this repository.

## Release preparation validation

Version 0.8.0 passes TypeScript checking and 160 Bun tests (647 assertions). Coverage includes single-use/expired/replaced pairing codes, authenticated generation, bounded redemption input, Tailscale route selection, terminal rendering and real HTTP pairing alongside result acknowledgements and protected uploads. The native macOS QR generator was decoded with Vision using a synthetic payload; the decoded content matched exactly.

The public 0.7.0 result delivery, upload protections and per-instance service configuration are retained. Runtime data, environment files, personal dashboards and private Git history are excluded. Only `.gitkeep` placeholders are tracked under `workspace/` and `workspace/dashboard/`.

Before publishing, run `bun install --frozen-lockfile --ignore-scripts`, `bunx tsc --noEmit` and `bun test`. Test QR rendering on macOS and the pairing routes on the supported server runtime. Keep `workspace/.gitkeep` and `workspace/dashboard/.gitkeep` as the only distributed workspace files. Review the staged file list and archive contents before tagging.
