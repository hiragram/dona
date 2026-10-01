import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
test('停止更新の失敗・再開・実プロセス停止を検証する', () => {
  execFileSync('python3', ['-B','-m','unittest','discover','-s','test','-p','offline_update_test.py'], {stdio:'pipe',timeout:60000});
});
