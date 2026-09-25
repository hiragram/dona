import assert from "node:assert/strict";
import test from "node:test";
import { expandedSections } from "../src/slack-api.js";

test("long code fences remain valid in every section", () => {
  const blocks = expandedSections(`\`\`\`\n${"x".repeat(7_000)}\n\`\`\``, "identity", true);
  assert.ok(blocks.length > 1);
  assert.equal(blocks[0]?.block_id, "identity");
  for (const block of blocks) {
    assert.ok(block.text.text.length <= 3_000);
    assert.equal((block.text.text.match(/```/g) ?? []).length % 2, 0);
    assert.equal(block.expand, true);
  }
});

test("a link at a split boundary stays in one section and malformed surrogate advances", () => {
  const blocks = expandedSections(`${"a".repeat(2_989)}\ud800<https://example.com|PR>`, "identity", true);
  assert.ok(blocks.length >= 2);
  assert.ok(blocks.some((block) => block.text.text.includes("<https://example.com|PR>")));
  assert.ok(blocks.every((block) => block.text.text.length > 0 && block.text.text.length <= 3_000));
});

test("long inline code and emphasis remain balanced across sections", () => {
  for (const marker of ["`", "*", "_", "~"]) {
    const blocks = expandedSections(`${marker}${"x".repeat(7_000)}${marker}`, "identity", true);
    assert.ok(blocks.length > 1);
    for (const block of blocks) {
      assert.ok(block.text.text.length <= 3_000);
      assert.ok(block.text.text.startsWith(marker));
      assert.ok(block.text.text.endsWith(marker));
    }
  }
});

test("a final section preserves unmatched inline markers", () => {
  for (const value of ["job_idを確認", "*確認", "`未完了"]) {
    const blocks = expandedSections(value, "identity", true);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.text.text, value);
  }
});

test("ordinary identifiers do not gain formatting across sections", () => {
  const text = `job_id ${"x".repeat(7_000)}`;
  const blocks = expandedSections(text, "identity", true);
  assert.ok(blocks.length > 1);
  assert.equal(blocks.map((block) => block.text.text).join(""), text);
});

test("combined inline and fence continuation stays within the section limit", () => {
  const blocks = expandedSections(`*強調 _斜体 ~取消 \`code\`~_*\n\`\`\`\n${"x".repeat(9_000)}\n\`\`\``, "identity", true);
  assert.ok(blocks.length > 2);
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));

  const unmatched = expandedSections(`job_id ~x\n\`\`\`\n${"x".repeat(9_000)}\n\`\`\``, "identity", true);
  assert.ok(unmatched.every((block) => block.text.text.length <= 3_000));
});

test("a link opener straddling the split stays intact", () => {
  const link = "<https://example.com|PR>";
  const blocks = expandedSections(`${"a".repeat(2_979)}${link}`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text.includes(link)));
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
});

test("a marker inside a code fence does not close an earlier unmatched marker", () => {
  const text = `*未閉鎖 ${"a".repeat(3_000)}\n\`\`\`\n*\n${"b".repeat(3_000)}\n\`\`\``;
  const blocks = expandedSections(text, "identity", true);
  assert.ok(blocks.length > 1);
  assert.equal(blocks[0]?.text.text, text.slice(0, blocks[0]?.text.text.length));
});

test("a fence opener straddling the split stays intact", () => {
  const blocks = expandedSections(`${"a".repeat(2_978)}\`\`\`\n${"x".repeat(6_000)}\n\`\`\``, "identity", true);
  assert.ok(blocks.length > 1);
  assert.ok(blocks.some((block) => block.text.text.includes("```\n")));
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
  assert.ok(blocks.every((block) => (block.text.text.match(/```/g) ?? []).length % 2 === 0));
});

test("an escape and its marker stay in the same section", () => {
  const blocks = expandedSections(`${"a".repeat(2_979)}\\*literal*`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text.includes("\\*literal*")));
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
});

test("Slack angle tokens stay in one section", () => {
  for (const token of ["<@U123>", "<#C123>", "<!date^123^{date_short}|today>"]) {
    const blocks = expandedSections(`${"a".repeat(2_979)}${token}`, "identity", true);
    assert.ok(blocks.some((block) => block.text.text.includes(token)));
  }
});

test("an escaped fence stays literal at a section boundary", () => {
  const blocks = expandedSections(`${"a".repeat(100)}\\\`\`\`literal\n${"x".repeat(6_000)}`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text.includes("\\```literal")));
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
});

test("inline delimiters are not synthesized inside a continued fence", () => {
  const blocks = expandedSections(`*説明\n\`\`\`\n${"x".repeat(6_000)}\n\`\`\`\n続き*`, "identity", true);
  const logBlocks = blocks.flatMap((block) => [...block.text.text.matchAll(/```([\s\S]*?)```/g)].map((match) => match[1] ?? ""));
  assert.ok(logBlocks.length > 1);
  assert.ok(logBlocks.every((content) => !content.includes("*")));
  const finalBlock = blocks.at(-1)?.text.text ?? "";
  assert.ok(finalBlock.includes("```*\n続き*"));
});

test("grapheme clusters stay in one section", () => {
  for (const cluster of ["👨‍👩‍👧‍👦", "は\u3099"]) {
    const blocks = expandedSections(`${"a".repeat(2_899)}${cluster}`, "identity", true);
    assert.ok(blocks.some((block) => block.text.text.includes(cluster)));
    assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
  }
});

test("many short fences stay below the decorated section limit", () => {
  const blocks = expandedSections(`*${"```\n```\n".repeat(400)}*`, "identity", true);
  assert.ok(blocks.length > 1);
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
});

test("underscore inside an emphasized identifier does not close emphasis", () => {
  const blocks = expandedSections(`_job_id ${"x".repeat(6_000)}_`, "identity", true);
  assert.ok(blocks.length > 1);
  assert.ok(blocks.every((block) => block.text.text.startsWith("_")));
  assert.ok(blocks.every((block) => block.text.text.endsWith("_")));
});

test("a long grapheme under Slack's limit stays intact", () => {
  const cluster = `a${"\u0301".repeat(2_949)}`;
  const blocks = expandedSections(`${cluster}b`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text.includes(cluster)));
  assert.equal(blocks.map((block) => block.text.text).join(""), `${cluster}b`);
});

test("grapheme adjustment keeps a preceding escape with its target", () => {
  const blocks = expandedSections(`${"a".repeat(2_898)}\\*\u0301literal*`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text.includes("\\*\u0301literal*")));
});

test("a long grapheme after an inline marker stays together", () => {
  const content = `\`a${"\u0301".repeat(2_949)}\``;
  const blocks = expandedSections(content, "identity", true);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.text.text, content);
});

test("a Slack token beginning a chunk remains intact", () => {
  const token = `<https://${"a".repeat(2_935)}|PR>`;
  const blocks = expandedSections(`${"x".repeat(100)}${token}`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text.includes(token)));
});

test("blockquote continues across sections of one long line", () => {
  const blocks = expandedSections(`>${"x".repeat(7_000)}`, "identity", true);
  assert.ok(blocks.length > 1);
  assert.ok(blocks.every((block) => block.text.text.startsWith(">")));
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
});

test("a near-limit Slack token is delivered despite surrounding inline markers", () => {
  const token = `<https://${"a".repeat(2_987)}|P>`;
  const blocks = expandedSections(`*prefix\n${token}tail*`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text === token));
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
});

test("multi-line blockquote continues in later sections", () => {
  const blocks = expandedSections(`>>>見出し\n${"x".repeat(3_000)}\n${"y".repeat(3_000)}`, "identity", true);
  assert.ok(blocks.length > 1);
  assert.ok(blocks.slice(1).every((block) => block.text.text.startsWith(">>>")));
});

test("code fence content does not start a multi-line quote", () => {
  const blocks = expandedSections(`\`\`\`\n>>> Python出力\n\`\`\`\n${"x".repeat(6_000)}`, "identity", true);
  assert.ok(blocks.length > 1);
  assert.ok(blocks.slice(1).every((block) => !block.text.text.startsWith(">>>")));
});

test("a closing fence in a continued chunk does not create an empty block", () => {
  const blocks = expandedSections(`\`\`\`\n${"x".repeat(4_000)}\n\`\`\`\n${"結論".repeat(2_000)}`, "identity", true);
  assert.ok(blocks.length > 2);
  assert.ok(blocks.every((block) => !block.text.text.startsWith("```\n```")));
});

test("a long angle string inside a fence keeps code formatting", () => {
  const blocks = expandedSections(`\`\`\`\n<${"x".repeat(2_993)}>\n\`\`\``, "identity", true);
  assert.ok(blocks.length > 1);
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
  assert.ok(blocks.every((block) => block.text.text.includes("```")));
});

test("Slack entities stay in one section", () => {
  for (const entity of ["&amp;", "&lt;", "&gt;"]) {
    const blocks = expandedSections(`${"a".repeat(2_898)}${entity}`, "identity", true);
    assert.ok(blocks.some((block) => block.text.text.includes(entity)));
  }
});

test("a long angle string inside inline code stays literal", () => {
  const blocks = expandedSections(`\`<https://${"a".repeat(2_987)}|P>\``, "identity", true);
  assert.ok(blocks.length > 1);
  assert.ok(blocks.every((block) => block.text.text.startsWith("`") && block.text.text.endsWith("`")));
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
});

test("multi-line quote continues through a split code fence", () => {
  const blocks = expandedSections(`>>>intro\n\`\`\`\n${"x".repeat(7_000)}\n\`\`\`\nend`, "identity", true);
  assert.ok(blocks.length > 1);
  assert.ok(blocks.slice(1).every((block) => block.text.text.startsWith(">>>")));
});

test("an escaped long angle token stays with its preceding slash", () => {
  const token = `<https://${"a".repeat(2_888)}|P>`;
  const blocks = expandedSections(`\\${token}${"tail".repeat(100)}`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text.includes(`\\${token}`)));
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
});

test("a greater-than sign inside code does not continue a quote", () => {
  const blocks = expandedSections(`\`\`\`\n>${"x".repeat(7_000)}\n\`\`\``, "identity", true);
  assert.ok(blocks.length > 1);
  assert.ok(blocks.slice(1).every((block) => !block.text.text.startsWith(">")));

  const inline = expandedSections(`\`\n>${"x".repeat(7_000)}\n\``, "identity", true);
  assert.ok(inline.slice(1).every((block) => !block.text.text.startsWith(">")));
});
