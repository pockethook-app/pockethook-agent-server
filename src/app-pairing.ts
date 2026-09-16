import { createHash, randomBytes } from "node:crypto";

export interface AppServerConfiguration {
  version: 1;
  name: string;
  serverURL: string;
  authToken: string;
  healthCheckURL: string;
  pollingURL: string;
  fetchMessage: string;
  personalUIURL?: string;
}

interface Invitation {
  expiresAt: number;
  configuration: AppServerConfiguration;
}

/** Owner-generated invitations. Neither permanent credentials nor user data go in a QR. */
export class AppPairingStore {
  private readonly invitations = new Map<string, Invitation>();

  constructor(private readonly now: () => number = Date.now) {}

  create(configuration: AppServerConfiguration): { qr: string; expiresAt: string } {
    const base = new URL(configuration.serverURL);
    if (base.protocol !== "https:" || !base.hostname || base.username || base.password || base.search || base.hash) {
      throw new Error("Use the HTTPS address reachable from your iPhone, without credentials or query parameters.");
    }
    if (base.pathname !== "/") throw new Error("Use the server root address, without a path.");
    if (!configuration.name.trim() || configuration.name.length > 80) throw new Error("Name must contain 1–80 characters.");
    for (const [digest, invite] of this.invitations) {
      if (invite.expiresAt <= this.now()) this.invitations.delete(digest);
    }
    // Generating another code invalidates the previous one. Only one owner onboarding flow is active.
    this.invitations.clear();
    const code = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + 5 * 60_000;
    this.invitations.set(this.digest(code), { expiresAt, configuration: { ...configuration, serverURL: base.href } });
    const qr = JSON.stringify({ type: "pockethook-pairing", version: 1, serverURL: base.href, code });
    return { qr, expiresAt: new Date(expiresAt).toISOString() };
  }

  redeem(code: string): AppServerConfiguration | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return;
    const digest = this.digest(code);
    const invitation = this.invitations.get(digest);
    if (!invitation) return;
    this.invitations.delete(digest); // Synchronous consume before returning: concurrent redemption cannot win twice.
    if (invitation.expiresAt <= this.now()) return;
    return { ...invitation.configuration };
  }

  private digest(code: string): string {
    return createHash("sha256").update(code).digest("hex");
  }
}

export function createAppPairingHandler(options: {
  authToken: string;
  fetchMessage: string;
  dashboardEnabled: boolean;
  isAuthorized: (request: Request) => boolean;
  store?: AppPairingStore;
}) {
  const store = options.store ?? new AppPairingStore();
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers });
    if (path === "/app-pairing/code" && !options.isAuthorized(request)) {
      return new Response("Unauthorized", { status: 401, headers });
    }
    if (path !== "/app-pairing/code" && path !== "/app-pairing/redeem") {
      return new Response("Not found", { status: 404, headers });
    }
    try {
      // Stream with a bound; Content-Length alone is untrusted.
      const reader = request.body?.getReader();
      let body = "";
      let size = 0;
      const decoder = new TextDecoder();
      if (reader) {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > 4096) {
            await reader.cancel();
            return new Response("Payload too large", { status: 413, headers });
          }
          body += decoder.decode(next.value, { stream: true });
        }
      }
      body += decoder.decode();
      const input = JSON.parse(body) as Record<string, unknown>;
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid configuration.");
      if (path === "/app-pairing/redeem") {
        const configuration = typeof input.code === "string" ? store.redeem(input.code) : undefined;
        return configuration
          ? Response.json(configuration, { headers })
          : Response.json({ error: "The QR has expired or has already been used. Generate another one." }, { status: 410, headers });
      }
      if (typeof input.serverURL !== "string" || typeof input.name !== "string") throw new Error("Server URL and name are required.");
      const base = new URL(input.serverURL);
      const personalUIURL = input.personalUIURL === "" ? undefined
        : typeof input.personalUIURL === "string" ? input.personalUIURL
        : options.dashboardEnabled ? new URL("/dashboard", base).href : undefined;
      if (personalUIURL) {
        const ui = new URL(personalUIURL);
        if (ui.protocol !== "https:" || ui.username || ui.password) throw new Error("Personal UI must use HTTPS without embedded credentials.");
      }
      const invitation = store.create({
        version: 1, name: input.name.trim(), serverURL: base.href, authToken: options.authToken,
        healthCheckURL: new URL("/health", base).href,
        pollingURL: new URL("/jobs", base).href,
        fetchMessage: options.fetchMessage,
        personalUIURL,
      });
      return Response.json(invitation, { status: 201, headers });
    } catch {
      // Never echo request bodies: the redemption body contains the invitation secret.
      return Response.json({ error: "Invalid pairing configuration. Use a name and an HTTPS server root URL." }, { status: 400, headers });
    }
  };
}
