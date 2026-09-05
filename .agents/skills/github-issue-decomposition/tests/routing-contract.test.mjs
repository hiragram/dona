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
