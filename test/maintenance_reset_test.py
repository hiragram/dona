"""本番launchd/Slackへ接続せず、実file・SQLiteとservice adapterで検証。"""
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('maintenance', Path(__file__).parents[1]/'scripts/maintenance/reset_upgrade.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
REAL_HEALTH = m.Runner.health


class Services:
    def __init__(self):
        self.registered = set(m.LABELS)
        self.calls = []
        self.stop_failure = False

    def observe(self, label):
        return {'pid': None} if label in self.registered else None

    def stop(self, label):
        self.calls.append(('stop', label))
        if self.stop_failure:
            raise RuntimeError('injected_stop_failure')
        self.registered.discard(label)

    def start(self, label, plist):
        self.calls.append(('start', label))
        assert plistlib.loads(plist.read_bytes())['Label'] == label
        self.registered.add(label)


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name).resolve()
        self.home_patch = patch.object(m.Path, 'home', return_value=self.home)
        self.home_patch.start()
        self.run = m.private_dir(self.home/'maintenance')
        self.old = m.private_dir(self.home/'old')
        self.g = m.private_dir(self.home/'new')
        m.private_dir(self.home/'Library/LaunchAgents')
        m.private_dir(self.run/'plists')
        (self.old/'current').symlink_to(self.old/'release')
        (self.old/'release').mkdir()
        self.db = self.old/'dona.sqlite3'
        with sqlite3.connect(self.db) as db:
            db.executescript("CREATE TABLE events(event_id TEXT,status TEXT); CREATE TABLE jobs(job_id TEXT,source_event_id TEXT,status TEXT,completion_event_id TEXT); INSERT INTO events VALUES('event','completed'),('notification','completed'); INSERT INTO jobs VALUES('job','event','completed','notification');")
        self.plists = {label: {'Label': label, 'ProgramArguments': ['node', '/old/'+label], 'EnvironmentVariables': {}} for label in m.LABELS}
        self.files = {}
        for label, plist in self.plists.items():
            f = self.home/'Library/LaunchAgents'/ (label+'.plist')
            f.write_bytes(plistlib.dumps(plist))
            self.files[str(f)] = m.digest(f.read_bytes())
            m.atomic(self.run/'plists'/f.name, plistlib.dumps(dict(plist, ProgramArguments=['node', '/new/'+label])))
        inv = {'files': self.files, 'policy': {'current_pointer': str(self.old/'current')}, 'old_pointer': str(self.old/'release'),
               'plists': self.plists, 'databases': [str(self.db)], 'old_results': [str(self.old/'results')]}
        m.atomic(self.run/'inventory.json', m.encode(inv))
        m.atomic(self.run/'runner.py', Path(m.__file__).read_bytes())
        plan = {'runner_sha256': m.digest((self.run/'runner.py').read_bytes()), 'generation': str(self.g), 'target_sha': 'a'*40, 'event_id': 'event', 'job_id': 'job',
                'inventory_sha256': m.digest((self.run/'inventory.json').read_bytes()),
                'generation_seal': m.tree_seal(self.g), 'plists_seal': m.tree_seal(self.run/'plists')}
        m.atomic(self.run/'plan.json', m.encode(plan))
        plan_hash = m.digest((self.run/'plan.json').read_bytes())
        m.atomic(self.run/'journal.json', m.encode({'phase': 'prepared', 'plan_sha256': plan_hash, 'steps': []}))
        self.receipt = {'schema_version': 1, 'plan_sha256': plan_hash, 'event_id': 'event', 'job_id': 'job',
                        'handoff_event_id': 'notification', 'operator_assertion': {'exclusive_dona_session': True, 'residual_old_workers_accepted': True, 'parent_handoff_complete': True}}
        self.services = Services()
        self.health_patch = patch.object(m.Runner, 'health')
        self.health = self.health_patch.start()
        self.rollback_patch = patch.object(m.Runner, 'old_health')
        self.old_health = self.rollback_patch.start()

    def tearDown(self):
        self.rollback_patch.stop()
        self.health_patch.stop()
        self.home_patch.stop()
        self.temp.cleanup()

    def runner(self):
        return m.Runner(self.run, self.services)

    def test_full_activation_and_old_writer_isolation(self):
        self.runner().execute(self.receipt)
        self.assertEqual(m.read_json(self.run/'journal.json')['phase'], 'succeeded')
        self.assertEqual(self.services.calls[:3], [('stop', l) for l in m.LABELS])
        self.assertEqual(self.services.calls[-3:], [('start', l) for l in m.START])
        with sqlite3.connect(self.db) as db:
            db.execute("INSERT INTO events VALUES('late-old-worker','completed')")
        self.assertEqual(m.sql_read(self.run/'backup/0.sqlite3', 'SELECT count(*) FROM events'), [(2,)])
        self.assertFalse((self.g/'dona.sqlite3').exists())
        self.assertEqual((self.old/'current').resolve(), self.old/'release')
        self.assertEqual(self.db.stat().st_ino, Path(m.read_json(self.run/'inventory.json')['databases'][0]).stat().st_ino)

    def test_missing_handoff_blocks_all_stop(self):
        for key in ['operator_assertion', 'plan_sha256', 'handoff_event_id']:
            receipt = dict(self.receipt)
            del receipt[key]
            with self.assertRaises(RuntimeError):
                self.runner().execute(receipt)
        self.assertEqual(self.services.calls, [])

    def test_active_job_blocks_stop(self):
        with sqlite3.connect(self.db) as db:
            db.execute("UPDATE jobs SET status='running'")
        with self.assertRaisesRegex(RuntimeError, 'handoff_not_terminal'):
            self.runner().execute(self.receipt)
        self.assertEqual(self.services.calls, [])

    def test_unfinished_parent_notification_blocks_stop(self):
        with sqlite3.connect(self.db) as db:
            db.execute("UPDATE events SET status='dispatching' WHERE event_id='notification'")
        with self.assertRaisesRegex(RuntimeError, 'parent_notification_not_terminal'):
            self.runner().execute(self.receipt)
        self.assertEqual(self.services.calls, [])

    def test_configuration_drift_blocks_stop(self):
        Path(next(iter(self.files))).write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'configuration_drift'):
            self.runner().execute(self.receipt)
        self.assertEqual(self.services.calls, [])

    def test_sealed_assets_drift_blocks_stop(self):
        (self.g/'changed').write_text('x')
        with self.assertRaisesRegex(RuntimeError, 'generation_drift'):
            self.runner().execute(self.receipt)
        self.assertEqual(self.services.calls, [])

    def test_staged_plist_drift_blocks_stop(self):
        (self.run/'plists'/ (m.LABELS[0]+'.plist')).write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'staged_plists_changed'):
            self.runner()
        self.assertEqual(self.services.calls, [])

    def test_health_failure_restores_original_configuration(self):
        self.health.side_effect = RuntimeError('injected_health_failure')
        with self.assertRaisesRegex(RuntimeError, 'injected_health_failure'):
            self.runner().execute(self.receipt)
        self.assertEqual(m.read_json(self.run/'journal.json')['phase'], 'rolled_back')
        for name, sha in self.files.items():
            self.assertEqual(m.digest(Path(name).read_bytes()), sha)
        self.old_health.assert_called_once()

    def test_rollback_health_failure_is_not_success(self):
        self.health.side_effect = RuntimeError('injected_health_failure')
        self.old_health.side_effect = RuntimeError('rollback_health_unconfirmed')
        with self.assertRaisesRegex(RuntimeError, 'rollback_health_unconfirmed'):
            self.runner().execute(self.receipt)
        self.assertEqual(m.read_json(self.run/'journal.json')['phase'], 'rolling_back')
        self.old_health.side_effect = None
        self.runner().execute(self.receipt)
        self.assertEqual(m.read_json(self.run/'journal.json')['phase'], 'rolled_back')

    def test_stop_failure_never_switches_plists(self):
        self.services.stop_failure = True
        with self.assertRaises(RuntimeError):
            self.runner().execute(self.receipt)
        self.assertEqual(m.read_json(self.run/'journal.json')['phase'], 'rolling_back')
        for name, sha in self.files.items():
            self.assertEqual(m.digest(Path(name).read_bytes()), sha)

    def test_crash_after_each_phase_resumes_without_terminal_receipt_reread(self):
        # crash後はDBを再初期化しない。journalがhandoff受理を保持する。
        for phase in ['stopping', 'backing_up', 'switching', 'starting']:
            with self.subTest(phase=phase):
                runner = self.runner()
                runner.record(phase)
                runner.execute({})
                self.assertEqual(runner.journal['phase'], 'succeeded')

    def test_partial_plist_switch_replays_idempotently(self):
        runner = self.runner()
        runner.record('switching')
        label = m.LABELS[0]
        target = self.home/'Library/LaunchAgents'/ (label+'.plist')
        target.write_bytes((self.run/'plists'/target.name).read_bytes())
        runner.execute({})
        for label in m.LABELS:
            target = self.home/'Library/LaunchAgents'/ (label+'.plist')
            self.assertEqual(target.read_bytes(), (self.run/'plists'/target.name).read_bytes())

    def test_completed_run_does_not_repeat_side_effects(self):
        self.runner().execute(self.receipt)
        count = len(self.services.calls)
        self.runner().execute(self.receipt)
        self.assertEqual(len(self.services.calls), count)

    def test_concurrent_runner_is_rejected(self):
        with m.locked(self.run):
            with self.assertRaises(BlockingIOError):
                with m.locked(self.run):
                    pass

    def test_actual_child_services_and_unix_health(self):
        # launchd adapter以外は実process/socket/HTTP/journalを通す。
        fixture = self.home/'fixture_service.py'
        fixture.write_text("""import os,socket,socketserver,http.server,json
class Server(socketserver.UnixStreamServer): pass
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  body=json.dumps({'status':'ready','build_sha':os.environ['SHA'],'service':os.environ['SERVICE'],'workspaces_ready':True,'dispatcher_ready':True}).encode()
  self.send_response(200); self.end_headers(); self.wfile.write(body)
 def log_message(self,*args): pass
p=os.environ['SOCKET']
try: os.unlink(p)
except FileNotFoundError: pass
with Server(p,Handler) as server: server.serve_forever()
""")
        for name in ['run', 'control']:
            m.private_dir(self.g/name)
        mapping = {m.LABELS[0]: ('run/s.sock', 'slack_adapter'), m.LABELS[1]: ('run/d.sock', 'dispatcher'), m.LABELS[2]: ('control/updater.sock', 'updater')}
        for label,(sock,service) in mapping.items():
            p=self.run/'plists'/(label+'.plist')
            p.write_bytes(plistlib.dumps({'Label':label,'ProgramArguments':[sys.executable,str(fixture)],'EnvironmentVariables':{'SHA':'a'*40,'SERVICE':service,'SOCKET':str(self.g/sock)}}))
        plan=m.read_json(self.run/'plan.json')
        plan['plists_seal']=m.tree_seal(self.run/'plists')
        plan['generation_seal']=m.tree_seal(self.g)
        m.atomic(self.run/'plan.json',m.encode(plan))
        journal=m.read_json(self.run/'journal.json')
        journal['plan_sha256']=m.digest((self.run/'plan.json').read_bytes())
        m.atomic(self.run/'journal.json',m.encode(journal))
        self.receipt['plan_sha256']=journal['plan_sha256']
        class Processes:
            def __init__(self): self.children={}
            def observe(self,label):
                p=self.children.get(label)
                return {'pid':p.pid} if p and p.poll() is None else None
            def start(self,label,plist):
                if self.observe(label): return
                data=plistlib.loads(plist.read_bytes())
                self.children[label]=subprocess.Popen(data['ProgramArguments'],env=dict(os.environ,**data['EnvironmentVariables']),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            def stop(self,label):
                if self.observe(label):
                    self.children[label].terminate(); self.children[label].wait(timeout=5)
            def process(self,pid): return m.Launchd().process(pid)
        services=Processes()
        runner=m.Runner(self.run,services)
        runner.health=lambda: REAL_HEALTH(runner)
        try:
            runner.execute(self.receipt)
            self.assertEqual(runner.journal['phase'],'succeeded')
            self.assertTrue(all(services.observe(label) for label in m.LABELS))
            runner.stop_all()
            self.assertTrue(all(services.observe(label) is None for label in m.LABELS))
        finally:
            for label in m.LABELS: services.stop(label)

    def test_atomic_crash_temporary_recovery(self):
        target=self.run/'status.json'
        target.with_suffix('.json.tmp').write_bytes(b'incomplete')
        m.atomic(target,m.encode({'phase':'complete'}))
        self.assertEqual(m.read_json(target),{'phase':'complete'})

    def test_unknown_launchd_error_is_not_absence(self):
        class Result:
            returncode = 5
            stderr = b'Input/output error'
        with patch.object(m.subprocess, 'run', return_value=Result()):
            with self.assertRaisesRegex(RuntimeError, 'observation_unknown'):
                m.Launchd().observe(m.LABELS[0])


if __name__ == '__main__':
    unittest.main()
