import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appPairingName, selectAppPairingURL } from "../src/app-pair-discovery.js";

function listener(httpsPort: number, proxy = "http://localhost:3000", extraHandlers = {}) {
  return {
    TCP: { [httpsPort]: { HTTPS: true } },
    Web: { [`example.test:${httpsPort}`]: { Handlers: { "/": { Proxy: proxy }, ...extraHandlers } } },
  };
}

function listeners(...configs: ReturnType<typeof listener>[]) {
  return { TCP: Object.assign({}, ...configs.map(c => c.TCP)), Web: Object.assign({}, ...configs.map(c => c.Web)) };
}

describe("Automatic app pairing configuration", () => {
  test("finds this server among other services and preserves its non-default HTTPS port", () => {
    const status = listeners(listener(443, "http://localhost:4000"), listener(8443), listener(9443, "http://localhost:5000"));
    expect(selectAppPairingURL(status, 3000).url).toBe("https://example.test:8443/");
    expect(selectAppPairingURL(status, 4000).url).toBe("https://example.test/");
  });

  test("uses the configured tunnel port only if it points to this server", () => {
    const status = listeners(listener(443, "http://localhost:4000"), listener(8443), listener(9443));
    expect(selectAppPairingURL(status, 3000, [443, 9443]).url).toBe("https://example.test:9443/");
    expect(selectAppPairingURL(status, 3000, [443]).url).toBeUndefined();
    expect(selectAppPairingURL(status, 3000).candidates).toHaveLength(2);
    expect(selectAppPairingURL(listener(8443), 3000, [443]).url).toBe("https://example.test:8443/");
  });

  test("detects foreground and service listeners as well as background listeners", () => {
    expect(selectAppPairingURL({ Foreground: { session: listener(8443) } }, 3000).url).toBe("https://example.test:8443/");
    expect(selectAppPairingURL({ Services: { "svc:example": listener(8443) } }, 3000).url).toBe("https://example.test:8443/");
    expect(selectAppPairingURL({ ...listener(8443), Foreground: { session: listener(8443) } }, 3000).candidates).toHaveLength(1);
  });

  test("supports the local upstream address forms accepted by Serve", () => {
    for (const proxy of ["http://localhost:3000", "http://127.0.0.1:3000/", "http://[::1]:3000", "localhost:3000", "3000"]) {
      expect(selectAppPairingURL(listener(8443, proxy), 3000).url).toBe("https://example.test:8443/");
    }
  });

  test("never chooses another host, port, base path, or a non-HTTPS listener", () => {
    for (const proxy of ["http://remote.test:3000", "http://localhost:3001", "https://localhost:3000", "http://localhost:3000/api", "http://owner@localhost:3000", "http://localhost:3000/?token=synthetic"]) {
      expect(selectAppPairingURL(listener(8443, proxy), 3000).url).toBeUndefined();
    }
    expect(selectAppPairingURL({ ...listener(8443), TCP: { 8443: { HTTP: true } } }, 3000).url).toBeUndefined();
    expect(selectAppPairingURL({ ...listener(8443), Web: { "example.test:8443": { Handlers: { "/app": { Proxy: "3000" } } } } }, 3000).url).toBeUndefined();
  });

  test("rejects routes that override the app endpoints but allows unrelated mounts", () => {
    for (const mount of ["/app-pairing/", "/app-pairing", "/app-pairing/redeem", "/jobs", "/health"]) {
      expect(selectAppPairingURL(listener(8443, "3000", { [mount]: { Proxy: "4000" } }), 3000).url).toBeUndefined();
    }
    expect(selectAppPairingURL(listener(8443, "3000", { "/another-service": { Proxy: "4000" } }), 3000).url).toBe("https://example.test:8443/");
  });

  test("missing or malformed configuration does not invent a URL", () => {
    for (const status of [undefined, null, {}, [], "invalid", { Web: null }, { Web: { invalid: null } }, { Foreground: { session: null } }]) {
      expect(selectAppPairingURL(status, 3000)).toEqual({ url: undefined, candidates: [] });
    }
  });

  test("uses the configured agent name unless the owner supplies an override", () => {
    expect(appPairingName(undefined, "Example Assistant")).toBe("Example Assistant");
    expect(appPairingName("Work", "Example Assistant")).toBe("Work");
    expect(appPairingName()).toBe("PocketHook Assistant");
    expect(() => appPairingName(" ")).toThrow();
  });

  test.skipIf(process.platform !== "darwin")("CLI without a terminal reaches pairing with discovered settings and no questions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pockethook-qr-test-"));
    let received: { path: string; authorization: string | null; body: unknown } | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        received = { path: new URL(request.url).pathname, authorization: request.headers.get("authorization"), body: await request.json() };
        // Stop before rendering or opening an image; no actual invitation is generated.
        return new Response("Synthetic test stop", { status: 409 });
      },
    });
    try {
      const status = listeners(listener(443, "http://localhost:1"), listener(8443, `http://127.0.0.1:${server.port}`));
      await writeFile(join(directory, "tailscale"), `#!/bin/sh\n[ "$*" = "serve status --json" ] || exit 1\n/bin/cat <<'STATUS'\n${JSON.stringify(status)}\nSTATUS\n`, { mode: 0o700 });
      const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../src/app-pair.ts", import.meta.url))], {
        cwd: directory,
        env: { PATH: directory, PORT: String(server.port), AUTH_TOKEN: "synthetic-owner-token", AGENT_NAME: "Example Assistant" },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(received).toEqual({
        path: "/app-pairing/code", authorization: "Bearer synthetic-owner-token",
        body: { serverURL: "https://example.test:8443/", name: "Example Assistant" },
      });
      expect(exit).toBe(1);
      expect(stderr).toContain("Server returned 409");
      expect(stdout).not.toContain("HTTPS server address reachable from your iPhone");
      expect(stdout + stderr).not.toContain("synthetic-owner-token");
    } finally {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
