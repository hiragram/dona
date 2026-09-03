import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = resolve(repositoryRoot, ".agents/skills/code-submission-review-cycle");

async function read(relativePath) {
  return readFile(resolve(repositoryRoot, relativePath), "utf8");
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "SKILL.mdにYAML frontmatterが必要です");

  return Object.fromEntries(
    match[1].split("\n").map((line) => {
      const separator = line.indexOf(":");
      assert.notEqual(separator, -1, `frontmatter fieldを解釈できません: ${line}`);
      const key = line.slice(0, separator).trim();
      const rawValue = line.slice(separator + 1).trim();
      return [key, rawValue.replace(/^(["'])(.*)\1$/, "$2")];
    }),
  );
}

function parseMappingYaml(source) {
  const root = {};
  const stack = [{ indent: -1, value: root }];

  for (const [index, rawLine] of source.split("\n").entries()) {
    if (/^\s*(?:#|$)/.test(rawLine)) continue;
    const match = rawLine.match(/^(\s*)([A-Za-z_][\w-]*):(?:\s+(.*))?$/);
    assert.ok(match, `openai.yaml ${index + 1}行目をmappingとして解釈できません`);
    const indent = match[1].length;
    assert.equal(indent % 2, 0, "openai.yamlのindentは2 spaces単位にします");

    while (stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1).value;
    const rawValue = match[3];
    let value;
    if (rawValue === undefined) {
      value = {};
    } else if (rawValue === "true" || rawValue === "false") {
      value = rawValue === "true";
    } else {
      assert.match(rawValue, /^"(?:[^"\\]|\\.)*"$/, "string valueはdouble quoteで囲みます");
      value = JSON.parse(rawValue);
    }
    parent[match[2]] = value;
    if (rawValue === undefined) stack.push({ indent, value });
  }

  return root;
}

function section(markdown, heading) {
  const headings = [...markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)];
  const startIndex = headings.findIndex((candidate) => candidate[2] === heading);
  assert.notEqual(startIndex, -1, `必須sectionがありません: ${heading}`);
  const current = headings[startIndex];
  const next = headings.slice(startIndex + 1).find((candidate) => candidate[1].length <= current[1].length);
  return markdown.slice(current.index, next?.index ?? markdown.length);
}

function assertContract(source, label, patterns) {
  for (const pattern of patterns) {
    assert.match(source, pattern, `${label}のcontractが不足しています: ${pattern}`);
  }
}

test("implicit invocation metadataとrouting boundaryが整合する", async () => {
  const [skill, openaiYaml] = await Promise.all([
    read(".agents/skills/code-submission-review-cycle/SKILL.md"),
    read(".agents/skills/code-submission-review-cycle/agents/openai.yaml"),
  ]);
  const frontmatter = parseFrontmatter(skill);
  const metadata = parseMappingYaml(openaiYaml);

  assert.equal(frontmatter.name, "code-submission-review-cycle");
  assert.equal(metadata.policy?.allow_implicit_invocation, true);
  assert.match(metadata.interface?.default_prompt ?? "", /\$code-submission-review-cycle/);
  assert.ok((metadata.interface?.short_description?.length ?? 0) >= 25);
  assert.ok((metadata.interface?.short_description?.length ?? 0) <= 64);

  assertContract(frontmatter.description, "implicit routing", [
    /コード実装.*修正.*refactor.*test変更/,
    /commit.*push.*Pull Request/,
    /read-only.*Issue作成だけ.*one-off review/,
  ]);
});

test("AGENTS.mdがコード提出だけをmandatory routingにする", async () => {
  const agents = await read("AGENTS.md");
  const routing = section(agents, "コード提出のreview cycle");

  assertContract(routing, "mandatory routing", [
    /コード実装.*commit.*push.*Pull Request.*\$code-submission-review-cycle.*必ず使/,
    /read-only.*Issue作成だけ.*one-off review.*適用しない/,
    /merge.*force push.*無関係な変更.*許可されたと解釈しない/,
  ]);
});

test("review referenceがexact triggerをSHAと全poll sourceへ結び付ける", async () => {
  const [skill, reviewRound] = await Promise.all([
    read(".agents/skills/code-submission-review-cycle/SKILL.md"),
    read(".agents/skills/code-submission-review-cycle/references/review-round.md"),
  ]);
  const target = section(skill, "review targetを固定する");
  const boundary = section(skill, "安全境界");
  const record = section(reviewRound, "round recordを作る");
  const polling = section(reviewRound, "30〜60秒間隔で全sourceをpollする");

  const link = target.match(/\[[^\]]+\]\((references\/[^)]+)\)/)?.[1];
  assert.equal(link, "references/review-round.md");
  assert.equal(resolve(skillRoot, link), resolve(skillRoot, "references/review-round.md"));
  assertContract(record, "exact trigger/SHA binding", [
    /exact `@codex review`.*1件/,
    /comment ID.*URL.*GitHub server時刻/,
    /Pull Request head SHA.*selected base ref.*current SHA.*対象diffを固定/,
    /^- `target_sha`$/m,
    /^- `base_ref`$/m,
    /^- `base_sha`$/m,
    /reconcile中にheadが変わった場合.*triggerを受理せず停止/,
    /投稿前.*既存trigger.*pagination.*reaction一覧.*pagination/,
    /latest trigger.*`eyes`.*terminal review\/completion.*reactionも空.*pending.*新規投稿せず.*poll/,
    /current SHA.*exact triggerへ一意.*引き継ぐ.*複数候補.*30分.*停止/,
    /全Codex inline comments.*direct replies.*pagination.*未返信.*元threadへdirect reply/,
    /未返信を残したままfresh triggerを投稿しない/,
  ]);
  assertContract(polling, "poll source", [
    /issue comments.*exact `@codex review`.*trigger一覧.*pagination/,
    /recordのtriggerより新しいexact trigger.*round競合.*停止/,
    /exact trigger commentのreaction一覧endpoint.*pagination/,
    /reactionごとの`user`/,
    /Codex integration.*actor.*`\+1`だけ.*clean/,
    /Pull Request review/,
    /issue comment/,
    /inline review comment/,
    /current head SHA.*status check.*check run/,
    /Pull Request association.*head\/base SHA.*tested merge commit.*GitHub API evidence/,
    /base driftより前のrun.*current CIに数えず/,
  ]);
  assertContract(boundary, "round identity", [
    /exact head SHA.*selected base ref\/SHA.*結び付け/,
    /古いround.*別SHA.*無視/,
  ]);
});

test("stalled roundはduplicate triggerなしで停止する", async () => {
  const reviewRound = await read(".agents/skills/code-submission-review-cycle/references/review-round.md");
  const polling = section(reviewRound, "30〜60秒間隔で全sourceをpollする");
  const decision = section(reviewRound, "round結果を判定する");

  assertContract(polling, "stalled no-duplicate", [
    /eyes.*duplicate `@codex review`.*投稿しない/,
    /CI check\/status contextの`status`.*`conclusion`/,
    /`queued`から`in_progress`.*state change/,
    /30分.*stalled.*停止/,
    /自動retriggerしない/,
    /空reaction.*完了ではない/,
  ]);
  assertContract(decision, "empty state is not clean", [
    /superseded.*旧roundをclean扱いせず/,
    /findings.*`eyes`消失.*terminal review\/completion.*feedback処理やhead変更を始めない/,
    /terminal後.*reviews.*inline comments.*pagination.*全finding集合を固定/,
  ]);
});

test("feedback後は各inline threadへdirect replyしてからfresh roundへ進む", async () => {
  const reviewRound = await read(".agents/skills/code-submission-review-cycle/references/review-round.md");
  const feedback = section(reviewRound, "feedbackを処理する");

  assertContract(feedback, "inline direct reply", [
    /file変更が生じた場合だけ.*commit.*push/,
    /file変更がない場合.*空commitやpushを行わず.*current SHA一致/,
    /修正をpushした後.*file変更なし.*Codex inline comment全件/,
    /comments\/\{comment_id\}\/replies.*direct inline reply/,
    /short commit hash.*変更方針.*検証/,
    /対応しない.*具体的.*根拠/,
    /全inline comment.*direct reply.*fresh `@codex review`/,
    /一般Pull Request comment.*代用にしない/,
  ]);
});

test("SKILL.mdが全completion gateと禁止事項を保持する", async () => {
  const skill = await read(".agents/skills/code-submission-review-cycle/SKILL.md");
  const completion = section(skill, "完了条件");
  const boundary = section(skill, "routingと権限境界");
  const target = section(skill, "review targetを固定する");

  assertContract(completion, "completion gates", [
    /latest round.*current Pull Request head SHA.*current base ref\/SHA/,
    /\+1.*no-major-issues\/no-findings/,
    /未解決finding.*過去round.*inline comment.*direct reply済み/,
    /local `HEAD`.*upstream.*Pull Request head SHA.*一致/,
    /mergeable.*base conflict.*open.*non-draft/,
    /期待するCI suite\/check context.*少なくとも1回観測.*required\/current CI.*terminal success/,
    /checkが空.*成功としない/,
    /current head\/base pair.*GitHub API evidence/,
    /base driftより前のrun.*成功としない/,
  ]);
  assertContract(boundary, "authorization boundary", [
    /Pull Request自体のmerge.*force push.*rebase.*無関係なcleanup.*許可しない/,
    /latest selected base.*task branchへmerge.*手順に限って許可/,
    /task fileだけ.*明示stage/,
    /stash.*破棄.*上書き.*しない/,
  ]);
  assertContract(target, "conflict workflow", [
    /指定したbaseを優先.*指定がない場合だけdefault branch/,
    /current branch.*selected base自身でない.*task commit.*直接pushしない/,
    /working treeがclean.*新しいcommit.*空commitを作らない/,
    /既存task commit.*再利用/,
    /未commit diffの有無にかかわらず.*selected base.*全commit.*全diff.*branch全体.*task.*review対応/,
    /無関係なcommit.*pushせず停止/,
    /upstream未設定.*同名remote refが存在しない.*non-force.*初回push.*upstreamを設定/,
    /upstream設定済み.*remote\/ref.*task branch自身.*selected baseではない/,
    /explicit refspec.*forceなし.*bare `git push`/,
    /local task commit.*upstreamより先行.*fast-forward.*forceなし.*localとupstreamが既に一致.*不要なpushをしない/,
    /同じhead\/selected base.*open Pull Request.*重複/,
    /matching Pull Requestが存在しない.*selected base向けnon-draft/,
    /closed\/mergedだけ.*current head.*selected baseとの差分.*新規Pull Request作成.*過去PRを変更せず/,
    /既存open Pull Requestがdraft.*重複作成せず.*許可.*ready.*確認できなければ.*停止/,
    /latest selected baseをmerge/,
    /rebase.*force push.*ours.*theirs.*stash.*破棄.*禁止/,
  ]);
});
