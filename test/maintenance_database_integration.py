"""DonaのNode SQLiteと独立runnerのread / backupを実WALで検証する。"""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile

spec = importlib.util.spec_from_file_location('maintenance', Path(__file__).parents[1]/'scripts/maintenance/reset_upgrade.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
node, module = sys.argv[1:]
database = m.NodeDatabase(node, module)
with tempfile.TemporaryDirectory() as d:
    source, backup = Path(d)/'source.sqlite3', Path(d)/'backup.sqlite3'
    script = f'''import Database from {json.dumps(Path(module).as_uri())};
const db=new Database(process.argv[1]);db.pragma('journal_mode=WAL');db.exec('create table t(x); insert into t values(1)');db.close();'''
    subprocess.run([node,'--input-type=module','-e',script,str(source)],check=True,capture_output=True)
    assert database.read(source,'select x from t') == [(1,)]
    # 生きたwriterの未checkpoint WALもbackupへ含める。
    writer = f'''import Database from {json.dumps(Path(module).as_uri())};
const db=new Database(process.argv[1]);db.pragma('wal_autocheckpoint=0');db.exec('insert into t values(2)');console.log('ready');setInterval(()=>{{}},1000);'''
    process = subprocess.Popen([node,'--input-type=module','-e',writer,str(source)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        assert process.stdout.readline().strip() == 'ready'
        database.backup(source,backup)
        assert database.read(backup,'select x from t order by x') == [(1,),(2,)]
        assert database.read(source,'select count(*) from t') == [(2,)]
        assert database.read(backup,'pragma integrity_check') == [('ok',)]
    finally:
        process.terminate();process.wait(timeout=5)
print('Node SQLite read-only / WAL backup: passed')
