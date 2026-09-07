import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(testDirectory, "..");

const structuredSignals = [
  "multiple_independent_review_test_responsibilities",
  "multiple_ownership_boundaries",
  "parallel_lanes",
  "multiple_pr_deliverables",
  "distinct_failure_recovery_contracts",
  "independent_migration_or_rollout",
];

function classifyScope(facts) {
  if (structuredSignals.some((key) => facts[key] === true)) {
    return "structured_issue_set";
  }
  if (
    facts.one_cohesive_outcome === true &&
    facts.one_primary_responsibility === true &&
    facts.standalone_review_and_test === true
  ) {
    return "single_issue";
  }
  return "needs_clarification";
}

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return markdownFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith(".md") ? [entryPath] : [];
  });
}

test("代表caseはscopeの事実でroutingされ、希望Issue数では上書きされない", () => {
  const fixturePath = path.join(testDirectory, "fixtures", "routing-cases.json");
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  assert.equal(fixture.schema_version, 1);
  assert.deepEqual(
    fixture.cases.map((entry) => entry.id),
    [
      "small-single-bug",
      "issue-46-multi-job-theme",
      "one-issue-wording-does-not-collapse-scope",
    ],
  );

  for (const entry of fixture.cases) {
    assert.equal(classifyScope(entry.facts), entry.expected_route, entry.id);
    const changedHint = entry.requested_issue_count === 1 ? 9 : 1;
    assert.equal(classifyScope(entry.facts), entry.expected_route, `${entry.id}:${changedHint}`);
  }
});

test("frontmatterとUI metadataは全Issue依頼のimplicit routingを維持する", () => {
  const skill = fs.readFileSync(path.join(skillDirectory, "SKILL.md"), "utf8");
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter, "SKILL.md frontmatter is required");
  const description = frontmatter[1].match(/^description:\s*["']?(.+?)["']?$/m)?.[1] ?? "";
  assert.match(description, /GitHub Issue/);
  assert.match(description, /作成/);
  assert.match(description, /更新/);
  assert.match(skill, /references\/scope-routing\.md/);
  assert.match(skill, /references\/issue-contract\.md/);

  const metadata = fs.readFileSync(path.join(skillDirectory, "agents", "openai.yaml"), "utf8");
  assert.match(metadata, /^\s*allow_implicit_invocation:\s*true\s*$/m);
  assert.match(metadata, /\$github-issue-decomposition/);
});

test("code submission由来の残タスクIssueは明示権限と両linkを要求する", () => {
  const skill = fs.readFileSync(path.join(skillDirectory, "SKILL.md"), "utf8");
  assert.match(skill, /code submission workflow.*残タスクIssue.*同じscope判定/);
  assert.match(skill, /元Issueと当該PRから残ったtask.*日本語/);
  assert.match(skill, /元Issueと当該PRの両方.*link/);
  assert.match(skill, /Markdown linkでnative graphを置き換えず/);
  assert.match(skill, /Issue作成を明示的に許可した場合だけ.*create-or-update/);
  assert.match(skill, /PR提出権限からIssue作成権限を推測しない/);
});

test("Skill内のrelative Markdown linkはすべて解決できる", () => {
  for (const markdownPath of markdownFiles(skillDirectory)) {
    const markdown = fs.readFileSync(markdownPath, "utf8");
    for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (/^(?:https?:|#)/.test(target)) continue;
      const fileTarget = target.split("#", 1)[0];
      assert.ok(
        fs.existsSync(path.resolve(path.dirname(markdownPath), fileTarget)),
        `${path.relative(skillDirectory, markdownPath)} -> ${target}`,
      );
    }
  }
});

test("integration childは実際のmerge先とIssue完了点を明示する", () => {
  const skill = fs.readFileSync(path.join(skillDirectory, "SKILL.md"), "utf8");
  const issueContract = fs.readFileSync(
    path.join(skillDirectory, "references", "issue-contract.md"),
    "utf8",
  );
  const integrationWorkflow = fs.readFileSync(
    path.join(skillDirectory, "references", "integration-feature-workflow.md"),
    "utf8",
  );

  assert.match(issueContract, /Issue全体の完了点.*実装PRを上記feature branchへmergeした時点.*integration PRをdefault branchへmergeした時点/);
  assert.match(issueContract, /前者.*child単独のacceptanceとtest.*feature branch上で完結.*実装PRで`Closes #<child>`を使用できる/);
  assert.match(issueContract, /non-default branch向けkeyword.*自動closeを保証しない.*実装PRをmergeするauthenticated identity.*base\/head\/merge commit.*手動close.*`state`.*`closedAt`.*close event/);
  assert.match(issueContract, /authenticated identity.*`close_owner`.*`viewerCanClose: true`.*permission.*false・unknown・別identity.*`Closes`を使用しない/);
  assert.match(issueContract, /後者.*child実装PR.*部分対応.*`Closes`を使用せず.*integration PR本文.*`Closes #<child>`.*`closingIssuesReferences`/);
  assert.match(issueContract, /branch名.*integration PR link.*base指定.*non-default PR本文のkeywordだけを完了点やIssue closeの証拠にしない/);

  assert.match(integrationWorkflow, /childごとにIssue全体の完了点.*feature branchへの実装PR merge.*default branchへのintegration PR merge/);
  assert.match(integrationWorkflow, /`close_owner`.*`post_merge_close_action`.*`state`.*`closedAt`.*close event/);
  assert.match(integrationWorkflow, /authenticated identity.*`close_owner`.*`viewerCanClose: true`.*permission.*false・unknown・別identity/);
  assert.match(integrationWorkflow, /`child_completion_point`.*close mechanism.*Issue番号.*execution context/);
  assert.match(integrationWorkflow, /標準templateからDraft integration PRを作成する/);
  assert.match(integrationWorkflow, /PR作成前.*current default branchのexact SHA.*標準`.github\/PULL_REQUEST_TEMPLATE.md`.*全見出し.*順序.*未解決placeholder/s);
  assert.match(integrationWorkflow, /再取得.*raw title\/body.*標準templateの全見出し.*exactly 1件の`Closes #<親Issue番号>`/s);
  assert.match(skill, /integration PR -> 子Issue -> integration PR closing relationship reconcile -> native graph/);
  assert.match(integrationWorkflow, /integration PRのchild closing relationshipをreconcileする/);
  assert.match(integrationWorkflow, /execution contextだけから対象集合を決めず.*全childのcurrent contract.*再取得/);
  assert.match(integrationWorkflow, /feature-merge完了として除外するchildを含む全child.*raw title\/body hash.*current `child_completion_point`.*close mechanism/s);
  assert.match(integrationWorkflow, /全childのcurrent contractからintegration完了対象集合を再計算.*immutable execution context.*1件でも変更.*write前に停止/s);
  assert.match(integrationWorkflow, /current default branchのexact SHA.*標準`.github\/PULL_REQUEST_TEMPLATE.md`.*`完了する Issue`.*`Closes #<child>`/s);
  assert.match(integrationWorkflow, /write直前.*PR、親Issue、全childのsnapshot.*対象集合をもう一度再計算.*差分.*古いbodyを送信せず停止/s);
  assert.match(integrationWorkflow, /更新後.*全childのidentity.*current `child_completion_point`.*close mechanism.*snapshotと対象集合が不変/s);
  assert.match(integrationWorkflow, /blind retry.*`closingIssuesReferences`全page/s);
  assert.match(integrationWorkflow, /親Issueとintegration完了対象child.*exactly 1件.*feature-merge完了child.*存在しない/s);
  assert.match(integrationWorkflow, /全child Issue.*merge-target branch.*integration PR link.*`child_completion_point`.*`Closes`可否.*`close_owner`/);
});
