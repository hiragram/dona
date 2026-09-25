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

test("a near-limit link in a multi-line quote remains quoted", () => {
  const token = `<https://${"a".repeat(2_987)}|P>`;
  const blocks = expandedSections(`>>>intro\n${token}`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text === `>${token}`));
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
});

test("emoji aliases stay in one section", () => {
  const alias = ":white_check_mark:";
  const blocks = expandedSections(`${"a".repeat(2_895)}${alias}${"b".repeat(100)}`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text.includes(alias)));
});

test("an entity inside a long Slack link does not break the link", () => {
  const token = `<https://${"a".repeat(2_889)}&amp;tail|P>`;
  const blocks = expandedSections(`${token}end`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text.includes(token)));
});

test("a near-limit emoji alias inside emphasis is delivered", () => {
  const alias = `:${"a".repeat(2_997)}:`;
  const blocks = expandedSections(`*prefix\n${alias}tail*`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text === alias));
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
});

test("a fence-like sequence inside a Slack token does not split the token", () => {
  const token = `<https://${"a".repeat(2_889)}\`\`\`tail|P>`;
  const blocks = expandedSections(`${token}${"end".repeat(100)}`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text.includes(token)));
});

test("a near-limit grapheme falls back to a plain section when formatting exceeds the limit", () => {
  const grapheme = `a${"\u0301".repeat(2_998)}`;
  const blocks = expandedSections(`*prefix\n${grapheme}tail*`, "identity", true);
  assert.ok(blocks.some((block) => block.text.type === "plain_text" && block.text.text === grapheme));
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
});

test("an escaped near-limit link fits within a decorated inline section", () => {
  const token = `<https://${"a".repeat(2_986)}|P>`;
  const blocks = expandedSections(`*prefix\n\\${token}tail*`, "identity", true);
  assert.ok(blocks.some((block) => block.text.type === "mrkdwn" && block.text.text === `\\${token}`));
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
});

test("an escaped near-limit link keeps its quote prefix", () => {
  const token = `<https://${"a".repeat(2_986)}|P>`;
  const blocks = expandedSections(`>>>intro\n\\${token}`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text === `>\\${token}`));
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
});

test("a closing fence at the split boundary stays in the preceding section", () => {
  const blocks = expandedSections(`\`\`\`\n${"x".repeat(2_892)}\n\`\`\`\n${"y".repeat(100)}`, "identity", true);
  assert.ok(blocks[0]?.text.text.includes(`\n\`\`\``));
  assert.ok(blocks.every((block) => !block.text.text.startsWith("```\n```")));
});

test("asterisks surrounded by spaces do not become emphasis across sections", () => {
  const blocks = expandedSections(`2 * 3\n${"x".repeat(7_000)}\n4 * 5`, "identity", true);
  assert.ok(blocks.length > 1);
  assert.ok(blocks.slice(1).every((block) => !block.text.text.startsWith("*")));
});

test("a closing inline marker at the split boundary stays in the first section", () => {
  const blocks = expandedSections(`*${"a".repeat(2_899)}* ${"b".repeat(1_000)}`, "identity", true);
  assert.ok(blocks[0]?.text.text.endsWith("*"));
  assert.ok(blocks.slice(1).every((block) => !block.text.text.startsWith("**")));
});

test("a backtick in a Slack token does not hide a following multi-line quote", () => {
  const blocks = expandedSections(`<https://example.com/\`tick|P>\n>>>intro\n${"x".repeat(7_000)}`, "identity", true);
  assert.ok(blocks.slice(1).every((block) => block.text.text.startsWith(">>>")));
});

test("a backtick in a Slack token does not hide a following single-line quote", () => {
  const blocks = expandedSections(`<https://example.com/\`tick|P>\n>${"x".repeat(7_000)}`, "identity", true);
  assert.ok(blocks.slice(1).every((block) => block.text.text.startsWith(">")));
});

test("a closing inline-code marker at the split boundary stays in the first section", () => {
  const blocks = expandedSections(`\`${"a".repeat(2_899)}\` ${"b".repeat(1_000)}`, "identity", true);
  assert.ok(blocks[0]?.text.text.endsWith("`"));
  assert.ok(blocks.slice(1).every((block) => !block.text.text.startsWith("``")));
});

test("an existing multi-line quote marker is not duplicated after a split", () => {
  const blocks = expandedSections(`>>>intro\n${"a".repeat(2_890)}\n>>>second${"b".repeat(300)}`, "identity", true);
  assert.ok(blocks.length > 1);
  assert.ok(blocks.some((block) => block.text.text.startsWith(">>>second")));
  assert.ok(blocks.slice(1).every((block) => !block.text.text.startsWith(">>>>>>")));
});

test("a code line starting with quote characters keeps its outer quote", () => {
  const prefix = ">>>intro\n```\n";
  const padding = "x".repeat(2_895);
  const blocks = expandedSections(prefix + padding + "\n>>>code" + "y".repeat(300) + "\n```", "identity", true);
  assert.ok(blocks.length > 1);
  assert.ok(blocks.slice(1).some((block) => block.text.text.startsWith(">>>```\n>>>code")));
});

test("an escape and near-limit grapheme fall back together", () => {
  const grapheme = `a${"\u0301".repeat(2_998)}`;
  const blocks = expandedSections(`*prefix\n\\${grapheme}tail*`, "identity", true);
  assert.ok(blocks.some((block) => block.text.type === "plain_text" && block.text.text === `\\${grapheme}`));
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
});

test("an odd escape run and a near-limit link stay together", () => {
  const token = `<https://${"a".repeat(2_984)}|P>`;
  const escaped = `\\\\\\${token}`;
  const blocks = expandedSections(`*prefix\n${escaped}tail*`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text === escaped));
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
});

test("a fence-like sequence in an escaped Slack token does not change emphasis", () => {
  const blocks = expandedSections(`*\\<https://example.com/\`\`\`tail|PR>${"x".repeat(7_000)}*`, "identity", true);
  assert.ok(blocks.slice(1).every((block) => block.text.text.startsWith("*")));
});

test("an unmatched backtick does not allow a Slack link to split", () => {
  const token = "<https://example.com|PR>";
  const blocks = expandedSections(`\`typo${"x".repeat(2_880)}${token}${"y".repeat(2_000)}`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text.includes(token)));
});

test("a split code fence does not insert an extra blank line", () => {
  const blocks = expandedSections("```\n" + "x\n".repeat(4_000) + "```", "identity", true);
  assert.ok(blocks.length > 1);
  assert.ok(blocks.slice(0, -1).every((block) => !block.text.text.endsWith("\n\n```")));
});

test("an unmatched backtick does not hide a multi-line quote", () => {
  const blocks = expandedSections("`typo\n>>>intro\n" + "x".repeat(7_000), "identity", true);
  assert.ok(blocks.slice(1).every((block) => block.text.text.startsWith(">>>")));
});

test("consecutive closing inline markers stay in the preceding section", () => {
  const blocks = expandedSections(`*_${"a".repeat(2_898)}_* ${"b".repeat(1_000)}`, "identity", true);
  assert.ok(blocks[0]?.text.text.endsWith("_*"));
  assert.ok(blocks.slice(1).every((block) => !block.text.text.startsWith("**")));
});

test("an unmatched backtick does not hide the end of emphasis", () => {
  const blocks = expandedSections(`*bold \`typo ${"x".repeat(7_000)}*`, "identity", true);
  assert.ok(blocks.slice(1).every((block) => block.text.text.startsWith("*")));
});

test("underscores inside Japanese words do not create inline formatting", () => {
  const blocks = expandedSections(`日本_語${"x".repeat(7_000)}末_尾`, "identity", true);
  assert.ok(blocks.slice(1).every((block) => !block.text.text.startsWith("_")));
});

test("dense unmatched markers do not stall section splitting", () => {
  const input = "*_~` x ".repeat(1_500).slice(0, 12_000);
  const start = performance.now();
  const blocks = expandedSections(input, "identity", true);
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
  assert.ok(performance.now() - start < 2_000);
});

test("comparison signs on separate lines do not hide a code fence", () => {
  const blocks = expandedSections("value < threshold\n```\n" + "x".repeat(7_000) + "\n```\nvalue > threshold", "identity", true);
  assert.ok(blocks.length > 1);
  assert.ok(blocks.filter((block) => block.text.text.includes("x")).every((block) => block.text.text.includes("```")));
});

test("a near-limit link followed by nested closing markers is delivered", () => {
  const token = `<https://${"a".repeat(2_985)}|P>`;
  const blocks = expandedSections(`*_${token}_*tail${"x".repeat(100)}`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text === token));
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
});

test("comparison signs on separate lines do not hide an emphasis close", () => {
  const blocks = expandedSections(`*bold < threshold\n${"x".repeat(7_000)}*\nvalue > threshold`, "identity", true);
  assert.ok(blocks.slice(1, -1).every((block) => block.text.text.startsWith("*")));
});

test("a near-limit emoji alias followed by nested closing markers is delivered", () => {
  const alias = `:${"a".repeat(2_995)}:`;
  const blocks = expandedSections(`*_${alias}_*tail${"x".repeat(100)}`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text === alias));
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
});

test("a comparison sign is not treated as a long Slack token", () => {
  const blocks = expandedSections(`*bold < threshold ${"x".repeat(7_000)}* > threshold`, "identity", true);
  assert.ok(blocks.slice(1, -1).every((block) => block.text.text.startsWith("*")));
});

test("an escaped near-limit link followed by nested closers is delivered", () => {
  const token = `<https://${"a".repeat(2_982)}|P>`;
  const escaped = `\\\\\\${token}`;
  const blocks = expandedSections(`*_${escaped}_*tail${"x".repeat(100)}`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text === escaped));
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
});

test("an existing quote marker precedes reopened inline formatting", () => {
  const blocks = expandedSections(`>>>*intro\n${"a".repeat(2_890)}\n>>>second${"b".repeat(300)}*`, "identity", true);
  assert.ok(blocks.slice(1).some((block) => block.text.text.startsWith(">>>*second")));
});

test("an underscore inside an emoji alias does not create emphasis", () => {
  const blocks = expandedSections(`:foo-_bar:${"x".repeat(7_000)}_`, "identity", true);
  assert.ok(blocks.slice(1).every((block) => !block.text.text.startsWith("_")));
});

test("three escapes and one long grapheme fit in a plain section", () => {
  const grapheme = `a${"\u0301".repeat(2_996)}`;
  const escaped = `\\\\\\${grapheme}`;
  const blocks = expandedSections(`*prefix\n${escaped}tail*`, "identity", true);
  assert.ok(blocks.some((block) => block.text.type === "plain_text" && block.text.text === escaped));
});

test("a long comparison expression keeps its emphasis", () => {
  const blocks = expandedSections(`*prefix\n< threshold ${"x".repeat(2_985)} >tail*`, "identity", true);
  assert.ok(blocks.every((block) => block.text.text.length <= 3_000));
  assert.ok(blocks.slice(1).some((block) => block.text.text.startsWith("*")));
});

test("a Slack link label with spaces and a marker remains a token", () => {
  const token = "<https://example.com|PR *draft version>";
  const blocks = expandedSections(`${token}${"x".repeat(7_000)}*`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text.includes(token)));
  assert.ok(blocks.slice(1).every((block) => !block.text.text.startsWith("*")));
});

test("a long grapheme followed by an inline closer falls back to plain text", () => {
  const grapheme = `a${"\u0301".repeat(2_998)}`;
  const blocks = expandedSections(`*prefix\n${grapheme}*tail`, "identity", true);
  assert.ok(blocks.some((block) => block.text.type === "plain_text" && block.text.text === grapheme));
  assert.ok(blocks.every((block) => block.text.text.length > 0 && block.text.text.length <= 3_000));
});

test("a maximum-length token followed by the final inline closer has no empty section", () => {
  const token = `<https://${"a".repeat(2_988)}|P>`;
  const blocks = expandedSections(`*prefix\n${token}*`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text === token));
  assert.ok(blocks.every((block) => block.text.text.length > 0 && block.text.text.length <= 3_000));
});

test("a prefixed escaped near-limit link starts its own section", () => {
  const token = `<https://${"a".repeat(2_985)}|P>`;
  const escaped = `\\${token}`;
  const blocks = expandedSections(`*x${escaped}*`, "identity", true);
  assert.ok(blocks.some((block) => block.text.text.includes(escaped)));
  assert.ok(blocks.every((block) => block.text.text.length > 0 && block.text.text.length <= 3_000));
});

test("a long grapheme enclosed by inline markers falls back to plain text", () => {
  const grapheme = `a${"\u0301".repeat(2_998)}`;
  const blocks = expandedSections(`*${grapheme}*`, "identity", true);
  assert.ok(blocks.some((block) => block.text.type === "plain_text" && block.text.text === grapheme));
  assert.ok(blocks.every((block) => block.text.text.length > 0 && block.text.text.length <= 3_000));
});

test("a long grapheme enclosed by inline code falls back to plain text", () => {
  const grapheme = `a${"\u0301".repeat(2_998)}`;
  const blocks = expandedSections(`\`${grapheme}\``, "identity", true);
  assert.ok(blocks.some((block) => block.text.type === "plain_text" && block.text.text === grapheme));
  assert.ok(blocks.every((block) => block.text.text.length > 0 && block.text.text.length <= 3_000));
});
