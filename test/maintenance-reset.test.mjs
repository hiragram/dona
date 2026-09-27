import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
test('独立保守runnerの失敗・再開・世代分離契約', () => {
  execFileSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'test', '-p', 'maintenance_reset_test.py'], { stdio: 'pipe' });
});
