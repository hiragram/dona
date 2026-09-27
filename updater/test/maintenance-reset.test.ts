import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
test('独立保守runnerがDonaと同じSQLiteで停止後DBとlive WALをbackupする', () => {
  execFileSync('python3', ['-B', fileURLToPath(new URL('../../test/maintenance_database_integration.py', import.meta.url)),
    process.execPath, require.resolve('better-sqlite3')], { stdio: 'pipe', timeout: 30_000 });
});
