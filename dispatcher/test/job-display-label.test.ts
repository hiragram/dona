import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  createJobDisplayLabel,
  jobDisplayLabelFromWorkspace,
  jobDisplayLabelMaxCodePoints,
  jobWorkspaceLabel,
  normalizeJobDisplayName,
} from "../src/job-display-label.js";

describe("Herdr workspace表示ラベル", () => {
  test("NFC・空白・制御表現を正規化しIssue prefixを保持する", () => {
    const label = createJobDisplayLabel(
      { short_name: "  シ\u001b[31mコ\u001b[0m゙ブ\n\u202e 表示  ", issue: { repository: "OWNER/Repo", number: 87 } },
      { kind: "github", repository: "owner/repo" },
    );
    assert.equal(label, "#87 シゴブ 表示".normalize("NFC"));
  });

  test("emojiをsurrogate途中で分割せず48 code pointへ制限する", () => {
    const label = createJobDisplayLabel(
      { short_name: "😀".repeat(60), issue: { repository: "owner/repo", number: 87 } },
      { kind: "github", repository: "owner/repo" },
    )!;
    assert.equal(Array.from(label).length, jobDisplayLabelMaxCodePoints);
    assert.equal(label, `#87 ${"😀".repeat(44)}`);
  });

  test("境界長、日本語、引用符、shell metacharacterは表示値として維持する", () => {
    const shortName = `日本語 "引用" $(echo safe) ${"a".repeat(48)}`;
    const label = createJobDisplayLabel({ short_name: shortName }, { kind: "scratch" })!;
    assert.equal(label, Array.from(shortName).slice(0, 48).join(""));
    assert.equal(Array.from(label).length, 48);
  });

  test("空白、URL、private path、secret相当、Issue参照不一致をfallbackに送る", () => {
    for (const value of [
      " \n\u0000 ",
      "https://private.invalid/task",
      "ssh://git@internal.example/repo",
      "git://internal.example/private",
      "mailto:user@internal.example",
      "URL_mailto:user@internal.example",
      "urn:internal:project",
      "data:,private-host",
      "URL_www.internal.example",
      "/Users/example/private",
      "/workspace/dona/.env",
      "path:/Users/example/.env",
      "cwd=/workspace/dona",
      String.raw`path=C:\Users\example\secret.txt`,
      "../../.ssh/id_rsa",
      ".ssh/id_rsa",
      "secrets/id_rsa",
      String.raw`\\server\share\secret.txt`,
      String.raw`C:\Users\example\secret.txt`,
      "token=sk-example-secret",
      "GITHUB_TOKEN=abcdefghijklmnopqrstuv",
      "build_secret=abcdefghijklmnopqrstuv",
      "my_api_key=abcdefghijklmnopqrstuv",
      "SSH_PRIVATE_KEY=YWJjZGVmZ2hpamtsbW5vcA==",
      "private_key=abcdefghijklmnopqrstuvwxyz",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "build_ghp_abcdefghijklmnopqrstuvwxyz123456",
      ["xoxb", "123456789012", "abcdefghijklmnop"].join("-"),
      ["name_xoxb", "123456789012", "abcdefghijklmnop"].join("-"),
      ["sk", "abcdefghijklmnopqrstuvwxyz123456"].join("-"),
      "-----BEGIN PRIVATE KEY-----",
    ]) {
      assert.equal(normalizeJobDisplayName(value), undefined);
      assert.equal(createJobDisplayLabel({ short_name: value }, { kind: "scratch" }), undefined);
    }
    assert.equal(createJobDisplayLabel(
      { short_name: "安全な作業", issue: { repository: "other/repo", number: 87 } },
      { kind: "github", repository: "owner/repo" },
    ), undefined);
    assert.equal(createJobDisplayLabel(
      { short_name: "安全な作業", issue: { repository: "owner/repo", number: 87 } },
      { kind: "scratch" },
    ), undefined);
  });

  test("欠落・未知・破損metadataではagent nameを使う", () => {
    const agent = "job_01m30xcgz7sjs7w2rpzc29feat";
    assert.equal(jobWorkspaceLabel('{"kind":"scratch"}', agent), agent);
    assert.equal(jobWorkspaceLabel('{"kind":"scratch","unknown":{"future":true}}', agent), agent);
    assert.equal(jobWorkspaceLabel('{"kind":"scratch","__dona_job_display":{"label":"https://private.invalid"}}', agent), agent);
    assert.equal(jobWorkspaceLabel("not-json", agent), agent);
    assert.equal(jobDisplayLabelFromWorkspace({ __dona_job_display: { label: "安全な表示" } }), "安全な表示");
  });
});
