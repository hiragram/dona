import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.resolve(testDirectory, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(skillDirectory, relativePath), "utf8");
}

function section(markdown, heading) {
  const headings = [...markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)];
  const startIndex = headings.findIndex((candidate) => candidate[2] === heading);
  assert.notEqual(startIndex, -1, `必須sectionがありません: ${heading}`);
  const current = headings[startIndex];
  const next = headings
    .slice(startIndex + 1)
    .find((candidate) => candidate[1].length <= current[1].length);
  return markdown.slice(current.index, next?.index ?? markdown.length);
}

function assertContract(source, label, patterns) {
  for (const pattern of patterns) {
    assert.match(source, pattern, `${label}のcontractが不足しています: ${pattern}`);
  }
}

test("完全integration routeだけがDraft PRと親epic labelを必須にする", () => {
  const skill = read("SKILL.md");
  const mode = section(skill, "modeを選ぶ");
  const design = section(skill, "判定したrouteを設計する");
  const writes = section(skill, "許可されたwriteを準備・実行する");
  const issueContract = read("references/issue-contract.md");

  assertContract(mode, "integration routing", [
    /構造化Issue route.*Issue作成.*feature branch.*integration PR作成.*すべて明示的/,
    /親Epic.*exact `epic` label.*integration PRをDraft/,
    /Issue作成だけ.*branchやPRの作成を推測しない/,
    /単一Issue route.*branchやPRのwrite.*親子integration workflowへroutingせず/,
    /branch\/PR操作を黙って未処理にもしない.*最初のwrite前/,
    /別のcode submission workflow.*`epic` labelやDraft状態を推測しない/,
  ]);
  assertContract(design, "integration-only epic label", [
    /完全なintegration workflowでだけ.*親Epic.*exact `epic` label.*必須/,
    /単一Issue route.*Issue-onlyの構造化route.*自動適用しない/,
  ]);
  assertContract(writes, "explicit label boundary", [
    /既存のexact `epic` labelを加算/,
    /個別に依頼されていないmetadataを変更しない/,
    /存在しないlabelを自動作成しない/,
  ]);
  assertContract(issueContract, "non-integration behavior", [
    /親Epicだけに既存のexact `epic` label/,
    /単一Issue route.*Issue-onlyの構造化route.*子Issue.*自動付与しない/,
  ]);
});

test("integration resourceはepic親からDraft PRとnative graphの順に作る", () => {
  const workflow = read("references/integration-feature-workflow.md");
  const plan = section(workflow, "実行前に固定するplan");
  const order = section(workflow, "必須の実行順序");
  const parent = section(workflow, "1. 親Epic Issueを作成する");

  assertContract(plan, "epic label preflight", [
    /labelをpaginationして再取得.*exact `epic`.*一意/,
    /label作成を許可しない/,
    /最初のwrite前に停止して確認/,
    /他のlabel.*明示的に依頼されたものだけ/,
    /integration PRの必須状態がDraft.*plan/,
    /readyまたはnon-draft.*最初のwrite前に停止して確認/,
    /親Issueやbranchを先に作成してから.*衝突を発見しない/,
  ]);
  assert.match(
    order,
    /`親Epic Issue（epic label） -> feature branch -> 空commit -> Draft integration PR -> 子Issue -> integration PR closing relationship reconcile -> native graph`/,
  );
  assertContract(parent, "parent identity and additive label", [
    /作成requestの`labels`.*exact `epic`.*明示的に依頼されたlabelだけ/,
    /Issue番号、REST `id`、URL、title、authorと一致/,
    /native parentが存在しないroot Issue/,
    /POST \/repos\/\{owner\}\/\{repo\}\/issues\/\{issue_number\}\/labels.*`\{"labels":\["epic"\]\}`/,
    /label writeが曖昧.*再実行せず.*再取得したlabel集合/,
    /parent_issue_number.*parent_issue_rest_id.*parent_issue_url/,
  ]);
});

test("Draft integration PRを固定した親Epicへ一意に対応付ける", () => {
  const workflow = read("references/integration-feature-workflow.md");
  const pullRequest = section(workflow, "3. 標準templateからDraft integration PRを作成する");
  const recovery = section(workflow, "partial failureと安全な再開");

  assertContract(pullRequest, "Draft PR creation", [
    /open\/closed\/merged.*同じhead\/base.*再取得/,
    /open Draft PRを1件だけ.*execution contextへ採用/,
    /PR create requestを送らず再取得検証/,
    /既存PRを採用しない新規作成時だけ/,
    /PR create request.*`draft: true`.*Draft PRを作成/,
    /`gh pr create`.*`--draft`/,
    /`Closes #<親Issue番号>`.*1件だけ/,
    /他Issueをtargetにするclosing keywordを含めない/,
    /ready化やmergeを自動実行しない/,
  ]);
  assertContract(pullRequest, "parent and PR identity", [
    /base repository\/ref.*head repository\/ref.*`draft: true`.*head SHA/,
    /active closing keywordが1件だけ.*parent_issue_number/,
    /`closingIssuesReferences`をpagination.*完全な集合.*親Issue1件だけ/,
    /repository.*Issue番号.*`fullDatabaseId`.*URL.*REST `id`/,
    /`fullDatabaseId`とREST `id`.*10進文字列.*比較/,
    /親Epicがroot.*exact `epic` label/,
    /全state.*author.*作成時刻帯.*Draft状態.*head SHA.*blind retryしない/,
    /一意に確定できなければ停止/,
    /integration_pr_head_sha.*integration_pr_origin.*`created`または`resumed`/,
    /integration_pr_origin.*immutableなexecution context/,
  ]);
  assertContract(recovery, "ambiguous PR reconciliation", [
    /同じhead\/baseのPRを全stateから再取得/,
    /open、Draft、parent closing target.*一意/,
  ]);
});

test("最終passは親label・PR対応とnative topologyを一緒に再検証する", () => {
  const skill = read("SKILL.md");
  const graph = read("references/native-issue-graph.md");
  const reporting = section(read("references/integration-feature-workflow.md"), "最終検証・報告");

  assertContract(skill, "top-level verification", [
    /parentの完全な`sub_issues`一覧.*各childの`parent`/,
    /親Epicがroot Issue.*exact `epic` label.*Draft integration PRの親closing target/,
    /closing target全体が親Epicとintegration完了対象childだけ/,
    /blocked Issueの`blocked_by`.*blockerの`blocking`/,
  ]);
  assertContract(graph, "native topology verification", [
    /親Epicだけが既存のexact `epic` label.*他のlabelが意図せず変更されていない/,
    /Epic自身にnative parentがないroot Issue/,
    /Draft integration PRのpagination済み`closingIssuesReferences`.*Issue番号・REST `id`・URL.*一意/,
    /集合全体が親Epicとintegration完了対象childだけ/,
    /完全な`sub_issues`集合.*各childの`parent`/,
    /`blocked_by`.*`blocking`.*完全な有向edge集合/,
  ]);
  assertContract(reporting, "reported evidence", [
    /Issue番号・REST `id`・URL・root状態・exact `epic` label/,
    /Draft状態・head SHA・exact `Closes #<親Issue番号>`.*`closingIssuesReferences`.*親Epicとintegration完了対象child/,
    /両方向で検証したnative parent topology.*最小blocker edge.*parallel lane/,
  ]);
});
