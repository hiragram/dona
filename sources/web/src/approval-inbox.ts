import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const utc = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const safeText = z.string().min(1).max(240).refine(value =>
  !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u.test(value));

/** Display data from a verified approval repository, never the action payload. */
export const approvalInboxItemSchema = z.strictObject({
  request_id: id, requester: safeText, risk: z.enum(["elevated", "critical"]),
  operation_summary: safeText, exact_target: safeText, display_fingerprint: hash, created_at: utc, expires_at: utc,
  revision, state: z.enum(["pending", "approved", "rejected", "expired", "needs_review"]),
}).refine(item => Date.parse(item.created_at) < Date.parse(item.expires_at));
export type ApprovalInboxItem = z.infer<typeof approvalInboxItemSchema>;
export const approvalInboxSchema = z.strictObject({ codec_version: z.literal(1), items: z.array(approvalInboxItemSchema).max(50) });

/** The browser confirms only a candidate. The authority must reread durable state. */
export const approvalDecisionCandidateSchema = z.strictObject({
  codec_version: z.literal(1), request_id: id, decision: z.enum(["approve", "reject"]),
  expected_revision: revision, expected_display_fingerprint: hash,
});
export type ApprovalDecisionCandidate = z.infer<typeof approvalDecisionCandidateSchema>;
export const approvalAuthorityEvidenceSchema = z.strictObject({
  principal_id: id, instance_id: id, tenant_id: id, binding_revision: revision,
  role: z.literal("supervisor"), step_up_verified: z.literal(true), csrf_verified: z.literal(true),
  request_id: id, display_fingerprint: hash, persisted_action_hash: hash, presentation_action_hash: hash, revision, expires_at: utc,
  state: z.literal("pending"), consumed: z.literal(false),
});
export type ApprovalAuthorityEvidence = z.infer<typeof approvalAuthorityEvidenceSchema>;

export class ApprovalInboxUnavailable extends Error {
  constructor() { super("approval_inbox_unavailable"); this.name = "ApprovalInboxUnavailable"; }
}

/** This is a preflight boundary, not an approval grant or a decision writer.
 * Evidence must be computed by a server authority from the current principal,
 * protected clock and persisted request in the decision transaction. */
export function assertApprovalDecisionCandidate(candidateInput: unknown, evidenceInput: unknown,
  expectedScope: { principal_id: string; instance_id: string; tenant_id: string; binding_revision: number }, now: string): ApprovalDecisionCandidate {
  try {
    const candidate = approvalDecisionCandidateSchema.parse(candidateInput);
    const evidence = approvalAuthorityEvidenceSchema.parse(evidenceInput);
    const scope = z.strictObject({ principal_id: id, instance_id: id, tenant_id: id, binding_revision: revision }).parse(expectedScope);
    const at = utc.parse(now);
    const requested = Buffer.from(candidate.expected_display_fingerprint, "hex");
    const current = Buffer.from(evidence.display_fingerprint, "hex");
    const action = Buffer.from(evidence.persisted_action_hash, "hex");
    const presented = Buffer.from(evidence.presentation_action_hash, "hex");
    if (evidence.principal_id !== scope.principal_id || evidence.instance_id !== scope.instance_id
      || evidence.tenant_id !== scope.tenant_id || evidence.binding_revision !== scope.binding_revision
      || candidate.request_id !== evidence.request_id || candidate.expected_revision !== evidence.revision
      || !timingSafeEqual(requested, current) || !timingSafeEqual(action, presented) || Date.parse(at) >= Date.parse(evidence.expires_at)) throw Error();
    return candidate;
  } catch { throw new ApprovalInboxUnavailable(); }
}

export interface ApprovalInboxAuthority {
  /** Authenticated server-side repository read with current binding and visibility. */
  list(): Promise<unknown>;
  detail(requestId: string): Promise<unknown>;
}

/** No default authority or decision transport exists while Epic #26 is incomplete. */
export class ApprovalInboxAdapter {
  constructor(private readonly authority?: ApprovalInboxAuthority) {}
  async list(): Promise<ApprovalInboxItem[]> {
    if (!this.authority) throw new ApprovalInboxUnavailable();
    try { return approvalInboxSchema.parse(await this.authority.list()).items; }
    catch { throw new ApprovalInboxUnavailable(); }
  }
  async detail(requestId: string): Promise<ApprovalInboxItem> {
    if (!this.authority) throw new ApprovalInboxUnavailable();
    try {
      const item = approvalInboxItemSchema.parse(await this.authority.detail(id.parse(requestId)));
      if (item.request_id !== requestId) throw Error();
      return item;
    } catch { throw new ApprovalInboxUnavailable(); }
  }
}

/** Text-only view model for list, detail, and the human confirmation screen. */
export function approvalInboxView(itemInput: unknown, now: string) {
  try {
    const item = approvalInboxItemSchema.parse(itemInput);
    const at = utc.parse(now);
    const canConfirm = item.state === "pending" && Date.parse(at) < Date.parse(item.expires_at);
    return Object.freeze({
      title: item.operation_summary, exactTarget: item.exact_target, requester: item.requester, risk: item.risk,
      displayFingerprint: item.display_fingerprint, createdAt: item.created_at, expiresAt: item.expires_at,
      status: canConfirm ? "確認可能" : "再確認が必要", canConfirm,
      candidate: canConfirm ? Object.freeze({codec_version: 1 as const, request_id: item.request_id,
        expected_revision: item.revision, expected_display_fingerprint: item.display_fingerprint}) : null,
    });
  } catch { throw new ApprovalInboxUnavailable(); }
}

const html = (value: string) => value.replace(/[&<>"']/g, char =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** Inert list/detail/confirm markup. The decision ceremony is deliberately
 * absent until the durable Web presentation and WebAuthn receipt API exist. */
export function renderApprovalInboxPreview(input: unknown, selectedId: string | null, now: string): string {
  try {
    const items = approvalInboxSchema.parse(input).items;
    const selected = selectedId === null ? null : items.find(item => item.request_id === id.parse(selectedId));
    if (selectedId !== null && !selected) throw Error();
    const rows = items.map(item => {
      const view = approvalInboxView(item, now);
      return `<li><span>${html(view.title)}</span><span>${html(view.requester)}</span><span>${html(view.status)}</span></li>`;
    }).join("");
    const detail = selected === null ? "" : (() => {
      const view = approvalInboxView(selected, now);
      return `<section aria-labelledby="approval-detail-title"><h2 id="approval-detail-title">承認内容の確認</h2>`
        + `<dl><dt>操作</dt><dd>${html(view.title)}</dd><dt>対象</dt><dd>${html(view.exactTarget)}</dd>`
        + `<dt>依頼者</dt><dd>${html(view.requester)}</dd><dt>リスク</dt><dd>${html(view.risk)}</dd>`
        + `<dt>表示用指紋</dt><dd>${html(view.displayFingerprint)}</dd><dt>作成</dt><dd>${html(view.createdAt)}</dd>`
        + `<dt>期限</dt><dd>${html(view.expiresAt)}</dd></dl><p>決定操作は準備中です。表示用指紋だけでは承認されません。</p>`
        + `<button type="button" disabled>承認</button><button type="button" disabled>却下</button></section>`;
    })();
    return `<section aria-labelledby="approval-list-title"><h1 id="approval-list-title">承認待ち</h1><ul>${rows}</ul></section>${detail}`;
  } catch { throw new ApprovalInboxUnavailable(); }
}
