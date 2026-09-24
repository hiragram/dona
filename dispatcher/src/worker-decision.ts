import { createHash } from "node:crypto";

export type WorkerDecisionAction = "ack_internal" | "aggregate_wait" | "report_to_user" | "ask_user";
export type WorkerDecisionKind = "checkpoint" | "question" | "risk" | "decision_request";
export type WorkerJobStatus = "queued" | "retryable_failed" | "preparing" | "running" | "blocked" | "cancelling" | "completed" | "failed" | "cancelled" | "needs_review";

export interface WorkerDecisionReport {
  message_id: string;
  job_id: string;
  kind: WorkerDecisionKind;
  sequence: number;
  accepted_at: string;
  text: string;
  severity?: "low" | "medium" | "high";
  eta_at?: string;
  options?: string[];
}

export interface WorkerDecisionSibling {
  job_id: string;
  status: WorkerJobStatus;
}

export interface WorkerDecisionContext {
  report: WorkerDecisionReport;
  siblings: WorkerDecisionSibling[];
  total_jobs: number;
  previous?: { action: WorkerDecisionAction; content_sha256: string; severity?: string; eta_at?: string; decided_at: string };
  last_user_receipt_at?: string;
  now: string;
  silence_interval_ms: number;
}

export interface WorkerDecision {
  action: WorkerDecisionAction;
  reason: "terminal" | "group_attention" | "question" | "decision_request" | "risk_escalation" |
    "risk" | "eta_change" | "silence" | "duplicate" | "heartbeat" | "changed" | "group_wait";
  content_sha256: string;
  safe_projection?: { kind: "question" | "decision_request"; prompt: string; options?: string[] };
}

const terminal = new Set<WorkerJobStatus>(["completed", "failed", "cancelled", "needs_review"]);
const unsafe = /(?:\b(?:https?|file):\/\/\S+|(?:^|\s)(?:~\/|\/[^\s]+|[A-Za-z]:\\[^\s]+)|\b(?:token|secret|password|api[_-]?key)\b|```|\$\(|\b(?:curl|bash|sh|sudo|rm)\b)/i;

function safeQuestion(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 240 && !unsafe.test(trimmed) ? trimmed : undefined;
}

export function evaluateWorkerDecision(context: WorkerDecisionContext): WorkerDecision {
  const { report, siblings, previous } = context;
  const content_sha256 = createHash("sha256").update(JSON.stringify([report.kind, report.text, report.severity ?? null, report.options ?? null, report.eta_at ?? null])).digest("hex");
  const current = siblings.find(sibling => sibling.job_id === report.job_id);
  if (!current || terminal.has(current.status) || current.status === "cancelling")
    return { action: "ack_internal", reason: "terminal", content_sha256 };
  if (context.total_jobs > siblings.length)
    return { action: "aggregate_wait", reason: "group_wait", content_sha256 };
  if (siblings.some(sibling => sibling.status === "failed" || sibling.status === "needs_review"))
    return { action: "aggregate_wait", reason: "group_attention", content_sha256 };
  if (previous?.content_sha256 === content_sha256)
    return { action: "ack_internal", reason: "duplicate", content_sha256 };
  if (report.kind === "question" || report.kind === "decision_request") {
    const prompt = safeQuestion(report.text);
    const options = report.options?.map(safeQuestion);
    if (!prompt || (options && options.some(option => !option)))
      return { action: "aggregate_wait", reason: "group_wait", content_sha256 };
    return { action: "ask_user", reason: report.kind,
      content_sha256, safe_projection: { kind: report.kind, prompt, ...(options ? { options: options as string[] } : {}) } };
  }
  if (report.kind === "risk" && report.severity === "high")
    return { action: "report_to_user", reason: "risk_escalation", content_sha256 };
  if (report.kind === "risk" && previous?.severity !== report.severity)
    return { action: "report_to_user", reason: "risk", content_sha256 };
  if (report.eta_at && previous?.eta_at && Math.abs(Date.parse(report.eta_at)-Date.parse(previous.eta_at)) >= 300_000)
    return { action: "report_to_user", reason: "eta_change", content_sha256 };
  const elapsed = Date.parse(context.now) - Date.parse(context.last_user_receipt_at ?? previous?.decided_at ?? report.accepted_at);
  if (Number.isFinite(elapsed) && elapsed >= context.silence_interval_ms)
    return { action: "report_to_user", reason: "silence", content_sha256 };
  if (context.total_jobs > 1) return { action: "aggregate_wait", reason: "group_wait", content_sha256 };
  if (report.kind === "checkpoint" && previous?.action === "report_to_user")
    return { action: "ack_internal", reason: "heartbeat", content_sha256 };
  return { action: "ack_internal", reason: "heartbeat", content_sha256 };
}
