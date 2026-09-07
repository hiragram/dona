import { createHash, timingSafeEqual } from "node:crypto";
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

const driveChangeSchema = z.strictObject({
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
  }).optional(),
});

const drivePageSchema = z.strictObject({
  changes: z.array(driveChangeSchema).max(10_000),
  nextPageToken: z.string().min(1).max(16_384).optional(),
  newStartPageToken: z.string().min(1).max(16_384).optional(),
});

export interface DriveChangesClient {
  list(input: Readonly<{ pageToken: string; supportsAllDrives: true; includeItemsFromAllDrives: true }>): Promise<unknown>;
}

export interface DriveAllowlist {
  readonly fileIds: ReadonlySet<string>;
  readonly folderIds: ReadonlySet<string>;
  readonly driveIds: ReadonlySet<string>;
}

function canonicalChangeId(change: z.infer<typeof driveChangeSchema>): string {
  // zodのstrict parse後の固定field順を署名し、同時刻の異なるchangeを衝突させない。
  return createHash("sha256").update(JSON.stringify(change)).digest("hex");
}

function allowed(change: z.infer<typeof driveChangeSchema>, allowlist: DriveAllowlist): boolean {
  return allowlist.fileIds.has(change.fileId) ||
    (change.driveId !== undefined && allowlist.driveIds.has(change.driveId)) ||
    (change.file?.parents ?? []).some((parent) => allowlist.folderIds.has(parent));
}

function envelope(binding: DeliveryBinding, change: z.infer<typeof driveChangeSchema>): EventEnvelope {
  const providerEventId = canonicalChangeId(change);
  return {
    schema_version: 1,
    source: driveSource,
    external_event_id: scopedExternalEventId(driveSource, binding.connectionId, providerEventId),
    type: "changed",
    occurred_at: new Date(change.time).toISOString(),
    subject: { account: binding.account, resource: binding.resource, file_id: change.fileId },
    payload: {
      removed: change.removed ?? false,
      drive_id: change.driveId ?? null,
      file: change.file === undefined ? null : {
        id: change.file.id, name: change.file.name ?? null, mime_type: change.file.mimeType ?? null,
        parent_ids: change.file.parents ?? [], trashed: change.file.trashed ?? false,
      },
    },
    reply_target: null,
  };
}

export async function drainDriveChanges(
  database: DispatcherDatabase,
  binding: DeliveryBinding,
  client: DriveChangesClient,
  allowlist: DriveAllowlist,
  limits?: { pages: number; events: number; timeoutMs: number; bytes?: number },
): Promise<void> {
  await pollConnectionBatch(database, binding, async (checkpoint, page): Promise<CursorPage> => {
    const pageToken = page ?? checkpoint;
    if (pageToken === null) throw new ConnectionError("cursor_conflict");
    let raw: unknown;
    try {
      raw = await client.list({ pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true });
    } catch {
      throw new ConnectionError("incomplete_batch");
    }
    const parsed = drivePageSchema.safeParse(raw);
    if (!parsed.success) throw new ConnectionError("incomplete_batch");
    const events = parsed.data.changes.filter((change) => allowed(change, allowlist)).map((change) => ({
      providerEventId: canonicalChangeId(change), envelope: envelope(binding, change),
    }));
    if (parsed.data.nextPageToken !== undefined) {
      if (parsed.data.newStartPageToken !== undefined) throw new ConnectionError("incomplete_batch");
      return { done: false, nextPage: parsed.data.nextPageToken, events };
    }
    if (parsed.data.newStartPageToken === undefined) throw new ConnectionError("incomplete_batch");
    return { done: true, checkpoint: parsed.data.newStartPageToken, events };
  }, limits);
}

/** getStartPageTokenの結果も空batchとして原子的に保存し、未設定cursorへのblind jumpを分離する。 */
export function initializeDriveCursor(database: DispatcherDatabase, binding: DeliveryBinding, startPageToken: string): void {
  if (startPageToken.length === 0 || startPageToken.length > 16_384) throw new ConnectionError("invalid_input");
  const expected = database.connections.cursor(binding.connectionId, binding.resource);
  if (expected.checkpoint !== null) throw new ConnectionError("cursor_conflict");
  database.commitConnectionBatch({ binding, expected, checkpoint: startPageToken, complete: true, events: [] });
}
