import { describe, test, expect } from "bun:test";
import { checkRateLimit, configureRateLimit } from "../src/rate-limit.js";

describe("checkRateLimit", () => {
  test("allows requests within limit", () => {
    // Use a unique token to avoid interference between tests
    const token = "test-token-" + Date.now();
    const result = checkRateLimit(token);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeGreaterThan(0);
  });

  test("blocks requests over limit", () => {
    // Configure a very small limit for testing
    configureRateLimit({ maxRequests: 3, windowMs: 60_000 });

    const token = "test-flood-" + Date.now();
    expect(checkRateLimit(token).allowed).toBe(true);  // 1
    expect(checkRateLimit(token).allowed).toBe(true);  // 2
    expect(checkRateLimit(token).allowed).toBe(true);  // 3
    expect(checkRateLimit(token).allowed).toBe(false); // 4 — blocked

    // Restore defaults
    configureRateLimit({ maxRequests: 30, windowMs: 60_000 });
  });

  test("returns remaining count", () => {
    configureRateLimit({ maxRequests: 5, windowMs: 60_000 });

    const token = "test-remaining-" + Date.now();
    const r1 = checkRateLimit(token);
    expect(r1.remaining).toBe(4);

    const r2 = checkRateLimit(token);
    expect(r2.remaining).toBe(3);

    // Restore defaults
    configureRateLimit({ maxRequests: 30, windowMs: 60_000 });
  });

  test("returns retryAfterMs when blocked", () => {
    configureRateLimit({ maxRequests: 1, windowMs: 60_000 });

    const token = "test-retry-" + Date.now();
    checkRateLimit(token); // 1 — allowed
    const blocked = checkRateLimit(token); // 2 — blocked

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeDefined();
    expect(blocked.retryAfterMs!).toBeGreaterThan(0);
    expect(blocked.retryAfterMs!).toBeLessThanOrEqual(60_000);

    // Restore defaults
    configureRateLimit({ maxRequests: 30, windowMs: 60_000 });
  });

  test("different tokens have independent limits", () => {
    configureRateLimit({ maxRequests: 2, windowMs: 60_000 });

    const token1 = "test-indep-a-" + Date.now();
    const token2 = "test-indep-b-" + Date.now();

    checkRateLimit(token1); // 1
    checkRateLimit(token1); // 2
    expect(checkRateLimit(token1).allowed).toBe(false); // 3 — blocked

    // token2 should still be allowed
    expect(checkRateLimit(token2).allowed).toBe(true);

    // Restore defaults
    configureRateLimit({ maxRequests: 30, windowMs: 60_000 });
  });
});
