import { describe, expect, test } from "bun:test";
import { callAppleBridge, createAppleBridgeTool, mapAppleBridgeAction, resolveAppleBridgeURL } from "../src/apple-bridge.js";
import {
  APPLE_BRIDGE_BUNDLED_ZIP,
  APPLE_BRIDGE_DEFAULT_URL,
  resolveAppleBridgeInstallSource,
} from "../src/apple-bridge-app.js";

describe("Apple Bridge client", () => {
  test("only accepts loopback HTTP URLs", () => {
    expect(resolveAppleBridgeURL("http://127.0.0.1:32123").origin).toBe("http://127.0.0.1:32123");
    expect(resolveAppleBridgeURL("http://localhost:32123").hostname).toBe("localhost");
    expect(() => resolveAppleBridgeURL("http://192.168.1.20:32123")).toThrow("loopback");
    expect(() => resolveAppleBridgeURL("https://127.0.0.1:32123")).toThrow("loopback");
  });

  test("sends the bridge operation envelope", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ result: [{ id: "calendar-1" }], completedAt: "2026-08-15T08:00:00Z" }));
    }) as typeof fetch;

    const envelope = await callAppleBridge(
      "calendar.list",
      undefined,
      false,
      { baseURL: "http://127.0.0.1:32123", fetchImpl, credential: "test-credential" },
    );

    expect(capturedBody?.operation).toBe("calendar.list");
    expect(typeof capturedBody?.requestId).toBe("string");
    expect(envelope.result).toEqual([{ id: "calendar-1" }]);
  });

  test("surfaces typed errors from the native bridge", async () => {
    const fetchImpl = (async () => new Response(
      JSON.stringify({ error: { code: "confirmation_required", message: "Confirm first." } }),
      { status: 400 },
    )) as typeof fetch;

    await expect(callAppleBridge(
      "calendar.events.delete",
      { identifier: "event-1" },
      false,
      { baseURL: "http://127.0.0.1:32123", fetchImpl, credential: "test-credential" },
    )).rejects.toThrow("confirmation_required");
  });

  test("rejects invalid native responses", async () => {
    const fetchImpl = (async () => new Response("not-json", { status: 502 })) as typeof fetch;
    await expect(callAppleBridge("calendar.list", undefined, false, { fetchImpl, credential: "test-credential" }))
      .rejects.toThrow("invalid JSON");
  });

  test("enforces the client timeout", async () => {
    const fetchImpl = ((_: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })) as typeof fetch;
    await expect(callAppleBridge("calendar.list", undefined, false, { fetchImpl, timeoutMs: 5, credential: "test-credential" }))
      .rejects.toThrow("within 5 ms");
  });

  test("requires pairing and sends the bearer credential", async () => {
    await expect(callAppleBridge("calendar.list", undefined, false, {
      credential: "",
      fetchImpl: (async () => new Response("{}")) as typeof fetch,
    })).rejects.toThrow("not paired");

    let authorization: string | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("Authorization");
      return new Response(JSON.stringify({ result: [] }));
    }) as typeof fetch;
    await callAppleBridge("calendar.list", undefined, false, { credential: "secret", fetchImpl });
    expect(authorization).toBe("Bearer secret");
  });

  test("exposes a single typed agent tool", () => {
    const tool = createAppleBridgeTool();
    expect(tool.name).toBe("apple_bridge");
    expect(tool.description).toContain("explicit confirmation");
    expect(JSON.stringify(tool.parameters).toLowerCase()).not.toContain("photo");
    expect(JSON.stringify(tool.parameters).toLowerCase()).not.toContain("weather");
  });

  test("prefers an explicit installer source, then the bundled app", () => {
    expect(resolveAppleBridgeInstallSource("/tmp/local.app", "https://example.com/app.zip", true)).toBe("/tmp/local.app");
    expect(resolveAppleBridgeInstallSource("", "https://example.com/app.zip", true)).toBe("https://example.com/app.zip");
    expect(resolveAppleBridgeInstallSource("", "", true)).toBe(APPLE_BRIDGE_BUNDLED_ZIP);
    expect(resolveAppleBridgeInstallSource("", "", false)).toBe(APPLE_BRIDGE_DEFAULT_URL);
  });

  test("maps new Apple domains to typed native operations", () => {
    expect(mapAppleBridgeAction({ action: "search_contacts", query: "Ada" })).toEqual({
      operation: "contacts.search",
      payload: { query: "Ada", limit: 50 },
    });
    expect(mapAppleBridgeAction({ action: "write_numbers_range", root_id: "root-1", path: "budget.numbers", range: "A1:B2", values: [["Item", "Cost"], ["Tea", 3]] })).toEqual({
      operation: "iwork.numbers.write_range",
      payload: { rootID: "root-1", path: "budget.numbers", sheet: undefined, table: undefined, range: "A1:B2", values: [["Item", "Cost"], ["Tea", 3]] },
    });
    expect(mapAppleBridgeAction({ action: "create_music_playlist", name: "Bridge Mix", song_ids: ["A1", "B2"] })).toEqual({
      operation: "music.playlists.create",
      payload: { name: "Bridge Mix", description: undefined, songIDs: ["A1", "B2"] },
    });
    expect(mapAppleBridgeAction({ action: "add_songs_to_music_playlist", playlist_id: "P1", song_ids: ["C3"] })).toEqual({
      operation: "music.playlists.add_songs",
      payload: { playlistID: "P1", songIDs: ["C3"] },
    });
    expect(mapAppleBridgeAction({ action: "add_contacts_to_group", group_id: "group-1", contact_ids: ["person-1"] })).toEqual({
      operation: "contacts.groups.add_members",
      payload: { groupIdentifier: "group-1", contactIdentifiers: ["person-1"] },
    });
    expect(mapAppleBridgeAction({ action: "create_numbers_spreadsheet", root_id: "root-1", path: "audit.numbers", values: [["Ready"], [true]] })).toEqual({
      operation: "iwork.numbers.create",
      payload: { rootID: "root-1", path: "audit.numbers", values: [["Ready"], [true]] },
    });
    expect(mapAppleBridgeAction({ action: "create_calendar", title: "Projects", source_id: "icloud" })).toEqual({
      operation: "calendar.create",
      payload: { title: "Projects", sourceID: "icloud" },
    });
    expect(mapAppleBridgeAction({ action: "create_reminder_list", title: "Shopping" })).toEqual({
      operation: "reminders.lists.create",
      payload: { title: "Shopping", sourceID: undefined },
    });
  });

  test("maps bounded searches and explicit field clearing", () => {
    expect(mapAppleBridgeAction({ action: "search_events", start_date: "2026-08-15T00:00:00Z", end_date: "2026-08-16T00:00:00Z" })).toEqual({
      operation: "calendar.events.search",
      payload: { startDate: "2026-08-15T00:00:00Z", endDate: "2026-08-16T00:00:00Z", calendarIDs: [], limit: 500 },
    });
    expect(mapAppleBridgeAction({ action: "search_reminders", query: "factura" })).toEqual({
      operation: "reminders.search",
      payload: { listIDs: [], dueAfter: undefined, dueBefore: undefined, isCompleted: undefined, query: "factura", limit: 100 },
    });
    expect(mapAppleBridgeAction({ action: "update_event", identifier: "event-1", clear_notes: true, clear_alarm: true })).toEqual({
      operation: "calendar.events.update",
      payload: {
        identifier: "event-1", calendarID: undefined, title: undefined, startDate: undefined, endDate: undefined,
        isAllDay: undefined, location: undefined, notes: undefined, url: undefined, alarmOffsetSeconds: undefined,
        clearLocation: undefined, clearNotes: true, clearURL: undefined, clearAlarm: true,
      },
    });
    expect(mapAppleBridgeAction({ action: "update_reminder", identifier: "reminder-1", clear_due_date: true })).toEqual({
      operation: "reminders.update",
      payload: {
        identifier: "reminder-1", listID: undefined, title: undefined, notes: undefined, dueDate: undefined,
        isCompleted: undefined, priority: undefined, clearNotes: undefined, clearDueDate: true,
      },
    });
    expect(mapAppleBridgeAction({ action: "update_contact", identifier: "person-1", clear_birthday: true })).toEqual({
      operation: "contacts.update",
      payload: {
        identifier: "person-1", givenName: undefined, middleName: undefined, familyName: undefined,
        nickname: undefined, organizationName: undefined, jobTitle: undefined, phoneNumbers: undefined,
        emailAddresses: undefined, birthday: undefined, clearBirthday: true,
      },
    });
  });

  test("propagates explicit confirmation only for destructive actions", () => {
    expect(mapAppleBridgeAction({ action: "delete_contact", identifier: "person-1", confirmed: true })).toEqual({
      operation: "contacts.delete",
      payload: { identifier: "person-1" },
      confirmed: true,
    });
    expect(mapAppleBridgeAction({ action: "delete_file", root_id: "root-1", path: "old.txt", confirmed: false }).confirmed).toBe(false);
    expect(mapAppleBridgeAction({ action: "write_text_file", root_id: "root-1", path: "existing.txt", content: "new", overwrite: true, confirmed: true }).confirmed).toBe(true);
    expect(mapAppleBridgeAction({ action: "write_text_file", root_id: "root-1", path: "new.txt", content: "new" }).confirmed).toBe(false);
    expect(mapAppleBridgeAction({ action: "delete_music_playlist", playlist_id: "playlist-1", confirmed: true })).toEqual({
      operation: "music.playlists.delete",
      payload: { identifier: "playlist-1" },
      confirmed: true,
    });
    expect(mapAppleBridgeAction({ action: "delete_contact_group", group_id: "group-1", confirmed: true }).confirmed).toBe(true);
    expect(mapAppleBridgeAction({ action: "delete_calendar", calendar_id: "calendar-1", confirmed: true })).toEqual({
      operation: "calendar.delete",
      payload: { identifier: "calendar-1" },
      confirmed: true,
    });
    expect(mapAppleBridgeAction({ action: "delete_reminder_list", list_id: "list-1", confirmed: true }).confirmed).toBe(true);
  });
});
