import { createHash } from "node:crypto";

export interface DefinitionFingerprintInput {
  recurrence_json: string;
  policy_json: string;
  action: string;
  target_json: string;
  content_hash: string;
}

export function definitionFingerprint(input: DefinitionFingerprintInput): string {
  return createHash("sha256").update([
    input.recurrence_json, input.policy_json, input.action, input.target_json, input.content_hash,
  ].join("\0")).digest("hex");
}
