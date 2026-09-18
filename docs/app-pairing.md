# Connect PocketHook 1.4 with a QR

Restart the updated Agent Server, then run this command from its configured directory:

```sh
bun run app:qr
```

The command reads the existing Tailscale Serve configuration, finds the HTTPS address that forwards to this Agent Server's `PORT`, and uses `AGENT_NAME` as the profile name (default: `PocketHook Assistant`). It preserves the external HTTPS port, including when another service uses port 443. If several addresses match, it uses `HTTPS_PORT` or the installed service's saved tunnel port when available. With an unambiguous match, it displays the QR directly in the terminal without asking for configuration or opening another app.

In PocketHook, open **Settings → Manage servers → Add server → Scan QR**, confirm the host and add the profile. An image can also be imported instead of using the camera. The first server, including QR setup, is available without Pro; additional saved profiles require Pro or an active trial.

Discovery only reads existing tunnels. The server and its HTTPS tunnel must already be running, and the phone must be able to reach that address (connected to Tailscale when using a private tailnet address). If no address can be detected, the command asks for the HTTPS root URL; if several still match, it offers a choice. Without an interactive terminal, use `--url` in either case. Other tunnel providers can also use `--url`.

Optional arguments:

```sh
bun run app:qr --open
bun run app:qr --url https://server.example --name Personal
bun run app:qr --url https://server.example --name Work --ui-url https://ui.example
```

The terminal QR uses half-block characters, explicit black and white colors, and a white border. If the window is too narrow, the command provides the PNG path instead of printing a QR that would wrap. Widen the terminal and run again, or use `--open` to also open the image. The PNG can also be imported in PocketHook.

Requires the macOS Swift runtime/toolchain, supplied by Xcode or its command line tools. No third-party QR renderer is installed. The QR image is generated in a restricted temporary directory outside the repository; the permanent authentication token is never printed or encoded in the QR.

The configuration includes the chat endpoint, authentication token, `/health`, `/jobs`, the configured fetch message, and `/dashboard` when enabled. A custom HTTPS UI can be supplied with `--ui-url`; an empty string disables UI configuration.

## Invitation protocol

- `POST /app-pairing/code`: requires the existing owner Bearer token. Body: `serverURL`, `name`, optional `personalUIURL`.
- Returns `qr` (a JSON string) and `expiresAt`. The QR contains only `type: pockethook-pairing`, `version: 1`, `serverURL`, and a random 256-bit invitation code.
- `POST /app-pairing/redeem`: body `{ "code": "..." }`; returns the server configuration once. Expired or reused invitations return 410.
- Invitations expire after five minutes, and generating another one invalidates the previous invitation. Restarting the server invalidates invitations too.
- Codes are stored hashed in memory. Replies use `Cache-Control: no-store`. The app refuses redirects during redemption.
- The permanent server token is never encoded in the QR. After redemption it is held in Apple Keychain, independently for each server profile. When the user enables iCloud sync for that profile, the app also synchronizes its credentials through iCloud Keychain. Both devices must use the same Apple Account with iCloud Keychain enabled; credentials may arrive after the profile.

Pairing grants the existing owner's access. This feature does not add multi-user accounts, family sharing or permission isolation between people.

Tests:

```sh
bun test tests/app-pairing.test.ts tests/app-pair-discovery.test.ts
bunx tsc --noEmit
```
