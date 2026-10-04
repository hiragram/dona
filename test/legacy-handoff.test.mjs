import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
test('旧成果の引継ぎは停止証拠・Issue identity・成果の変更を照合する', () => {
  execFileSync('python3', ['-B','-m','unittest','discover','-s','test','-p','legacy_handoff_test.py'], {stdio:'pipe',timeout:60000});
});
