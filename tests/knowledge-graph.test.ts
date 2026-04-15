import { describe, test, expect, beforeAll } from "bun:test";
import {
  addTriple,
  queryTriples,
  invalidateTriplesByProjectSlug,
} from "../src/knowledge-graph.js";

// These tests share the real SQLite knowledge-graph DB. Each test scopes
// itself to a unique subject so runs don't interfere with live data.

describe("invalidateTriplesByProjectSlug", () => {
  const SUBJECT = `test-user-${Date.now()}`;

  beforeAll(() => {
    addTriple(SUBJECT, "scheduled_visit_barcelona", "2026-04-19");
    addTriple(SUBJECT, "planning_visit_barcelona", "2026-04-10");
    // A different project whose slug contains the first as a substring.
    // Should NOT be invalidated when closing visit_barcelona.
    addTriple(SUBJECT, "scheduled_revisit_barcelona", "2026-06");
    addTriple(SUBJECT, "scheduled_visit_japan", "2026-07");
    addTriple(SUBJECT, "lives_in", "Madrid");
  });

  test("invalidates only exact or _slug-suffix predicates, not substrings", () => {
    const n = invalidateTriplesByProjectSlug("visit_barcelona", SUBJECT);
    expect(n).toBe(2);

    const activeAfter = queryTriples(SUBJECT);
    const predicates = activeAfter.map((t) => t.predicate).sort();
    // revisit_barcelona survives because "visit_barcelona" must follow an
    // underscore boundary, not appear mid-token.
    expect(predicates).toEqual([
      "lives_in",
      "scheduled_revisit_barcelona",
      "scheduled_visit_japan",
    ]);
  });

  test("matches a predicate that IS exactly the slug", () => {
    const EXACT = `test-exact-${Date.now()}`;
    addTriple(EXACT, "my_project", "in_progress");
    addTriple(EXACT, "tracking_my_project", "daily");
    const n = invalidateTriplesByProjectSlug("my_project", EXACT);
    // Both the exact predicate and the `_my_project` suffix match.
    expect(n).toBe(2);
  });

  test("returns 0 when no active triples match", () => {
    const n = invalidateTriplesByProjectSlug("visit_barcelona", SUBJECT);
    expect(n).toBe(0);
  });

  test("respects subject filter — does not touch other subjects", () => {
    const OTHER = `test-other-${Date.now()}`;
    addTriple(OTHER, "scheduled_visit_paris", "2026-05");
    const n = invalidateTriplesByProjectSlug("visit_paris", SUBJECT);
    expect(n).toBe(0);
    const other = queryTriples(OTHER);
    expect(other.length).toBe(1);
    // Clean up so reruns don't accumulate.
    invalidateTriplesByProjectSlug("visit_paris", OTHER);
  });

  test("empty/whitespace slug is a no-op", () => {
    const n = invalidateTriplesByProjectSlug("   ");
    expect(n).toBe(0);
  });
});
