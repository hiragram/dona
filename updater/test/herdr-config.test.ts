import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "smol-toml";
import { herdrNoResumeConfig } from "../src/herdr-config.js";

test("Herdr設定の有効なTOML表現を正規化し自動復元だけを無効にする", () => {
  for (const source of [
    '[ui]\nmouse=true\n',
    '[session]\nresume_agents_on_restore=true\n[ui]\nmouse=true\n',
    '["session"]\n"resume_agents_on_restore"=true\n[ui]\nmouse=true\n',
    'session.resume_agents_on_restore=true\nsession.restore_on_startup=true\n',
    'session={resume_agents_on_restore=true, restore_on_startup=true}\n',
    '"session"."resume_agents_on_restore"=true\n',
    'text="""\n[session]\nresume_agents_on_restore=true\n"""\n',
    '[[keys]]\naction="next"\nkeys=["a", "b"]\n',
    '',
  ]) {
    const expected = parse(source);
    expected.session = Object.assign(Object.create(null), expected.session ?? {}, { resume_agents_on_restore: false });
    const result = herdrNoResumeConfig(source);
    assert.deepEqual(parse(result), expected);
    assert.equal(herdrNoResumeConfig(result), result);
  }
});

test("不正なHerdr session設定は準備中に拒否する", () => {
  for (const source of ['session=true', 'session=[]', 'session=2026-10-01', '[session]\n[session]']) {
    assert.throws(() => herdrNoResumeConfig(source));
  }
});
