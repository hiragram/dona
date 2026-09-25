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
