import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { getAppleBridgeCredential } from "./apple-bridge-pairing.js";

const DEFAULT_APPLE_BRIDGE_URL = "http://127.0.0.1:32123";
const REQUEST_TIMEOUT_MS = 45_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

type FetchLike = typeof fetch;

interface BridgeCallOptions {
  baseURL?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  credential?: string;
}

interface BridgeEnvelope {
  requestId?: string;
  result?: unknown;
  error?: { code?: string; message?: string };
  completedAt?: string;
}

export function resolveAppleBridgeURL(value = process.env.APPLE_BRIDGE_URL): URL {
  const url = new URL(value?.trim() || DEFAULT_APPLE_BRIDGE_URL);
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("APPLE_BRIDGE_URL must use HTTP on a loopback host (127.0.0.1, localhost or ::1).")
  }
  return url;
}

export async function callAppleBridge(
  operation: string,
  payload?: Record<string, unknown>,
  confirmed = false,
  options: BridgeCallOptions = {},
): Promise<BridgeEnvelope> {
  const baseURL = resolveAppleBridgeURL(options.baseURL);
  const endpoint = new URL("/v1/execute", baseURL);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const credential = options.credential ?? getAppleBridgeCredential()?.credential;
  if (!credential) {
    clearTimeout(timeout);
    throw new Error("Apple Bridge is not paired. Run `bun run apple-bridge:code` and enter the code in the bridge app.");
  }

  try {
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${credential}` },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        operation,
        ...(payload ? { payload } : {}),
        ...(confirmed ? { confirmed: true } : {}),
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    let envelope: BridgeEnvelope;
    try {
      envelope = JSON.parse(text) as BridgeEnvelope;
    } catch {
      throw new Error(`Apple Bridge returned invalid JSON (HTTP ${response.status}).`);
    }

    if (!response.ok || envelope.error) {
      const code = envelope.error?.code ?? `http_${response.status}`;
      const message = envelope.error?.message ?? response.statusText;
      throw new Error(`Apple Bridge ${code}: ${message}`);
    }
    return envelope;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Apple Bridge did not respond within ${options.timeoutMs ?? REQUEST_TIMEOUT_MS} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const optionalString = (description: string) => Type.Optional(Type.String({ description }));
const optionalDate = (description: string) => Type.Optional(Type.String({ format: "date-time", description }));
const confirmedDeletion = Type.Literal(true, { description: "Only true after the user explicitly confirms this exact destructive change." });
const birthdaySchema = Type.Optional(Type.Object({
  year: Type.Optional(Type.Integer()),
  month: Type.Integer({ minimum: 1, maximum: 12 }),
  day: Type.Integer({ minimum: 1, maximum: 31 }),
}));
const cellValueSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);

export const appleBridgeSchema = Type.Union([
  Type.Object({ action: Type.Literal("get_permissions") }),
  Type.Object({ action: Type.Literal("list_calendars") }),
  Type.Object({ action: Type.Literal("list_calendar_sources") }),
  Type.Object({ action: Type.Literal("create_calendar"), title: Type.String(), source_id: optionalString("Apple account/source ID. Omit to use the default account.") }),
  Type.Object({ action: Type.Literal("rename_calendar"), calendar_id: Type.String(), title: Type.String() }),
  Type.Object({ action: Type.Literal("delete_calendar"), calendar_id: Type.String(), confirmed: confirmedDeletion }),
  Type.Object({
    action: Type.Literal("search_events"),
    start_date: Type.String({ format: "date-time", description: "Inclusive start as ISO 8601 with timezone." }),
    end_date: Type.String({ format: "date-time", description: "Exclusive end as ISO 8601 with timezone." }),
    calendar_ids: Type.Optional(Type.Array(Type.String(), { description: "Native calendar IDs. Omit for every calendar." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  }),
  Type.Object({
    action: Type.Literal("create_event"),
    title: Type.String(),
    start_date: Type.String({ format: "date-time" }),
    end_date: Type.String({ format: "date-time" }),
    calendar_id: optionalString("Native calendar ID. Omit to use the default calendar."),
    all_day: Type.Optional(Type.Boolean()),
    location: optionalString("Event location."),
    notes: optionalString("Event notes."),
    url: optionalString("URL associated with the event."),
    alarm_offset_seconds: Type.Optional(Type.Number({ description: "Alarm offset relative to the start; negative means before." })),
  }),
  Type.Object({
    action: Type.Literal("update_event"),
    identifier: Type.String({ description: "Native event ID returned by search_events." }),
    title: optionalString("Replacement title."),
    start_date: optionalDate("Replacement start as ISO 8601 with timezone."),
    end_date: optionalDate("Replacement end as ISO 8601 with timezone."),
    calendar_id: optionalString("Move to this native calendar ID."),
    all_day: Type.Optional(Type.Boolean()),
    location: optionalString("Replacement location."),
    notes: optionalString("Replacement notes."),
    url: optionalString("Replacement URL."),
    alarm_offset_seconds: Type.Optional(Type.Number({ description: "Replace alarms with one alarm at this offset; negative means before start." })),
    clear_location: Type.Optional(Type.Boolean()),
    clear_notes: Type.Optional(Type.Boolean()),
    clear_url: Type.Optional(Type.Boolean()),
    clear_alarm: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    action: Type.Literal("delete_event"),
    identifier: Type.String({ description: "Native event ID returned by search_events." }),
    confirmed: Type.Literal(true, { description: "Only true after the user explicitly confirms this exact deletion." }),
  }),
  Type.Object({ action: Type.Literal("list_reminder_lists") }),
  Type.Object({ action: Type.Literal("list_reminder_sources") }),
  Type.Object({ action: Type.Literal("create_reminder_list"), title: Type.String(), source_id: optionalString("Apple account/source ID. Omit to use the default account.") }),
  Type.Object({ action: Type.Literal("rename_reminder_list"), list_id: Type.String(), title: Type.String() }),
  Type.Object({ action: Type.Literal("delete_reminder_list"), list_id: Type.String(), confirmed: confirmedDeletion }),
  Type.Object({
    action: Type.Literal("search_reminders"),
    list_ids: Type.Optional(Type.Array(Type.String(), { description: "Native reminder-list IDs. Omit for every list." })),
    due_after: optionalDate("Only reminders due at or after this ISO 8601 date."),
    due_before: optionalDate("Only reminders due at or before this ISO 8601 date."),
    completed: Type.Optional(Type.Boolean({ description: "Filter by completion state." })),
    query: optionalString("Match reminder title or notes."),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  }),
  Type.Object({
    action: Type.Literal("create_reminder"),
    title: Type.String(),
    list_id: optionalString("Native reminder-list ID. Omit to use the default list."),
    notes: optionalString("Reminder notes."),
    due_date: optionalDate("Due date as ISO 8601 with timezone."),
    priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 9, description: "Apple reminder priority, 0-9. Default 0." })),
  }),
  Type.Object({
    action: Type.Literal("update_reminder"),
    identifier: Type.String({ description: "Native reminder ID returned by search_reminders." }),
    list_id: optionalString("Move to this native reminder-list ID."),
    title: optionalString("Replacement title."),
    notes: optionalString("Replacement notes."),
    due_date: optionalDate("Replacement due date as ISO 8601 with timezone."),
    completed: Type.Optional(Type.Boolean()),
    priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 9 })),
    clear_notes: Type.Optional(Type.Boolean()),
    clear_due_date: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    action: Type.Literal("delete_reminder"),
    identifier: Type.String({ description: "Native reminder ID returned by search_reminders." }),
    confirmed: confirmedDeletion,
  }),
  Type.Object({ action: Type.Literal("search_contacts"), query: optionalString("Name or organization to match."), group_id: optionalString("Only contacts in this native group ID."), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }),
  Type.Object({ action: Type.Literal("list_contact_groups") }),
  Type.Object({
    action: Type.Literal("create_contact"),
    given_name: Type.String(),
    middle_name: optionalString("Middle name."),
    family_name: optionalString("Family name."),
    nickname: optionalString("Nickname."),
    organization_name: optionalString("Organization."),
    job_title: optionalString("Job title."),
    phone_numbers: Type.Optional(Type.Array(Type.String())),
    email_addresses: Type.Optional(Type.Array(Type.String({ format: "email" }))),
    birthday: birthdaySchema,
  }),
  Type.Object({
    action: Type.Literal("update_contact"),
    identifier: Type.String({ description: "Native contact ID returned by search_contacts." }),
    given_name: optionalString("Replacement given name."),
    middle_name: optionalString("Replacement middle name."),
    family_name: optionalString("Replacement family name."),
    nickname: optionalString("Replacement nickname."),
    organization_name: optionalString("Replacement organization."),
    job_title: optionalString("Replacement job title."),
    phone_numbers: Type.Optional(Type.Array(Type.String())),
    email_addresses: Type.Optional(Type.Array(Type.String({ format: "email" }))),
    birthday: birthdaySchema,
    clear_birthday: Type.Optional(Type.Boolean()),
  }),
  Type.Object({ action: Type.Literal("delete_contact"), identifier: Type.String(), confirmed: confirmedDeletion }),
  Type.Object({ action: Type.Literal("create_contact_group"), name: Type.String() }),
  Type.Object({ action: Type.Literal("add_contacts_to_group"), group_id: Type.String(), contact_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 100 }) }),
  Type.Object({ action: Type.Literal("remove_contacts_from_group"), group_id: Type.String(), contact_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 100 }) }),
  Type.Object({ action: Type.Literal("delete_contact_group"), group_id: Type.String(), confirmed: confirmedDeletion }),
  Type.Object({
    action: Type.Literal("search_music"),
    term: optionalString("Song or artist query; required for catalog search."),
    source: Type.Optional(Type.Union([Type.Literal("library", { description: "Search the Music app library and return persistent IDs usable in playlists." }), Type.Literal("catalog", { description: "Search Apple Music catalog IDs for discovery and playback." })])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }),
  Type.Object({ action: Type.Literal("list_music_playlists"), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
  Type.Object({
    action: Type.Literal("create_music_playlist"),
    name: Type.String(),
    description: optionalString("Playlist description."),
    song_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 100, description: "Persistent song IDs returned by search_music with source library." }),
  }),
  Type.Object({
    action: Type.Literal("add_songs_to_music_playlist"),
    playlist_id: Type.String({ description: "Persistent playlist ID returned by list_music_playlists." }),
    song_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 100, description: "Persistent song IDs returned by search_music with source library." }),
  }),
  Type.Object({ action: Type.Literal("play_music"), identifier: Type.String({ description: "Song ID returned by search_music from either library or catalog." }) }),
  Type.Object({ action: Type.Literal("pause_music") }),
  Type.Object({ action: Type.Literal("delete_music_playlist"), playlist_id: Type.String(), confirmed: confirmedDeletion }),
  Type.Object({ action: Type.Literal("list_file_roots") }),
  Type.Object({ action: Type.Literal("list_files"), root_id: Type.String(), path: Type.Optional(Type.String({ description: "Path relative to the authorized root; empty means the root." })) }),
  Type.Object({ action: Type.Literal("read_text_file"), root_id: Type.String(), path: Type.String(), maximum_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })) }),
  Type.Object({ action: Type.Literal("write_text_file"), root_id: Type.String(), path: Type.String(), content: Type.String(), overwrite: Type.Optional(Type.Boolean()), confirmed: Type.Optional(confirmedDeletion) }),
  Type.Object({ action: Type.Literal("create_directory"), root_id: Type.String(), path: Type.String() }),
  Type.Object({ action: Type.Literal("move_file"), root_id: Type.String(), source_path: Type.String(), destination_path: Type.String(), overwrite: Type.Optional(Type.Boolean()), confirmed: Type.Optional(confirmedDeletion) }),
  Type.Object({ action: Type.Literal("delete_file"), root_id: Type.String(), path: Type.String(), confirmed: confirmedDeletion }),
  Type.Object({ action: Type.Literal("create_pages_document"), root_id: Type.String(), path: Type.String(), text: Type.String() }),
  Type.Object({ action: Type.Literal("read_pages_document"), root_id: Type.String(), path: Type.String() }),
  Type.Object({
    action: Type.Literal("create_numbers_spreadsheet"), root_id: Type.String(), path: Type.String(),
    values: Type.Array(Type.Array(cellValueSchema, { minItems: 1 }), { minItems: 1 }),
  }),
  Type.Object({
    action: Type.Literal("read_numbers_range"), root_id: Type.String(), path: Type.String(),
    sheet: optionalString("Sheet name; omit for the first sheet."), table: optionalString("Table name; omit for the first table."), range: Type.String({ description: "A1 range, for example A1:C10." }),
  }),
  Type.Object({
    action: Type.Literal("write_numbers_range"), root_id: Type.String(), path: Type.String(),
    sheet: optionalString("Sheet name; omit for the first sheet."), table: optionalString("Table name; omit for the first table."), range: Type.String(),
    values: Type.Array(Type.Array(cellValueSchema, { minItems: 1 }), { minItems: 1 }),
  }),
  Type.Object({
    action: Type.Literal("create_keynote_presentation"), root_id: Type.String(), path: Type.String(),
    slides: Type.Array(Type.Object({ title: Type.String(), body: Type.Optional(Type.String()) }), { minItems: 1 }),
  }),
  Type.Object({
    action: Type.Literal("export_iwork_document"), application: Type.Union([Type.Literal("pages"), Type.Literal("numbers"), Type.Literal("keynote")]),
    root_id: Type.String(), input_path: Type.String(), output_path: Type.String(), format: Type.String({ description: "Typed format supported by the chosen iWork app, such as PDF, Word, Excel, PowerPoint, EPUB, or CSV." }),
  }),
  Type.Object({ action: Type.Literal("get_current_location") }),
  Type.Object({
    action: Type.Literal("search_places"), query: Type.String(), latitude: Type.Optional(Type.Number()), longitude: Type.Optional(Type.Number()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
  }),
  Type.Object({
    action: Type.Literal("get_directions"), origin_latitude: Type.Number(), origin_longitude: Type.Number(), destination_latitude: Type.Number(), destination_longitude: Type.Number(),
    transport: Type.Optional(Type.Union([Type.Literal("automobile"), Type.Literal("walking"), Type.Literal("transit"), Type.Literal("cycling")])),
  }),
], { description: "Typed local Apple data and app operation." });

type AppleBridgeParams = Record<string, unknown> & { action: string };

export function mapAppleBridgeAction(params: AppleBridgeParams): {
  operation: string;
  payload?: Record<string, unknown>;
  confirmed?: boolean;
} {
  switch (params.action) {
    case "get_permissions": return { operation: "permissions.get" };
    case "list_calendars": return { operation: "calendar.list" };
    case "list_calendar_sources": return { operation: "calendar.sources.list" };
    case "create_calendar": return { operation: "calendar.create", payload: { title: params.title, sourceID: params.source_id } };
    case "rename_calendar": return { operation: "calendar.update", payload: { identifier: params.calendar_id, title: params.title } };
    case "delete_calendar": return { operation: "calendar.delete", payload: { identifier: params.calendar_id }, confirmed: params.confirmed === true };
    case "search_events": return {
      operation: "calendar.events.search",
      payload: { startDate: params.start_date, endDate: params.end_date, calendarIDs: params.calendar_ids ?? [], limit: params.limit ?? 500 },
    };
    case "create_event": return {
      operation: "calendar.events.create",
      payload: {
        calendarID: params.calendar_id,
        title: params.title,
        startDate: params.start_date,
        endDate: params.end_date,
        isAllDay: params.all_day ?? false,
        location: params.location,
        notes: params.notes,
        url: params.url,
        alarmOffsetSeconds: params.alarm_offset_seconds,
      },
    };
    case "update_event": return {
      operation: "calendar.events.update",
      payload: {
        identifier: params.identifier,
        calendarID: params.calendar_id,
        title: params.title,
        startDate: params.start_date,
        endDate: params.end_date,
        isAllDay: params.all_day,
        location: params.location,
        notes: params.notes,
        url: params.url,
        alarmOffsetSeconds: params.alarm_offset_seconds,
        clearLocation: params.clear_location,
        clearNotes: params.clear_notes,
        clearURL: params.clear_url,
        clearAlarm: params.clear_alarm,
      },
    };
    case "delete_event": return {
      operation: "calendar.events.delete",
      payload: { identifier: params.identifier },
      confirmed: params.confirmed === true,
    };
    case "list_reminder_lists": return { operation: "reminders.lists.list" };
    case "list_reminder_sources": return { operation: "reminders.sources.list" };
    case "create_reminder_list": return { operation: "reminders.lists.create", payload: { title: params.title, sourceID: params.source_id } };
    case "rename_reminder_list": return { operation: "reminders.lists.update", payload: { identifier: params.list_id, title: params.title } };
    case "delete_reminder_list": return { operation: "reminders.lists.delete", payload: { identifier: params.list_id }, confirmed: params.confirmed === true };
    case "search_reminders": return {
      operation: "reminders.search",
      payload: {
        listIDs: params.list_ids ?? [],
        dueAfter: params.due_after,
        dueBefore: params.due_before,
        isCompleted: params.completed,
        query: params.query,
        limit: params.limit ?? 100,
      },
    };
    case "create_reminder": return {
      operation: "reminders.create",
      payload: {
        listID: params.list_id,
        title: params.title,
        notes: params.notes,
        dueDate: params.due_date,
        priority: params.priority ?? 0,
      },
    };
    case "update_reminder": return {
      operation: "reminders.update",
      payload: {
        identifier: params.identifier,
        listID: params.list_id,
        title: params.title,
        notes: params.notes,
        dueDate: params.due_date,
        isCompleted: params.completed,
        priority: params.priority,
        clearNotes: params.clear_notes,
        clearDueDate: params.clear_due_date,
      },
    };
    case "delete_reminder": return {
      operation: "reminders.delete",
      payload: { identifier: params.identifier },
      confirmed: params.confirmed === true,
    };
    case "search_contacts": return { operation: "contacts.search", payload: { query: params.query, limit: params.limit ?? 50, groupID: params.group_id } };
    case "list_contact_groups": return { operation: "contacts.groups.list" };
    case "create_contact": return { operation: "contacts.create", payload: {
      givenName: params.given_name, middleName: params.middle_name, familyName: params.family_name,
      nickname: params.nickname, organizationName: params.organization_name, jobTitle: params.job_title,
      phoneNumbers: params.phone_numbers ?? [], emailAddresses: params.email_addresses ?? [], birthday: params.birthday,
    } };
    case "update_contact": return { operation: "contacts.update", payload: {
      identifier: params.identifier, givenName: params.given_name, middleName: params.middle_name,
      familyName: params.family_name, nickname: params.nickname, organizationName: params.organization_name,
      jobTitle: params.job_title, phoneNumbers: params.phone_numbers, emailAddresses: params.email_addresses, birthday: params.birthday, clearBirthday: params.clear_birthday,
    } };
    case "delete_contact": return { operation: "contacts.delete", payload: { identifier: params.identifier }, confirmed: params.confirmed === true };
    case "create_contact_group": return { operation: "contacts.groups.create", payload: { name: params.name } };
    case "add_contacts_to_group": return { operation: "contacts.groups.add_members", payload: { groupIdentifier: params.group_id, contactIdentifiers: params.contact_ids } };
    case "remove_contacts_from_group": return { operation: "contacts.groups.remove_members", payload: { groupIdentifier: params.group_id, contactIdentifiers: params.contact_ids } };
    case "delete_contact_group": return { operation: "contacts.groups.delete", payload: { identifier: params.group_id }, confirmed: params.confirmed === true };
    case "search_music": return { operation: "music.search", payload: { term: params.term, source: params.source ?? "library", limit: params.limit ?? 25 } };
    case "list_music_playlists": return { operation: "music.playlists.list", payload: { limit: params.limit ?? 50 } };
    case "create_music_playlist": return { operation: "music.playlists.create", payload: { name: params.name, description: params.description, songIDs: params.song_ids } };
    case "add_songs_to_music_playlist": return { operation: "music.playlists.add_songs", payload: { playlistID: params.playlist_id, songIDs: params.song_ids } };
    case "play_music": return { operation: "music.play", payload: { identifier: params.identifier } };
    case "pause_music": return { operation: "music.pause" };
    case "delete_music_playlist": return { operation: "music.playlists.delete", payload: { identifier: params.playlist_id }, confirmed: params.confirmed === true };
    case "list_file_roots": return { operation: "files.roots.list" };
    case "list_files": return { operation: "files.list", payload: { rootID: params.root_id, path: params.path ?? "" } };
    case "read_text_file": return { operation: "files.read_text", payload: { rootID: params.root_id, path: params.path, maximumBytes: params.maximum_bytes } };
    case "write_text_file": return { operation: "files.write_text", payload: { rootID: params.root_id, path: params.path, content: params.content, overwrite: params.overwrite ?? false }, confirmed: params.overwrite === true && params.confirmed === true };
    case "create_directory": return { operation: "files.create_directory", payload: { rootID: params.root_id, path: params.path } };
    case "move_file": return { operation: "files.move", payload: { rootID: params.root_id, sourcePath: params.source_path, destinationPath: params.destination_path, overwrite: params.overwrite ?? false }, confirmed: params.overwrite === true && params.confirmed === true };
    case "delete_file": return { operation: "files.delete", payload: { rootID: params.root_id, path: params.path }, confirmed: params.confirmed === true };
    case "create_pages_document": return { operation: "iwork.pages.create", payload: { rootID: params.root_id, path: params.path, text: params.text } };
    case "read_pages_document": return { operation: "iwork.pages.read", payload: { rootID: params.root_id, path: params.path } };
    case "create_numbers_spreadsheet": return { operation: "iwork.numbers.create", payload: { rootID: params.root_id, path: params.path, values: params.values } };
    case "read_numbers_range": return { operation: "iwork.numbers.read_range", payload: { rootID: params.root_id, path: params.path, sheet: params.sheet, table: params.table, range: params.range } };
    case "write_numbers_range": return { operation: "iwork.numbers.write_range", payload: { rootID: params.root_id, path: params.path, sheet: params.sheet, table: params.table, range: params.range, values: params.values } };
    case "create_keynote_presentation": return { operation: "iwork.keynote.create", payload: { rootID: params.root_id, path: params.path, slides: params.slides } };
    case "export_iwork_document": return { operation: "iwork.export", payload: { application: params.application, rootID: params.root_id, inputPath: params.input_path, outputPath: params.output_path, format: params.format } };
    case "get_current_location": return { operation: "location.current" };
    case "search_places": return { operation: "maps.places.search", payload: { query: params.query, latitude: params.latitude, longitude: params.longitude, limit: params.limit ?? 10 } };
    case "get_directions": return { operation: "maps.directions", payload: {
      originLatitude: params.origin_latitude, originLongitude: params.origin_longitude,
      destinationLatitude: params.destination_latitude, destinationLongitude: params.destination_longitude,
      transport: params.transport ?? "automobile",
    } };
    default: throw new Error(`Unknown Apple Bridge action: ${params.action}`);
  }
}

export function createAppleBridgeTool(): AgentTool<any> {
  return {
    name: "apple_bridge",
    label: "Apple Apps",
    description: "Read and manage Apple Calendar, Reminders, Contacts, Music, authorized iCloud Drive folders, Pages, Numbers, Keynote, Maps, and location through the paired local PocketHook Apple Bridge. Every request requires the credential established with bun run apple-bridge:code, and every action is independently controlled by the user in Apple Bridge; call get_permissions when capability_denied is returned and explain which switch is needed. Use list/search actions first and mutate by native IDs. New calendars and reminder lists may use the default Apple account or a source returned by the corresponding list sources action. Contact groups can be populated with the corresponding add action. To create or modify Music playlists, first use search_music with source library; catalog IDs are for discovery/playback and are not playlist persistent IDs. File and iWork actions are confined to folders the user adds in the bridge app. Use ISO 8601 dates with the user's timezone. Before any deletion or file overwrite, describe the exact item and ask for explicit confirmation; never infer it. If a mutation reports outcome_unknown, verify its target before retrying because the Apple app or iCloud may finish it in the background. Health and Home require a future iOS companion and are not exposed here. The bridge app must be running on the same Mac.",
    parameters: appleBridgeSchema,
    async execute(_id, rawParams) {
      try {
        const params = rawParams as AppleBridgeParams;
        const call = mapAppleBridgeAction(params);
        const envelope = await callAppleBridge(call.operation, call.payload, call.confirmed);
        return {
          content: [{ type: "text", text: JSON.stringify(envelope.result, null, 2) }],
          details: { operation: call.operation, completedAt: envelope.completedAt },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const result: AgentToolResult<unknown> = {
          content: [{ type: "text", text: `Apple Bridge error: ${message}` }],
          details: { error: message },
        };
        return result;
      }
    },
  };
}
