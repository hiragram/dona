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
    /^- `default_branch_ref`$/m,
    /^- `body_sha256`$/m,
    /^- `closing_issues_sha256`$/m,
    /^- `template_base_sha`$/m,
    /raw本文.*`closingIssuesReferences`全page.*標準template.*closing relationship.*Issue完了条件.*検証/,
    /canonical list.*SHA-256 hash.*body\/closing identity.*固定/,
    /reconcile中にhead、base、body hash.*変わった場合.*triggerを受理せず停止/,
    /投稿前.*既存trigger.*pagination.*reaction一覧.*pagination/,
    /latest trigger.*`eyes`.*terminal review\/completion.*reactionも空.*pending.*新規投稿せず.*poll/,
    /保存済みround record.*`target_sha`.*`base_ref`.*`base_sha`.*`default_branch_ref`.*`body_sha256`.*`closing_issues_sha256`.*`template_base_sha`.*すべて復元.*current head\/base\/default-branch\/body\/closing identity.*一致.*場合だけ/,
    /current SHAだけ.*Codex-authored artifact.*body\/closing identityを復元できない.*旧roundを引き継がない/,
    /recordがなく.*pending.*duplicate triggerを投稿せず停止.*terminal artifact.*current identityのcleanに使わず.*fresh round/,
    /複数候補.*別identity.*対応不明.*30分.*停止/,
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
    /repository default branch ref/,
    /raw本文.*body hash/,
    /`closingIssuesReferences`全page.*closing relationship hash/,
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
    /CI check runの`status`\/`conclusion`.*commit status contextの`state`/,
    /`queued`から`in_progress`.*state change/,
    /`pending`から`success`.*state change/,
    /30分.*stalled.*停止/,
    /自動retriggerしない/,
    /空reaction.*完了ではない/,
  ]);
  assertContract(decision, "empty state is not clean", [
    /clean.*current head\/base\/default-branch\/body\/closing hash.*round recordのidentity/,
    /superseded.*head SHA.*base ref.*base SHA.*repository default branch ref.*body hash.*closing relationship hash.*旧roundをclean扱いしない/,
    /base ref\/SHA.*default branch ref.*変わった.*新しいexact base SHA.*標準templateを再取得.*automatic closing reference条件.*再評価.*reconcile.*再取得.*検証/,
    /body hash.*closing relationship hash.*変わった.*current template.*Issue完了条件.*reconcile/,
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

test("PR本文はcurrent baseの標準template全欄を反映して再取得検証する", async () => {
  const skill = await read(".agents/skills/code-submission-review-cycle/SKILL.md");
  const template = section(skill, "標準Pull Request templateを反映する");
  const boundary = section(skill, "安全境界");
  const completion = section(skill, "完了条件");

  assertContract(template, "standard PR template", [
    /作成・本文更新.*\.github\/PULL_REQUEST_TEMPLATE\.md.*必ず使う/,
    /selected baseのexact SHA.*取得元のbase ref\/SHA.*記録/,
    /local checkout.*過去に保存したtemplate.*代用しない/,
    /存在しない.*取得できない.*空.*構造を安全に解釈できない.*PRを作成・更新せず.*review trigger.*停止/,
    /コメント.*全見出し.*各欄の目的.*見出しと順序を維持/,
    /`完了する Issue`.*selected base.*default branch.*Issue全体が完了.*場合だけ.*`Closes #xx`/,
    /cross-repository Issue.*対象を変えない`Closes OWNER\/REPOSITORY#xx`/,
    /non-default base.*部分対応.*単なる関連.*Issue不明.*曖昧.*automatic closing referenceを使用せず.*`Closes #xx`.*残さない/,
    /`close`.*`closes`.*`closed`.*`fix`.*`fixes`.*`fixed`.*`resolve`.*`resolves`.*`resolved`.*大文字小文字.*colon.*検査/,
    /Issue全体の完了を証明できないIssue reference.*残さない.*keywordだけ.*`Closes`.*same-repository.*cross-repository.*参照対象を保持/,
    /`https:\/\/github\.com\/OWNER\/REPOSITORY\/issues\/xx`.*完全URL.*検出/,
    /完全URL.*repositoryとIssue番号を失わず.*current repository.*`#xx`.*別repository.*`OWNER\/REPOSITORY#xx`.*正規化/,
    /`変更内容の概要・方針`.*実際の変更.*実装方針・判断/,
    /`テストのカバー範囲`.*未カバー.*未検証の境界/,
    /`動作確認方法`.*実際に実行.*再現可能.*未実行.*実行済みとして記載しない/,
    /Issueに既にある背景、要件、受け入れ条件.*不必要に複製せず.*Issueへの参照/,
    /current templateの全必須欄.*意味的に記入済み.*未解決placeholder.*含まず/,
    /全automatic closing keyword.*same-repository.*cross-repository.*完全URL.*Issue reference.*検査.*許可・正規化.*以外を残さない/,
    /既存Pull Request.*`closingIssuesReferences`.*全page取得.*canonical list.*SHA-256 hash/,
    /keyword由来.*Development欄.*manual link.*default branch.*Issue全体を完了.*検証/,
    /許可できない.*paginationが不完全.*自動unlinkせず.*本文write.*review.*停止/,
    /新規Pull Request.*local `HEAD`.*upstream.*remote head ref\/SHA.*selected base ref\/SHA.*repository default branch ref.*template取得元のbase SHA.*template blob\/hash.*snapshot/,
    /作成write直前.*current値.*同じhead\/base.*open\/closed\/merged Pull Request.*再取得/,
    /identity.*snapshot.*比較/,
    /古いdiffまたはtemplate.*PRを作成せず.*最新identity.*本文生成と検証をやり直す/,
    /matching open Pull Request.*重複作成せず.*current本文.*既存PR手順.*reconcile/,
    /closed\/merged Pull Request.*review targetを固定する.*再作成境界.*複数候補.*状態が曖昧.*停止/,
    /既存Pull Request.*current本文を再取得.*raw本文のhash.*closing relationship canonical hash.*local `HEAD`.*upstream.*remote head ref\/SHA.*base ref\/SHA.*repository default branch ref.*template取得元のbase SHA.*template blob\/hash.*snapshot.*人間が追記.*保持.*最小限reconcile/,
    /write直前.*もう一度取得.*snapshot.*変化.*古いsnapshot.*書き込まず.*最新のdiff.*exact base SHA.*template.*reconcileをやり直す/,
    /競合.*一意に判断できない.*上書きせず.*停止/,
    /作成・更新後.*Pull Request.*`closingIssuesReferences`全page.*再取得.*実際の本文.*closing relationship.*head\/base\/state/,
    /既存PRがdraft.*検証成功後だけready.*再取得.*non-draft.*identity不変/,
    /write結果が曖昧.*blind retryせず.*本文.*更新時刻.*head\/base.*照合/,
    /追加push.*変更概要.*test範囲.*動作確認.*fresh roundの前.*更新・再取得・検証/,
    /selected base ref\/SHA.*repository default branch ref.*closing relationship canonical hash.*変わった.*新しいexact base SHA.*template.*必ず再取得.*automatic closing reference.*再評価.*reconcile.*再取得.*検証/,
  ]);
  assertContract(boundary, "template review gate", [
    /templateの取得.*意味的反映.*再取得検証.*review roundを開始しない/,
    /外部writeが曖昧.*既存本文と競合.*blind retry.*しない/,
  ]);
  assertContract(completion, "template completion gate", [
    /current baseの標準`.github\/PULL_REQUEST_TEMPLATE\.md`の全欄を反映/,
    /Issue情報を不必要に重複せず/,
    /default branch向け.*Issue全体の完了を証明できないautomatic closing reference.*未解決placeholder.*含まない/,
    /許可したIssue close.*対象repositoryを保持.*`Closes #xx`.*`Closes OWNER\/REPOSITORY#xx`/,
    /全commit message.*automatic closing referenceがない/,
    /current `closingIssuesReferences`全page.*各closing relationship.*default branch.*Issue全体の完了.*確認済み/,
  ]);
});

test("SKILL.mdが全completion gateと禁止事項を保持する", async () => {
  const skill = await read(".agents/skills/code-submission-review-cycle/SKILL.md");
  const completion = section(skill, "完了条件");
  const boundary = section(skill, "routingと権限境界");
  const target = section(skill, "review targetを固定する");

  assertContract(completion, "completion gates", [
    /latest round.*current Pull Request head SHA.*current base ref\/SHA.*current repository default branch ref.*current PR body hash.*current closing relationship canonical hash/,
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
    /未commit diffの有無にかかわらず.*selected base.*全commit.*全commit message.*全diff.*branch全体.*task.*review対応/,
    /全commit message.*automatic closing keyword.*same-repository.*cross-repository.*完全URL.*Issue reference.*検査/,
    /task\/review commit.*automatic closing referenceを入れず.*PR本文へ集約/,
    /既存commit message.*automatic closing reference.*push・reviewを始めず停止.*rebase.*amend.*force push.*履歴を書き換えない/,
    /無関係なcommit.*pushせず停止/,
    /upstream未設定.*同名remote refが存在しない.*non-force.*初回push.*upstreamを設定/,
    /upstream設定済み.*remote\/ref.*task branch自身.*selected baseではない/,
    /explicit refspec.*forceなし.*bare `git push`/,
    /local task commit.*upstreamより先行.*fast-forward.*forceなし.*localとupstreamが既に一致.*不要なpushをしない/,
    /同じhead\/selected base.*open Pull Request.*重複/,
    /matching Pull Requestが存在しない.*selected base向けnon-draft/,
    /closed\/mergedだけ.*current head.*selected baseとの差分.*新規Pull Request作成.*過去PRを変更せず/,
    /既存open Pull Requestがdraft.*重複作成せず.*draftのままtemplate手順.*本文.*closing relationship.*検証.*後だけready/,
    /ready化を許可.*確認できなければ.*外部write前に停止/,
    /latest selected baseをmerge/,
    /rebase.*force push.*ours.*theirs.*stash.*破棄.*禁止/,
  ]);
});
