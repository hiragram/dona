import { z } from "zod";
import { assertSynchronousResult } from "../audit/synchronous.js";
import { MetadataConflictError } from "./metadata-tree.js";
import { ApprovalMetadataPlan, ApprovalMetadataPlanError } from "./metadata-plan.js";
import type { ApprovalIndex, ApprovalIndexList } from "./index-codec.js";

type Manifest = Extract<ApprovalIndex, { kind: "manifest" }>;
type Link = Extract<ApprovalIndex, { kind: "link" }>;
function guarded<T>(plan: ApprovalMetadataPlan, operation: () => T): T {
  try { return operation(); }
  catch (error) {
    plan.invalidate();
    if (error instanceof MetadataConflictError) throw new MetadataConflictError();
    throw new ApprovalMetadataPlanError();
  }
}
function manifest(plan: ApprovalMetadataPlan, list: ApprovalIndexList): Manifest {
  const value = plan.readIndex({ kind: "manifest", list });
  if (value?.kind !== "manifest") throw new ApprovalMetadataPlanError(); return value;
}
function link(plan: ApprovalMetadataPlan, list: ApprovalIndexList, recordId: string): Link {
  const value = plan.readIndex({ kind: "link", list, record_id: recordId });
  if (value?.kind !== "link" || !value.member) throw new ApprovalMetadataPlanError(); return value;
}
function ends(plan: ApprovalMetadataPlan, current: Manifest): { head: Link; tail: Link } | null {
  if (current.count === 0) return null;
  const head = link(plan, current.list, current.head!), tail = current.count === 1 ? head : link(plan, current.list, current.tail!);
  if (head.previous !== null || tail.next !== null) throw new ApprovalMetadataPlanError();
  if (current.count === 1 ? head.next !== null || tail.previous !== null
    : current.count === 2 ? head.next !== tail.record_id || tail.previous !== head.record_id
      : head.next === null || tail.previous === null || head.next === tail.record_id || tail.previous === head.record_id)
    throw new ApprovalMetadataPlanError();
  return { head, tail };
}
/** 内部list操作。record/状態/alias/認可の変更はrepositoryが同じplanへ加える。
 * 欠落manifestを空listに変換しない。初期manifest作成は明示genesisに限定する。 */
export function appendApprovalList(plan: ApprovalMetadataPlan, listInput: ApprovalIndexList, recordId: string): void {
 return guarded(plan, () => {
  assertSynchronousResult(listInput);
  const current = manifest(plan, listInput), boundary = ends(plan, current);
  const previous = plan.readIndex({ kind: "link", list: current.list, record_id: recordId });
  if (previous?.kind === "link" && previous.member) throw new MetadataConflictError();
  if (previous !== null && (previous.kind !== "link" || current.list.membership !== "active")) throw new ApprovalMetadataPlanError();
  if (current.count === Number.MAX_SAFE_INTEGER) throw new ApprovalMetadataPlanError();
  const added: Link = { codec_version: 1, scope: current.scope, kind: "link", list: current.list,
    record_id: recordId, member: true, previous: current.tail, next: null };
  // 局所検証を済ませてからplanへ適用し、途中の失敗はplan自身がpoisonする。
  if (boundary) plan.putIndex(boundary.tail, { ...boundary.tail, next: recordId });
  plan.putIndex(previous, added);
  plan.putIndex(current, { ...current, count: current.count + 1, head: current.head ?? recordId, tail: recordId });
 });
}
/** activeのみから除外する。allの履歴・one-shot IDを解放するAPIではない。 */
export function removeActiveApprovalList(plan: ApprovalMetadataPlan, listInput: ApprovalIndexList, recordId: string): void {
 return guarded(plan, () => {
  assertSynchronousResult(listInput);
  const current = manifest(plan, listInput);
  if (current.list.membership !== "active") throw new ApprovalMetadataPlanError();
  const boundary = ends(plan, current), removed = plan.readIndex({ kind: "link", list: current.list, record_id: recordId });
  if (removed === null || (removed.kind === "link" && !removed.member)) throw new MetadataConflictError();
  if (removed.kind !== "link" || boundary === null) throw new ApprovalMetadataPlanError();
  const previous = removed.previous === null ? null : link(plan, current.list, removed.previous);
  const next = removed.next === null ? null : link(plan, current.list, removed.next);
  if ((previous === null) !== (current.head === recordId) || (next === null) !== (current.tail === recordId)
    || (previous !== null && previous.next !== recordId) || (next !== null && next.previous !== recordId)
    || (current.count === 1 && (previous !== null || next !== null))
    || (current.count === 2 && previous !== null && next !== null)
    || (current.count > 3 && previous?.record_id === current.head && next?.record_id === current.tail)) throw new ApprovalMetadataPlanError();
  if (previous) plan.putIndex(previous, { ...previous, next: removed.next });
  if (next) plan.putIndex(next, { ...next, previous: removed.previous });
  plan.putIndex(removed, { ...removed, member: false, previous: null, next: null });
  plan.putIndex(current, { ...current, count: current.count - 1,
    head: previous === null ? removed.next : current.head, tail: next === null ? removed.previous : current.tail });
 });
}
/** 検証済み先頭から最大32件のみ。truncatedなら一覧全体の完了ではない。
 * 外部cursorやexpiry sweepの進捗保証をこのAPIで提供しない。 */
export function readApprovalListHead(plan: ApprovalMetadataPlan, list: ApprovalIndexList, limit: number) {
  return guarded(plan, () => {
    z.number().int().min(1).max(32).parse(limit);
    const current = manifest(plan, list); ends(plan, current);
    const ids: string[] = []; const seen = new Set<string>(); let next = current.head, previous: string | null = null;
    while (ids.length < Math.min(current.count, limit)) {
      if (next === null || seen.has(next)) throw new ApprovalMetadataPlanError();
      const value = link(plan, current.list, next);
      if (value.previous !== previous) throw new ApprovalMetadataPlanError();
      ids.push(value.record_id); seen.add(value.record_id); previous = value.record_id; next = value.next;
    }
    if (ids.length === current.count ? next !== null || previous !== current.tail
      : next === null || seen.has(next) || previous === current.tail) throw new ApprovalMetadataPlanError();
    if (ids.length < current.count) {
      const following = link(plan, current.list, next!);
      if (following.previous !== previous) throw new ApprovalMetadataPlanError();
    }
    return Object.freeze({ count: current.count, ids: Object.freeze(ids), truncated: ids.length < current.count });
  });
}
