import { createHash, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { DispatcherDatabase } from "../database.js";
import { ConnectionError, type DeliveryBinding } from "../connections/domain.js";
import { pollConnectionBatch, type CursorPage } from "../connections/poll.js";
import { externalEventSource, scopedExternalEventId } from "../ingress.js";
import type { EventEnvelope } from "../types.js";

const driveSource = externalEventSource("google-drive");
const headerLimit = 512;

export interface DriveChannelBinding extends DeliveryBinding {
  channelId: string;
  channelToken: string;
  resourceId: string;
}

export type DrivePush =
  | { kind: "sync"; binding: DeliveryBinding; messageNumber: bigint }
  | { kind: "change"; binding: DeliveryBinding; messageNumber: bigint };

function oneHeader(headers: ReadonlyArray<readonly [string, string]>, name: string): string {
  const values = headers.filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);
  if (values.length !== 1 || values[0]!.length === 0 || values[0]!.length > headerLimit) {
    throw new ConnectionError("not_authorized");
  }
  return values[0]!;
}

function secretEqual(actual: string, expected: string): boolean {
  const a = createHash("sha256").update(actual).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Header-only Drive notifications are authenticated against active/overlap channel generations. */
export function verifyDrivePush(
  body: Buffer,
  headers: ReadonlyArray<readonly [string, string]>,
  channels: readonly DriveChannelBinding[],
): DrivePush {
  if (body.length !== 0) throw new ConnectionError("invalid_input");
  const channelId = oneHeader(headers, "x-goog-channel-id");
  const token = oneHeader(headers, "x-goog-channel-token");
  const resourceId = oneHeader(headers, "x-goog-resource-id");
  const state = oneHeader(headers, "x-goog-resource-state");
  const rawNumber = oneHeader(headers, "x-goog-message-number");
  if (!/^[1-9][0-9]{0,39}$/.test(rawNumber)) throw new ConnectionError("invalid_input");
  const candidates = channels.filter((entry) => entry.channelId === channelId && entry.resourceId === resourceId);
  const channel = candidates.find((entry) => secretEqual(token, entry.channelToken));
  if (!channel || candidates.length !== 1) throw new ConnectionError("not_authorized");
  const binding: DeliveryBinding = {
    connectionId: channel.connectionId, account: channel.account, revision: channel.revision,
    credentialRevision: channel.credentialRevision, resource: channel.resource, generation: channel.generation,
  };
  if (state === "sync") return { kind: "sync", binding, messageNumber: BigInt(rawNumber) };
  if (state === "change") return { kind: "change", binding, messageNumber: BigInt(rawNumber) };
  throw new ConnectionError("not_authorized");
}

const driveFileChangeSchema = z.object({
  fileId: z.string().min(1).max(256),
  removed: z.boolean().optional(),
  changeType: z.literal("file"),
  time: z.string().datetime({ offset: true }),
  driveId: z.string().min(1).max(256).optional(),
  file: z.strictObject({
    id: z.string().min(1).max(256),
    name: z.string().max(1024).optional(),
    mimeType: z.string().max(256).optional(),
    parents: z.array(z.string().min(1).max(256)).max(100).optional(),
    trashed: z.boolean().optional(),
  }).passthrough().optional(),
}).passthrough();

const driveOtherChangeSchema = z.object({
  changeType: z.string().min(1).max(64).refine((value) => value !== "file"),
  driveId: z.string().min(1).max(256).optional(),
  removed: z.boolean().optional(),
}).passthrough();

const driveChangeSchema = z.union([driveFileChangeSchema, driveOtherChangeSchema]);

const drivePageSchema = z.object({
  changes: z.array(driveChangeSchema).max(10_000).default([]),
  nextPageToken: z.string().min(1).max(16_384).optional(),
  newStartPageToken: z.string().min(1).max(16_384).optional(),
}).passthrough();

export interface DriveChangesClient {
  list(input: Readonly<{ pageToken: string; supportsAllDrives: true; includeItemsFromAllDrives: true;
    driveId?: string; pageSize: number; fields: string }>): Promise<unknown>;
}

export interface DriveAllowlist {
  readonly fileIds: ReadonlySet<string>;
  readonly folderIds: ReadonlySet<string>;
  readonly driveIds: ReadonlySet<string>;
  /** 永続projectionから得た、以前allowlist内だったfile。離脱/権限喪失tombstoneに使う。 */
  readonly priorFileIds?: ReadonlySet<string>;
}

export type DriveFeed = { readonly kind: "user" } | { readonly kind: "drive"; readonly driveId: string };

function errorReasons(error: unknown): string[] {
  if (typeof error !== "object" || error === null) return [];
  const result: string[] = [];
  const add = (value: unknown) => { if (typeof value === "string" && value.length <= 128) result.push(value); };
  const candidate = error as {reason?:unknown;errors?:unknown;response?:unknown};
  add(candidate.reason);
  if (Array.isArray(candidate.errors)) for (const item of candidate.errors) {
    if (typeof item === "object" && item !== null) add((item as {reason?:unknown}).reason);
  }
  const response = typeof candidate.response === "object" && candidate.response !== null ? candidate.response as {data?:unknown} : undefined;
  const data = typeof response?.data === "object" && response.data !== null ? response.data as {error?:unknown} : undefined;
  const apiError = typeof data?.error === "object" && data.error !== null ? data.error as {errors?:unknown} : undefined;
  if (Array.isArray(apiError?.errors)) for (const item of apiError.errors) {
    if (typeof item === "object" && item !== null) add((item as {reason?:unknown}).reason);
  }
  return result;
}

function canonicalChangeId(change: z.infer<typeof driveFileChangeSchema>): string {
  const canonical = { fileId: change.fileId, removed: change.removed ?? false, changeType: change.changeType,
    time: change.time, driveId: change.driveId ?? null };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function resourceChangeId(binding: DeliveryBinding, change: z.infer<typeof driveFileChangeSchema>): string {
  return createHash("sha256").update(`${binding.resource}\0${canonicalChangeId(change)}`).digest("hex");
}

function envelope(binding: DeliveryBinding, change: z.infer<typeof driveFileChangeSchema>, tombstone: boolean): EventEnvelope {
  const providerEventId = resourceChangeId(binding, change);
  return {
    schema_version: 1,
    source: driveSource,
    external_event_id: scopedExternalEventId(driveSource, binding.connectionId, providerEventId),
    type: "changed",
    occurred_at: new Date(change.time).toISOString(),
    subject: { account: binding.account, resource: binding.resource, file_id: change.fileId },
    payload: tombstone ? { removed: true, drive_id: null, file: null } : {
      removed: change.removed ?? false, drive_id: change.driveId ?? null,
      // changes.listのfile snapshotは再取得時に変わり得るため、Envelopeにはchange identityと同じ安定fieldだけを出す。
      file: change.file === undefined ? null : { id: change.file.id },
    },
    reply_target: null,
  };
}

export async function drainDriveChanges(
  database: DispatcherDatabase,
  binding: DeliveryBinding,
  client: DriveChangesClient,
  allowlist: DriveAllowlist,
  feed: DriveFeed = { kind: "user" },
  limits?: { pages: number; events: number; timeoutMs: number; bytes?: number },
): Promise<void> {
  const bounded = limits ?? { pages: 100, events: 10_000, timeoutMs: 30_000, bytes: 16_777_216 };
  if (![bounded.pages,bounded.events,bounded.timeoutMs,bounded.bytes ?? 16_777_216].every((value)=>Number.isSafeInteger(value)&&value>0))
    throw new ConnectionError("invalid_input");
  const deadline = performance.now() + bounded.timeoutMs;
  let totalEvents = 0, totalBytes = 0;
  const snapshot = database.connections.pollingSnapshot(binding);
  let expected = snapshot.cursor;
  const members = new Set([...snapshot.membership,...(allowlist.priorFileIds ?? [])]);
  const seenPageTokens = new Set<string>();
  for (let batch = 0; batch < bounded.pages; batch++) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new ConnectionError("incomplete_batch");
    const remainingEvents = bounded.events - totalEvents;
    const remainingBytes = (bounded.bytes ?? 16_777_216) - totalBytes;
    if (remainingEvents <= 0 || remainingBytes <= 0) throw new ConnectionError("incomplete_batch");
    let final = false;
    let committedCheckpoint: string | undefined;
    await pollConnectionBatch(database, binding, async (checkpoint, page): Promise<CursorPage> => {
    const pageToken = page ?? checkpoint;
    if (pageToken === null) throw new ConnectionError("cursor_conflict");
    if (seenPageTokens.has(pageToken)) throw new ConnectionError("incomplete_batch");
    seenPageTokens.add(pageToken);
    let raw: unknown;
    try {
      raw = await client.list({ pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true,
        ...(feed.kind === "drive" ? { driveId: feed.driveId } : {}),
        pageSize: Math.min(1000, remainingEvents),
        fields: "changes(fileId,removed,changeType,time,driveId,file(id,name,mimeType,parents,trashed)),nextPageToken,newStartPageToken" });
    } catch (error) {
      const candidate = typeof error === "object" && error !== null ? error as {status?:unknown;response?:unknown} : {};
      const response = typeof candidate.response === "object" && candidate.response !== null ? candidate.response as {status?:unknown} : undefined;
      const status = candidate.status ?? response?.status;
      const quota403 = status === 403 && errorReasons(error).some((reason) =>
        ["rateLimitExceeded","userRateLimitExceeded","sharingRateLimitExceeded"].includes(reason));
      if (status === 401 || (status === 403 && !quota403)) throw new ConnectionError("credential_unavailable");
      if (status === 410) throw new ConnectionError("cursor_conflict");
      throw new ConnectionError("incomplete_batch");
    }
    const parsed = drivePageSchema.safeParse(raw);
    if (!parsed.success) throw new ConnectionError("incomplete_batch");
    if (parsed.data.changes.some((change)=>change.changeType==="drive"&&change.removed===true&&
      change.driveId!==undefined&&(allowlist.driveIds.has(change.driveId)||(feed.kind==="drive"&&feed.driveId===change.driveId))))
      throw new ConnectionError("operation_pending");
    const fileChanges = parsed.data.changes.filter((change): change is z.infer<typeof driveFileChangeSchema> => change.changeType === "file")
      .filter((change) => feed.kind === "drive" ? change.driveId === feed.driveId : change.driveId === undefined || members.has(change.fileId));
    const events: {providerEventId:string;envelope:EventEnvelope}[] = [];
    for (const change of fileChanges) {
      const leftUserFeed = feed.kind === "user" && change.driveId !== undefined && members.has(change.fileId);
      const folderAllowed = (change.file?.parents ?? []).some((parent) => allowlist.folderIds.has(parent));
      const currentlyAllowed = !leftUserFeed && (allowlist.fileIds.has(change.fileId) ||
        (change.driveId !== undefined && allowlist.driveIds.has(change.driveId)) ||
        folderAllowed);
      const tombstone = !currentlyAllowed && members.has(change.fileId);
      if (!currentlyAllowed && !tombstone) continue;
      events.push({ providerEventId: resourceChangeId(binding, change), envelope: envelope(binding, change, tombstone) });
      // 離脱検知が必要なfolder projectionだけを追跡する。file/drive allowlistは静的判定できる。
      if (folderAllowed && !change.removed) members.add(change.fileId); else members.delete(change.fileId);
    }
    totalEvents += events.length;
    totalBytes += events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
    if (totalEvents > bounded.events || totalBytes > (bounded.bytes ?? 16_777_216)) throw new ConnectionError("incomplete_batch");
    if (parsed.data.nextPageToken !== undefined) {
      if (parsed.data.newStartPageToken !== undefined) throw new ConnectionError("incomplete_batch");
      if (seenPageTokens.has(parsed.data.nextPageToken)) throw new ConnectionError("incomplete_batch");
      // continuation tokenまでのchangeを先にdurable commitし、上限超過/restartでも前進可能にする。
      committedCheckpoint = parsed.data.nextPageToken;
      return { done: true, checkpoint: parsed.data.nextPageToken, events, membership:[...members].sort() };
    }
    if (parsed.data.newStartPageToken === undefined) throw new ConnectionError("incomplete_batch");
    final = true;
    committedCheckpoint = parsed.data.newStartPageToken;
    return { done: true, checkpoint: parsed.data.newStartPageToken, events, membership:[...members].sort() };
    }, { ...bounded, pages: 1, events: remainingEvents, bytes: remainingBytes, timeoutMs: remaining }, expected);
    if (committedCheckpoint === undefined) throw new ConnectionError("incomplete_batch");
    expected = { revision: expected.revision, version: expected.version + 1,
      checkpoint: committedCheckpoint };
    if (final) return;
  }
  // cursorは最後にcommitしたcontinuationを保持するため、次回はそこから安全に再開できる。
  throw new ConnectionError("incomplete_batch");
}

/** getStartPageTokenの結果も空batchとして原子的に保存し、未設定cursorへのblind jumpを分離する。 */
export function initializeDriveCursor(database: DispatcherDatabase, binding: DeliveryBinding, startPageToken: string): void {
  if (startPageToken.length === 0 || startPageToken.length > 16_384) throw new ConnectionError("invalid_input");
  const expected = database.connections.cursor(binding.connectionId, binding.resource);
  if (expected.checkpoint !== null) throw new ConnectionError("cursor_conflict");
  database.commitConnectionBatch({ binding, expected, checkpoint: startPageToken, complete: true, events: [] });
}
