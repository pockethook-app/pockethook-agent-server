import { describe, test, expect } from "bun:test";
import { AppPairingStore, createAppPairingHandler } from "../src/app-pairing.js";

const configuration = {
  version: 1 as const, name: "Example", serverURL: "https://example.test/", authToken: "synthetic-test-token",
  healthCheckURL: "https://example.test/health", pollingURL: "https://example.test/jobs", fetchMessage: "fetchPendingTasks",
};

describe("PocketHook app pairing", () => {
  test("QR contains an expiring invitation, not credentials; redemption is one-use", () => {
    const store = new AppPairingStore();
    const invitation = store.create(configuration);
    expect(invitation.qr).not.toContain(configuration.authToken);
    const payload = JSON.parse(invitation.qr);
    expect(payload.type).toBe("pockethook-pairing");
    expect(store.redeem(payload.code)).toEqual(configuration);
    expect(store.redeem(payload.code)).toBeUndefined();
  });
  test("expiry, regeneration and invalid codes do not release credentials", () => {
    let now = 1000;
    const store = new AppPairingStore(() => now);
    const first = JSON.parse(store.create(configuration).qr).code;
    const second = JSON.parse(store.create(configuration).qr).code;
    expect(store.redeem(first)).toBeUndefined();
    expect(store.redeem("unknown")).toBeUndefined();
    now += 300_000;
    expect(store.redeem(second)).toBeUndefined();
  });
  test("rejects unsafe URLs", () => {
    const store = new AppPairingStore();
    for (const serverURL of ["http://example.test", "https://secret@example.test", "https://example.test/?token=secret", "https://example.test/path", "https://example.test/#secret"]) {
      expect(() => store.create({ ...configuration, serverURL })).toThrow();
    }
  });
  test("HTTP route requires owner authentication to create; redeem has no cache and bounded input", async () => {
    const handler = createAppPairingHandler({ authToken: configuration.authToken, fetchMessage: configuration.fetchMessage, dashboardEnabled: true, isAuthorized: r => r.headers.get("authorization") === "Bearer owner" });
    const request = (path: string, body: unknown, owner = false) => new Request(`https://example.test/app-pairing/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(owner ? { Authorization: "Bearer owner" } : {}) }, body: JSON.stringify(body),
    });
    expect((await handler(request("code", { serverURL: configuration.serverURL, name: "Example" }))).status).toBe(401);
    const created = await handler(request("code", { serverURL: configuration.serverURL, name: "Example" }, true));
    expect(created.status).toBe(201);
    const payload = JSON.parse((await created.json()).qr);
    const first = await handler(request("redeem", { code: payload.code }));
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.json()).toEqual({ ...configuration, personalUIURL: "https://example.test/dashboard" });
    expect((await handler(request("redeem", { code: payload.code }))).status).toBe(410);
    expect((await handler(request("redeem", { code: "x".repeat(5000) }))).status).toBe(413);
  });
});
