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
REAL_TRUST = m.verify_trust
REAL_MAIN_READY = m.Runner.assert_main_ready
REAL_ENSURE_MAIN = m.Runner.ensure_main
REAL_QUIESCE = m.Runner.quiesce_old_slack


class FixtureDatabase:
    def read(self, file, sql, args=()):
        with sqlite3.connect(Path(file).as_uri()+'?mode=ro',uri=True) as db:
            return db.execute(sql,args).fetchall()

    def backup(self, source, destination):
        with sqlite3.connect(Path(source).as_uri()+'?mode=ro',uri=True) as src, sqlite3.connect(destination) as dst:
            src.backup(dst)



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
        for name in ['config','control/updater','runtime']:
            m.private_dir(self.g/name)
        (self.g/'control/policy.json').write_text('{}')
        (self.g/'control/dispatcher.token').write_text('fixture')
        with sqlite3.connect(self.old/'updater.sqlite3') as db:
            db.execute('CREATE TABLE update_requests(state TEXT)')
        m.private_dir(self.home/'Library/LaunchAgents')
        m.private_dir(self.run/'plists')
        (self.old/'current').symlink_to(self.old/'release')
        (self.old/'release').mkdir()
        self.db = self.old/'dona.sqlite3'
        with sqlite3.connect(self.db) as db:
            db.executescript("CREATE TABLE events(event_id TEXT,status TEXT,subject_json TEXT,reply_target_json TEXT,completed_at TEXT); CREATE TABLE jobs(job_id TEXT,source_event_id TEXT,status TEXT,completion_event_id TEXT,last_error_code TEXT,result_path TEXT); INSERT INTO events(event_id,status) VALUES('event','completed'),('notification','completed'); INSERT INTO jobs(job_id,source_event_id,status,completion_event_id) VALUES('job','event','completed','notification');")
        self.plists = {label: {'Label': label, 'ProgramArguments': ['node', '/old/'+label], 'EnvironmentVariables': {}} for label in m.LABELS}
        self.files = {}
        for label, plist in self.plists.items():
            f = self.home/'Library/LaunchAgents'/ (label+'.plist')
            f.write_bytes(plistlib.dumps(plist))
            self.files[str(f)] = m.digest(f.read_bytes())
            m.atomic(self.run/'plists'/f.name, plistlib.dumps(dict(plist, ProgramArguments=['node', '/new/'+label])))
        inv = {'files': self.files, 'policy': {'current_pointer': str(self.old/'current'), 'control_root': str(self.old), 'executables': {'node':sys.executable, 'codex':sys.executable}}, 'old_pointer': str(self.old/'release'),
               'plists': self.plists, 'databases': [str(self.db)], 'old_results': [str(self.old/'results')]}
        m.atomic(self.run/'inventory.json', m.encode(inv))
        m.atomic(self.run/'runner.py', Path(m.__file__).read_bytes())
        m.atomic(self.run/'main_bridge.mjs',Path(m.__file__).with_name('main_bridge.mjs').read_bytes())
        plan = {'runner_sha256': m.digest((self.run/'runner.py').read_bytes()), 'generation': str(self.g), 'target_sha': 'a'*40, 'event_id': 'event', 'job_id': 'job',
                'inventory_sha256': m.digest((self.run/'inventory.json').read_bytes()),
                'generation_seal': m.tree_seal(self.g), 'static_seal':m.static_seal(self.g), 'plists_seal': m.tree_seal(self.run/'plists')}
        m.atomic(self.run/'plan.json', m.encode(plan))
        plan_hash = m.digest((self.run/'plan.json').read_bytes())
        m.atomic(self.run/'journal.json', m.encode({'phase': 'prepared', 'plan_sha256': plan_hash, 'steps': []}))
        self.receipt = {'schema_version': 1, 'plan_sha256': plan_hash, 'event_id': 'event', 'job_id': 'job',
                        'handoff_event_id': 'notification', 'operator_assertion': {'exclusive_dona_session': True, 'residual_old_workers_accepted': True, 'parent_handoff_complete': True}}
        self.services = Services()
        self.health_patch = patch.object(m.Runner, 'health')
        self.health = self.health_patch.start()
        self.quiesce_patch = patch.object(m.Runner, 'quiesce_old_slack')
        self.quiesce = self.quiesce_patch.start()
        self.ensure_patch = patch.object(m.Runner, 'ensure_main')
        self.ensure = self.ensure_patch.start()
        self.main_patch = patch.object(m.Runner, 'assert_main_ready', return_value=True)
        self.main_ready = self.main_patch.start()
        self.trust_patch = patch.object(m, 'verify_trust', return_value={})
        self.trust = self.trust_patch.start()
        self.rollback_patch = patch.object(m.Runner, 'old_health')
        self.old_health = self.rollback_patch.start()

    def tearDown(self):
        self.quiesce_patch.stop()
        self.ensure_patch.stop()
        self.main_patch.stop()
        self.trust_patch.stop()
        self.rollback_patch.stop()
        self.health_patch.stop()
        self.home_patch.stop()
        self.temp.cleanup()

    def runner(self):
        return m.Runner(self.run, self.services, FixtureDatabase())

    def test_full_activation_and_old_writer_isolation(self):
        self.runner().execute(self.receipt)
        self.assertEqual(m.read_json(self.run/'journal.json')['phase'], 'succeeded')
        self.assertEqual(self.services.calls[:3], [('stop', l) for l in m.LABELS])
        self.assertEqual(self.services.calls[-3:], [('start', l) for l in m.START])
        with sqlite3.connect(self.db) as db:
            db.execute("INSERT INTO events(event_id,status) VALUES('late-old-worker','completed')")
        self.assertEqual(FixtureDatabase().read(self.run/'backup/0.sqlite3', 'SELECT count(*) FROM events'), [(2,)])
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
            self.runner().execute(self.receipt)
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
        for phase in ['stopping', 'backing_up', 'switching', 'starting_core', 'starting_ingress']:
            with self.subTest(phase=phase):
                for label,plist in self.plists.items():
                    (self.home/'Library/LaunchAgents'/(label+'.plist')).write_bytes(plistlib.dumps(plist))
                runner = self.runner()
                if phase in ('starting_core','starting_ingress'): runner.switch()
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
  body=json.dumps({'status':'ready','build_sha':os.environ['SHA'],'service':os.environ['SERVICE'],'workspaces_ready':True,'dispatcher_ready':True,'update_notification_protocol':1}).encode()
  self.send_response(200); self.end_headers(); self.wfile.write(body)
 def log_message(self,*args): pass
p=os.environ['SOCKET']
try: os.unlink(p)
except FileNotFoundError: pass
with Server(p,Handler) as server: server.serve_forever()
""")
        for name in ['run', 'control']:
            m.private_dir(self.g/name)
        mapping = {'dev.dona.slack-adapter': ('run/s.sock', 'slack_adapter'), 'dev.dona.dispatcher': ('run/d.sock', 'dispatcher'), 'dev.dona.updater': ('control/updater.sock', 'updater')}
        for label,(sock,service) in mapping.items():
            p=self.run/'plists'/(label+'.plist')
            p.write_bytes(plistlib.dumps({'Label':label,'ProgramArguments':[sys.executable,str(fixture)],'EnvironmentVariables':{'SHA':'a'*40,'SERVICE':service,'SOCKET':str(self.g/sock)}}))
        plan=m.read_json(self.run/'plan.json')
        plan['plists_seal']=m.tree_seal(self.run/'plists')
        plan['service_programs']={label:str(fixture) for label in m.LABELS}
        plan['generation_seal']=m.tree_seal(self.g)
        plan['static_seal']=m.static_seal(self.g)
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
        runner=m.Runner(self.run,services,FixtureDatabase())
        runner.health=lambda include_slack=True: REAL_HEALTH(runner, include_slack)
        try:
            runner.execute(self.receipt)
            self.assertEqual(runner.journal['phase'],'succeeded')
            self.assertTrue(all(services.observe(label) for label in m.LABELS))
            runner.stop_all()
            self.assertTrue(all(services.observe(label) is None for label in m.LABELS))
        finally:
            for label in m.LABELS: services.stop(label)

    def test_render_keeps_stable_updater_outside_release_retention(self):
        release=m.private_dir(self.g/'runtime/releases'/('a'*40))
        m.private_dir(release/'updater/dist')
        (release/'updater/dist/cli.js').write_text('stable updater')
        m.private_dir(release/'config')
        (release/'config/release-compatibility.json').write_text('{"schema_version":1,"protocol":1}')
        (release/'config/update-compatibility-transitions.json').write_text('{"transitions":[]}')
        for directory in ['config','control','logs','run']:
            m.private_dir(self.g/directory)
        plan={'generation':str(self.g),'release':str(release),'target_sha':'a'*40}
        inv={'policy':{'executables':{'node':sys.executable,'codex':sys.executable}},'plists':self.plists,
             'configs':{key:{'values':{'SLACK_WORKSPACES':'test'}} for key in ['dispatcher','slack']}}
        (self.g/'control/updater').rmdir()
        m.render(self.run,plan,inv)
        updater=plistlib.loads((self.run/'plists/dev.dona.updater.plist').read_bytes())
        self.assertEqual(updater['WorkingDirectory'],str(self.g/'control/updater'))
        self.assertEqual(updater['ProgramArguments'][1],str(self.g/'control/updater/dist/cli.js'))
        self.assertEqual((self.g/'control/updater/dist/cli.js').read_text(),'stable updater')
        self.assertFalse(Path(updater['WorkingDirectory']).is_relative_to(release.parent))
        self.assertIn(str(self.g/'run/d.sock'),(self.g/'config/dispatcher.env').read_text())
        self.assertIn(str(self.g/'job-results'),(self.g/'config/dispatcher.env').read_text())

    def test_pending_self_update_rejects_before_any_stop(self):
        with sqlite3.connect(self.old/'updater.sqlite3') as db:
            db.execute("INSERT INTO update_requests VALUES('approved')")
        with self.assertRaisesRegex(RuntimeError,'normal_update_in_progress'):
            self.runner().execute(self.receipt)
        self.assertEqual(self.services.calls,[])

    def test_update_accepted_during_stop_prevents_generation_switch(self):
        original=self.services.stop
        def race(label):
            original(label)
            if label=='dev.dona.updater':
                with sqlite3.connect(self.old/'updater.sqlite3') as db:
                    db.execute("INSERT INTO update_requests VALUES('activating')")
        self.services.stop=race
        with self.assertRaisesRegex(RuntimeError,'normal_update_in_progress'):
            self.runner().execute(self.receipt)
        self.assertEqual(self.services.calls[0],('stop','dev.dona.updater'))
        for name,sha in self.files.items(): self.assertEqual(m.digest(Path(name).read_bytes()),sha)

    def test_restart_rechecks_unstarted_database_and_static_assets(self):
        runner=self.runner();runner.record('backing_up')
        (self.g/'dona.sqlite3').write_bytes(b'corrupt')
        with self.assertRaisesRegex(RuntimeError,'prepared_generation_drift'):
            self.runner().execute({})
        (self.g/'dona.sqlite3').unlink()
        runner.record('starting_core')
        (self.g/'config/tampered.env').write_text('changed')
        with self.assertRaisesRegex(RuntimeError,'static_generation_drift'):
            self.runner().execute({})
        self.assertEqual(m.read_json(self.run/'journal.json')['phase'],'rolled_back')

    def test_ingress_failure_retains_acked_events_and_resumes_same_generation(self):
        def health(include_slack=True):
            if include_slack:
                with sqlite3.connect(self.g/'dona.sqlite3') as db:
                    db.execute('CREATE TABLE accepted_events(id TEXT)')
                    db.execute("INSERT INTO accepted_events VALUES('acked')")
                raise RuntimeError('slack_health_failure_after_ack')
        self.health.side_effect=health
        with self.assertRaisesRegex(RuntimeError,'slack_health_failure_after_ack'):
            self.runner().execute(self.receipt)
        self.assertEqual(m.read_json(self.run/'journal.json')['phase'],'forward_recovery')
        self.assertEqual(FixtureDatabase().read(self.g/'dona.sqlite3','SELECT id FROM accepted_events'),[('acked',)])
        self.assertFalse(self.services.registered)
        for label in m.LABELS:
            target=self.home/'Library/LaunchAgents'/(label+'.plist')
            self.assertEqual(target.read_bytes(),(self.run/'plists'/target.name).read_bytes())
        self.health.side_effect=None
        self.runner().execute({})
        self.assertEqual(m.read_json(self.run/'journal.json')['phase'],'succeeded')
        self.assertEqual(FixtureDatabase().read(self.g/'dona.sqlite3','SELECT id FROM accepted_events'),[('acked',)])

    def test_explicit_restore_handles_static_drift_but_refuses_post_ingress(self):
        runner=self.runner();runner.record('starting_core')
        (self.g/'config/tampered.env').write_text('changed')
        runner.restore()
        self.assertEqual(runner.journal['phase'],'rolled_back')
        runner.record('starting_ingress')
        count=len(self.services.calls)
        with self.assertRaisesRegex(RuntimeError,'restore_after_ingress_forbidden'): runner.restore()
        self.assertEqual(len(self.services.calls),count)

    def test_post_ingress_static_drift_stops_ingress_and_preserves_generation(self):
        runner=self.runner();runner.switch();runner.record('starting_ingress');runner.install_slack()
        (self.g/'config/tampered.env').write_text('changed')
        with self.assertRaisesRegex(RuntimeError,'static_generation_drift'):
            self.runner().execute({})
        self.assertEqual(m.read_json(self.run/'journal.json')['phase'],'forward_recovery')
        self.assertFalse(self.services.registered)
        for label in m.LABELS:
            p=self.home/'Library/LaunchAgents'/(label+'.plist')
            self.assertEqual(p.read_bytes(),(self.run/'plists'/p.name).read_bytes())

    def test_installed_plist_drift_cannot_bootstrap_wrong_database(self):
        runner=self.runner();runner.switch();runner.record('starting_core')
        p=self.home/'Library/LaunchAgents/dev.dona.dispatcher.plist'
        data=plistlib.loads(p.read_bytes());data['EnvironmentVariables']['DONA_DATABASE_PATH']=str(self.db)
        p.write_bytes(plistlib.dumps(data))
        with self.assertRaisesRegex(RuntimeError,'installed_plist_drift'):
            self.runner().execute({})
        self.assertEqual(m.read_json(self.run/'journal.json')['phase'],'rolled_back')
        for name,sha in self.files.items(): self.assertEqual(m.digest(Path(name).read_bytes()),sha)

    def test_token_permission_change_invalidates_seal(self):
        os.chmod(self.g/'control/dispatcher.token',0o666)
        with self.assertRaisesRegex(RuntimeError,'static_generation_drift'):
            self.runner().execute(self.receipt)
        self.assertEqual(self.services.calls,[])

    def test_missing_notification_protocol_never_passes_health(self):
        runner=self.runner()
        for missing in ('dispatcher','slack_adapter'):
            def health(socket_path,route):
                service={'updater.sock':'updater','d.sock':'dispatcher','s.sock':'slack_adapter'}[Path(socket_path).name]
                result={'status':'ready','service':service,'build_sha':'a'*40,'workspaces_ready':True,'dispatcher_ready':True,'update_notification_protocol':1}
                if service==missing: result.pop('update_notification_protocol')
                return result
            with patch.object(m,'http_unix',side_effect=health), patch.object(m.time,'monotonic',side_effect=[0,1,91]), patch.object(m.time,'sleep'):
                with self.assertRaisesRegex(RuntimeError,'target_health_timeout'): REAL_HEALTH(runner)

    def test_backup_hash_does_not_read_entire_file_into_memory(self):
        runner=self.runner()
        with patch.object(m.Path,'read_bytes',side_effect=AssertionError('whole file read')):
            runner.backup()
        manifest=m.read_json(self.run/'backup/manifest.json')
        self.assertEqual(manifest['databases'][0]['sha256'],m.file_digest(self.run/'backup/0.sqlite3'))

    def test_trust_rejects_failed_pending_wrong_app_sha_and_signature(self):
        policy={'executables':{'gh':'fixture-gh'},'required_checks':['required'],'require_verified_signature':False}
        good={'id':1,'name':'required','head_sha':'a'*40,'app':{'slug':'github-actions'},'status':'completed','conclusion':'success'}
        for changed in ({'conclusion':'failure'},{'status':'in_progress'},{'app':{'slug':'other'}},{'head_sha':'b'*40}):
            with patch.object(m,'command',return_value=json.dumps([{'check_runs':[dict(good,**changed)]}])):
                with self.assertRaises(RuntimeError): REAL_TRUST('a'*40,policy)
        with patch.object(m,'command',return_value=json.dumps([{'check_runs':[good,dict(good,id=2,status='queued')]}])):
            with self.assertRaisesRegex(RuntimeError,'required_check_not_success'): REAL_TRUST('a'*40,policy)
        for verified in (False,True):
            with patch.object(m,'command',side_effect=[json.dumps([{'check_runs':[good]}]),json.dumps({'sha':'a'*40,'commit':{'verification':{'verified':verified}}})]):
                if verified: self.assertEqual(REAL_TRUST('a'*40,dict(policy,require_verified_signature=True))['checks'][0]['id'],1)
                else:
                    with self.assertRaisesRegex(RuntimeError,'signature_not_verified'): REAL_TRUST('a'*40,dict(policy,require_verified_signature=True))

    def test_trust_regression_before_execute_never_stops_services(self):
        self.trust.side_effect=RuntimeError('required_check_not_success')
        with self.assertRaisesRegex(RuntimeError,'required_check_not_success'): self.runner().execute(self.receipt)
        self.assertEqual(self.services.calls,[])

    def test_main_not_ready_keeps_slack_ingress_stopped(self):
        self.main_ready.return_value=False
        with self.assertRaisesRegex(RuntimeError,'main_not_ready'): self.runner().execute(self.receipt)
        self.assertEqual(m.read_json(self.run/'journal.json')['phase'],'forward_recovery')
        self.assertNotIn(('start','dev.dona.slack-adapter'),self.services.calls)
        self.assertNotIn('dev.dona.slack-adapter',self.services.registered)
        slack=self.home/'Library/LaunchAgents/dev.dona.slack-adapter.plist'
        self.assertEqual(m.file_digest(slack),self.files[str(slack)])
        self.main_ready.return_value=True
        self.runner().execute(self.receipt)
        self.assertEqual(m.read_json(self.run/'journal.json')['phase'],'succeeded')

    def test_dotenv_parse_and_hash_share_one_read_during_replacement(self):
        env=self.home/'source.env';env.write_text('KEY=old')
        plist={'EnvironmentVariables':{'DOTENV_CONFIG_PATH':str(env)},'WorkingDirectory':str(self.home),'ProgramArguments':[sys.executable]}
        def parse(argv,**options):
            data=json.loads(options['input'])
            env.write_text('KEY=new')
            return json.dumps({'config':{},'values':{'KEY':data['dotenv'].split('=')[1]}})
        with patch.object(m,'command',side_effect=parse): result=m.effective_config(plist,'dispatcher')
        self.assertEqual(result['values']['KEY'],'old')
        self.assertEqual(result['dotenv_sha256'],m.digest(b'KEY=old'))
        self.assertNotEqual(result['dotenv_sha256'],m.file_digest(env))

    def test_code_tree_becomes_read_only_before_sealing(self):
        root=m.private_dir(self.home/'code');child=m.private_dir(root/'sub')
        file=child/'code.js';file.write_text('code')
        m.make_immutable(root)
        self.assertEqual(file.stat().st_mode & 0o777,0o400)
        self.assertEqual(root.stat().st_mode & 0o777,0o500)
        self.assertEqual(child.stat().st_mode & 0o777,0o500)
        # fixtureをcleanupするためだけにpermissionを戻す。
        os.chmod(root,0o700);os.chmod(child,0o700);os.chmod(file,0o600)

    def test_partial_backup_is_reclaimed_before_rollback(self):
        runner=self.runner()
        def failed(source,destination):
            for suffix in ('','-wal','-shm'): Path(str(destination)+suffix).write_bytes(b'partial')
            raise OSError(28,'No space left')
        runner.database.backup=failed
        with self.assertRaises(OSError): runner.execute(self.receipt)
        self.assertFalse(any((self.run/'backup').iterdir()))
        self.assertEqual(runner.journal['phase'],'rolled_back')

    def test_insufficient_backup_capacity_never_stops_services(self):
        class Disk: free=0
        with patch.object(m.shutil,'disk_usage',return_value=Disk()):
            with self.assertRaisesRegex(RuntimeError,'backup_disk_floor'): self.runner().execute(self.receipt)
        self.assertEqual(self.services.calls,[])

    def test_execute_and_restore_require_the_sealed_entrypoint(self):
        for action in ('execute','restore'):
            argv=[sys.executable,'-B',m.__file__,action,'--run',str(self.run)]
            if action=='execute': argv+=['--handoff',str(self.run/'absent.json')]
            result=subprocess.run(argv,capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('sealed_runner_required',result.stderr)
        result=subprocess.run([sys.executable,'-B',str(self.run/'runner.py'),'restore','--run',str(self.run)],capture_output=True,text=True)
        self.assertIn('restore_after_ingress_forbidden',result.stderr)
        self.assertNotIn('sealed_runner_required',result.stderr)

    def test_main_process_receipt_binds_new_pid_children_and_wrapper_paths(self):
        plan={'release':'/release','generation':'/generation'}
        inv={'policy':{'executables':{'node':'/bin/node','codex':'/bin/codex'}}}
        spec={'main_pid':100,'dispatcher_pid':101,'slack_pid':102,'previous_main_pid':99,'session_id':'new-session','dispatcher_target_confirmed':True,'mcp_handshake_confirmed':True}
        records={100:{'uid':os.getuid(),'parent':10,'identity':'main-new','command':'/bin/codex -C /release'},
                 101:{'uid':os.getuid(),'parent':100,'identity':'dispatcher-new','command':'/bin/node /generation/config/mcp-dispatcher.mjs'},
                 102:{'uid':os.getuid(),'parent':100,'identity':'slack-new','command':'/bin/node /generation/config/mcp-slack.mjs'}}
        evidence=m.main_evidence(plan,inv,spec,records.__getitem__)
        self.assertEqual(len(evidence),3)
        for change in ({'previous_main_pid':100},{'dispatcher_target_confirmed':False},{'mcp_handshake_confirmed':False}):
            with self.assertRaises(RuntimeError): m.main_evidence(plan,inv,dict(spec,**change),records.__getitem__)
        records[101]['command']='/bin/node /old/config/mcp-dispatcher.mjs'
        with self.assertRaisesRegex(RuntimeError,'main_process_binding'): m.main_evidence(plan,inv,spec,records.__getitem__)
        records[101]['command']='/bin/node /generation/config/mcp-dispatcher.mjs'
        records[101]['parent']=102;records[102]['parent']=102
        with self.assertRaisesRegex(RuntimeError,'main_parent_binding'): m.main_evidence(plan,inv,spec,records.__getitem__)

    def test_main_evidence_observes_actual_owned_process_tree(self):
        config=m.private_dir(self.home/'main-config/config')
        for name in ('dispatcher','slack'):
            (config/('mcp-'+name+'.mjs')).write_text('import time;print(\"ready\",flush=True);time.sleep(30)')
        release=m.private_dir(self.home/'main-release')
        launcher=self.home/'main_fixture.py'
        launcher.write_text("import subprocess,sys,time,json\na=subprocess.Popen([sys.executable,sys.argv[1]],stdout=subprocess.PIPE,text=True);b=subprocess.Popen([sys.executable,sys.argv[2]],stdout=subprocess.PIPE,text=True)\nassert a.stdout.readline().strip()=='ready';assert b.stdout.readline().strip()=='ready'\nprint(json.dumps([a.pid,b.pid]),flush=True)\ntry: time.sleep(30)\nfinally: a.terminate();b.terminate();a.wait();b.wait()\n")
        process=subprocess.Popen([sys.executable,str(launcher),str(config/'mcp-dispatcher.mjs'),str(config/'mcp-slack.mjs'),str(release), 'mcp_servers.dona_dispatcher.required=true','mcp_servers.dona_dispatcher.enabled=true','mcp_servers.dona_slack.required=true','mcp_servers.dona_slack.enabled=true'],stdout=subprocess.PIPE,text=True)
        children=[]
        try:
            children=json.loads(process.stdout.readline())
            plan={'release':str(release),'generation':str(config.parent)}
            # macOSのPython launcherはframework binaryへexecするので、その実binaryをfixture policyへ固定する。
            binary=subprocess.check_output(['/bin/ps','-p',str(process.pid),'-o','comm='],text=True).strip()
            inv={'policy':{'executables':{'node':binary,'codex':binary}}}
            spec={'main_pid':process.pid,'dispatcher_pid':children[0],'slack_pid':children[1],'previous_main_pid':os.getpid(),'session_id':'fixture-new','dispatcher_target_confirmed':True,'mcp_handshake_confirmed':True}
            evidence=m.main_evidence(plan,inv,spec)
            self.assertEqual([r['pid'] for r in evidence],[process.pid,*children])
            runner=self.runner();runner.plan.update(plan);runner.inv['policy']=inv['policy'];runner.generation=config.parent
            old={'exists':True,'name':'dona-main','kind':'codex','matches_release':True,'pane_id':'w1:p1','session_id':'old','status':'idle'}
            observed=dict(old,session_id='fixture-new',interactive_ready=True)
            with patch.object(runner,'main_call',side_effect=[old,{'outcome':'stopped'},{'outcome':'started','observation':observed},observed]) as calls, patch.object(runner,'find_main_pid',side_effect=[os.getpid(),process.pid]):
                REAL_ENSURE_MAIN(runner)
                self.assertEqual([c.kwargs['action'] for c in calls.call_args_list],['status','stop','start','status'])
            with patch.object(runner,'main_call',return_value=observed): self.assertTrue(REAL_MAIN_READY(runner))
            # start応答喪失後も同じmainと実childをread-only照合し、startを再送しない。
            state=m.read_json(self.run/'main-lifecycle.json');state['phase']='start_intent';state.pop('observation')
            m.atomic(self.run/'main-lifecycle.json',m.encode(state))
            with patch.object(runner,'main_call',return_value=observed) as calls, patch.object(runner,'find_main_pid',return_value=process.pid):
                REAL_ENSURE_MAIN(runner)
                self.assertEqual([c.kwargs['action'] for c in calls.call_args_list],['status'])

        finally:
            # fixture子だけをexact PIDで終了。production/Herdrは対象外。
            for pid in children:
                try: os.kill(pid,15)
                except ProcessLookupError: pass
            process.terminate();process.wait(timeout=5);process.stdout.close()

    def test_main_receipt_is_plan_bound_and_refreshes_after_live_validation(self):
        runner=self.runner()
        receipt={'schema_version':1,'plan_sha256':runner.journal['plan_sha256'],'mapping_evidence':'updater_runtime_and_required_mcp','spec':{},'observations':[],'issued_at_unix':m.time.time()}
        m.atomic(self.run/'main-ready.json',m.encode(receipt))
        receipt['spec']={'session_id':'new'};m.atomic(self.run/'main-ready.json',m.encode(receipt));runner.plan['release']='/release'
        runner.main_step('started',old={'pane_id':'pane'})
        with patch.object(m,'main_evidence',return_value=[]),patch.object(runner,'main_call',return_value={'exists':True,'name':'dona-main','kind':'codex','pane_id':'pane','matches_release':True,'session_id':'new'}): self.assertTrue(REAL_MAIN_READY(runner))
        receipt['issued_at_unix']-=121
        m.atomic(self.run/'main-ready.json',m.encode(receipt))
        with patch.object(m,'main_evidence',return_value=[]),patch.object(runner,'main_call',return_value={'exists':True,'name':'dona-main','kind':'codex','pane_id':'pane','matches_release':True,'session_id':'new'}): self.assertTrue(REAL_MAIN_READY(runner))
        self.assertGreater(m.read_json(self.run/'main-ready.json')['issued_at_unix'],receipt['issued_at_unix'])
        receipt['plan_sha256']='other'
        m.atomic(self.run/'main-ready.json',m.encode(receipt))
        with self.assertRaisesRegex(RuntimeError,'main_receipt_binding'): REAL_MAIN_READY(runner)

    def test_crash_partial_backup_is_removed_before_capacity_check(self):
        runner=self.runner();runner.record('backing_up')
        partial=m.private_dir(self.run/'backup')/'0.tmp';partial.write_bytes(b'partial')
        original=runner.preflight_space
        def capacity():
            self.assertFalse(partial.exists());original()
        runner.preflight_space=capacity
        runner.execute({})
        self.assertEqual(runner.journal['phase'],'succeeded')

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


class RecoveryRegressionTest(unittest.TestCase):
    setUp=RunnerTest.setUp
    tearDown=RunnerTest.tearDown
    runner=RunnerTest.runner
    def test_plist_tamper_after_ingress_stops_registered_services(self):
        runner=self.runner();runner.switch();runner.record('starting_ingress');runner.install_slack()
        (self.run/'plists'/(m.LABELS[0]+'.plist')).write_bytes(b'tampered')
        with self.assertRaisesRegex(RuntimeError,'staged_plists_changed'): self.runner().execute({})
        self.assertEqual(self.services.registered,set())
        self.assertEqual(m.read_json(self.run/'journal.json')['phase'],'forward_recovery')

    def test_success_journal_write_failure_never_restores_old_ingress(self):
        original=m.atomic
        def failing(file,data):
            if file == self.run/'journal.json' and json.loads(data).get('phase')=='succeeded': raise OSError('disk_failure')
            return original(file,data)
        with patch.object(m,'atomic',side_effect=failing):
            with self.assertRaisesRegex(OSError,'disk_failure'): self.runner().execute(self.receipt)
        self.assertEqual(self.services.registered,set())
        self.assertEqual(m.read_json(self.run/'journal.json')['phase'],'forward_recovery')
        self.old_health.assert_not_called()

    def test_backup_time_generation_change_is_rejected_before_bootstrap(self):
        runner=self.runner();backup=runner.backup
        def changed():
            backup();(self.g/'config/changed').write_text('modified')
        runner.backup=changed
        with self.assertRaisesRegex(RuntimeError,'prepared_generation_drift'): runner.execute(self.receipt)
        self.assertEqual(m.read_json(self.run/'journal.json')['phase'],'rolled_back')
        self.health.assert_not_called()

    def test_main_handoff_failure_cannot_restore_old_main_mapping(self):
        self.ensure.side_effect=RuntimeError('main_stop_acceptance_unknown')
        with self.assertRaisesRegex(RuntimeError,'main_stop_acceptance_unknown'): self.runner().execute(self.receipt)
        self.assertEqual(m.read_json(self.run/'journal.json')['phase'],'forward_recovery')
        self.old_health.assert_not_called()
        with self.assertRaisesRegex(RuntimeError,'restore_after_ingress_forbidden'): self.runner().restore()

    def test_main_stop_intent_is_never_blind_retried(self):
        runner=self.runner();runner.main_step('stop_intent',old={})
        with patch.object(runner,'main_call') as call:
            with self.assertRaisesRegex(RuntimeError,'main_stop_acceptance_unknown'): REAL_ENSURE_MAIN(runner)
            call.assert_not_called()

    def test_optional_snapshot_does_not_gate_switch_on_old_database_backup(self):
        runner=self.runner();runner.plan['snapshot_old_databases']=False
        with patch.object(runner.database,'backup',side_effect=RuntimeError('old_database_unavailable')) as backup:
            runner.execute(self.receipt)
            backup.assert_not_called()
        self.assertEqual(runner.journal['phase'],'succeeded')


    def test_arm_uses_independent_one_shot_and_never_bootstraps_twice(self):
        receipt=self.run/'handoff.json';m.atomic(receipt,m.encode(self.receipt))
        runner=self.runner()
        label=runner.arm(receipt,self.services)
        plist=plistlib.loads((self.run/'maintenance.plist').read_bytes())
        self.assertEqual(plist['Label'],label)
        self.assertFalse(plist['KeepAlive'])
        self.assertIn('wait-execute',plist['ProgramArguments'])
        self.assertNotIn(label,m.LABELS)
        runner.arm(receipt,self.services)
        self.assertEqual(self.services.calls,[('start',label)])
        self.services.registered.remove(label)
        with self.assertRaisesRegex(RuntimeError,'arm_acceptance_unknown'): runner.arm(receipt,self.services)
        self.assertEqual(self.services.calls,[('start',label)])

    def test_wait_handoff_polls_parent_terminal_without_stopping_services(self):
        with sqlite3.connect(self.db) as db: db.execute("UPDATE events SET status='dispatching' WHERE event_id='notification'")
        def finish(_):
            with sqlite3.connect(self.db) as db: db.execute("UPDATE events SET status='completed' WHERE event_id='notification'")
        with patch.object(m.time,'sleep',side_effect=finish) as sleep:
            self.runner().wait_handoff(self.receipt)
            sleep.assert_called_once()
        self.assertEqual(self.services.calls,[])

    def test_forward_recovery_stops_slack_even_if_updater_stop_fails(self):
        runner=self.runner();runner.record('starting_ingress')
        original=self.services.stop
        def stop(label):
            if label=='dev.dona.updater': raise RuntimeError('updater_stop_failure')
            original(label)
        self.services.stop=stop
        (self.g/'config/changed').write_text('drift')
        with self.assertRaisesRegex(RuntimeError,'updater_stop_failure'): runner.execute({})
        self.assertNotIn('dev.dona.slack-adapter',self.services.registered)
        self.assertNotIn('dev.dona.dispatcher',self.services.registered)

    def test_waiting_update_plan_is_not_a_reset_gate(self):
        with sqlite3.connect(self.old/'updater.sqlite3') as db: db.execute("INSERT INTO update_requests VALUES('awaiting_approval')")
        self.runner().execute(self.receipt)
        self.assertEqual(m.read_json(self.run/'journal.json')['phase'],'succeeded')

    def test_timeout_job_uses_exact_final_result_and_later_same_thread_handoff(self):
        runner=self.runner();runner.plan['job_result_path']=str(self.run/'result.json')
        subject=json.dumps({'workspace_id':'T1','channel_id':'C1'});target=json.dumps({'channel_id':'C1','thread_ts':'1.2'})
        with sqlite3.connect(self.db) as db:
            db.execute("UPDATE jobs SET status='needs_review',last_error_code='timeout',result_path=?",(runner.plan['job_result_path'],))
            db.execute('UPDATE events SET subject_json=?,reply_target_json=?,completed_at=?',(subject,target,'2026-09-27T04:59:01Z'))
        receipt=dict(self.receipt,job_result_sha256='a'*64)
        with patch.object(m,'final_job_result',return_value={'status':'completed','completed_at':'2026-09-27T04:59:00Z'}) as result:
            m.validate_handoff(runner.plan,runner.journal['plan_sha256'],receipt,runner.inv,runner.database.read)
            self.assertEqual(result.call_args.args[2],'a'*64)
            with sqlite3.connect(self.db) as db: db.execute("UPDATE events SET completed_at='2026-09-27T04:58:00Z' WHERE event_id='notification'")
            with self.assertRaisesRegex(RuntimeError,'predates_result'): m.validate_handoff(runner.plan,runner.journal['plan_sha256'],receipt,runner.inv,runner.database.read)
            with sqlite3.connect(self.db) as db: db.execute("UPDATE events SET subject_json=? WHERE event_id='notification'",(json.dumps({'workspace_id':'T1','channel_id':'other'}),))
            with self.assertRaisesRegex(RuntimeError,'notification_scope'): m.validate_handoff(runner.plan,runner.journal['plan_sha256'],receipt,runner.inv,runner.database.read)
        self.assertEqual(FixtureDatabase().read(self.db,'SELECT status,last_error_code FROM jobs'),[('needs_review','timeout')])

    def test_final_result_digest_and_schema_share_one_read(self):
        file=self.run/'result.json';content=b'{"status":"completed"}';file.write_bytes(content)
        plan={'job_result_path':str(file),'release':'/release','job_id':'job'}
        inv={'policy':{'executables':{'node':'/bin/node'}}}
        def parse(argv,**options):
            self.assertEqual(options['input'],content);file.write_bytes(b'changed')
            return '{"status":"completed","completed_at":"2026-09-27T04:59:00Z"}'
        with patch.object(m,'command',side_effect=parse): m.final_job_result(plan,inv,m.digest(content))
        with self.assertRaisesRegex(RuntimeError,'final_result_changed'): m.final_job_result(plan,inv,m.digest(content))
        with self.assertRaisesRegex(RuntimeError,'final_result_digest_required'): m.final_job_result(plan,inv,None)

    def test_mapping_replacement_is_rejected_despite_same_live_pids(self):
        runner=self.runner();runner.plan['release']='/release';runner.main_step('started',old={'pane_id':'pane'})
        m.atomic(self.run/'main-ready.json',m.encode({'schema_version':1,'plan_sha256':runner.journal['plan_sha256'],'mapping_evidence':'updater_runtime_and_required_mcp','spec':{'session_id':'expected'},'observations':[],'issued_at_unix':m.time.time()}))
        with patch.object(m,'main_evidence',return_value=[]),patch.object(runner,'main_call',return_value={'exists':True,'name':'dona-main','kind':'codex','pane_id':'pane','matches_release':True,'session_id':'replacement'}):
            with self.assertRaisesRegex(RuntimeError,'main_mapping_changed'): REAL_MAIN_READY(runner)

    def test_source_change_during_snapshot_is_detected_before_switch(self):
        runner=self.runner();backup=runner.backup
        def changed():
            backup();(self.old/'current').unlink();(self.old/'current').symlink_to(self.old/'changed-release')
        runner.backup=changed
        with patch.object(runner,'switch') as switch:
            with self.assertRaisesRegex(RuntimeError,'source_pointer_drift'): runner.execute(self.receipt)
            switch.assert_not_called()

    def test_rollback_journal_failure_still_restores_and_starts_original_services(self):
        original=m.atomic
        def failing(file,data):
            if file==self.run/'journal.json' and json.loads(data).get('phase')=='rolling_back': raise OSError('journal_io_failure')
            return original(file,data)
        self.health.side_effect=RuntimeError('core_failure')
        with patch.object(m,'atomic',side_effect=failing):
            with self.assertRaisesRegex(OSError,'journal_io_failure'): self.runner().execute(self.receipt)
        self.old_health.assert_called_once()
        self.assertEqual(self.services.registered,set(m.LABELS))
        self.assertEqual(m.read_json(self.run/'journal.json')['phase'],'rolled_back')

    def test_quiesce_timeout_is_read_only_reconciled_without_resending(self):
        runner=self.runner();runner.inv['configs']={'slack':{'config':{'healthSocketPath':'/fixture/socket'}}}
        state={'schema_version':1,'protocol':1,'service':'slack_adapter','quiescing':True,'drained':True,'in_flight':0}
        with patch.object(m,'http_unix',side_effect=[TimeoutError(),state,state]) as call:
            REAL_QUIESCE(runner);REAL_QUIESCE(runner)
            self.assertEqual([c.args[1] for c in call.call_args_list],['/v1/admin/quiesce','/v1/admin/drain-status','/v1/admin/drain-status'])

    def test_installed_codex_is_resolved_like_runtime_not_stale_policy(self):
        file=self.home/'codex';file.write_text('fixture');file.chmod(0o700)
        with patch.object(m.shutil,'which',return_value=str(file)),patch.object(m,'command',return_value='codex-cli 0.157.1'):
            self.assertEqual(m.installed_codex(),str(file.resolve()))


    def test_definite_bootstrap_rejection_can_rearm_but_unknown_cannot(self):
        receipt=self.run/'handoff.json';m.atomic(receipt,m.encode(self.receipt))
        runner=self.runner();start=self.services.start
        with patch.object(self.services,'start',side_effect=m.LaunchdRejected('fixture_rejected')):
            with self.assertRaises(m.LaunchdRejected): runner.arm(receipt,self.services)
        self.assertEqual(m.read_json(self.run/'arm.json')['phase'],'bootstrap_rejected')
        label=runner.arm(receipt,self.services)
        self.assertIn(label,self.services.registered)
        self.assertEqual(self.services.calls,[('start',label)])

    def test_launchd_nonzero_unregistered_is_rejection_but_timeout_is_unknown(self):
        launch=m.Launchd()
        with patch.object(launch,'observe',return_value=None),patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],5,b'',b'')):
            with self.assertRaises(m.LaunchdRejected): launch.start(m.LABELS[0],self.run/'fixture.plist')
        for code in (-15,0):
            with patch.object(launch,'observe',return_value=None),patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],code,b'',b'')):
                with self.assertRaisesRegex(RuntimeError,'service_start_unconfirmed'): launch.start(m.LABELS[0],self.run/'fixture.plist')
        with patch.object(launch,'observe',return_value=None),patch.object(m.subprocess,'run',side_effect=subprocess.TimeoutExpired([],35)):
            with self.assertRaisesRegex(RuntimeError,'service_start_unconfirmed'): launch.start(m.LABELS[0],self.run/'fixture.plist')

    def test_definite_main_stop_rejection_allows_fresh_observation_on_next_execute(self):
        runner=self.runner()
        old={'exists':True,'name':'dona-main','kind':'codex','matches_release':True,'pane_id':'w1:p1','session_id':'old','status':'idle'}
        with patch.object(runner,'main_call',side_effect=[old,{'outcome':'rejected'},old,{'outcome':'rejected'}]) as call,patch.object(runner,'find_main_pid',return_value=999):
            for _ in range(2):
                with self.assertRaisesRegex(RuntimeError,'main_stop_rejected'): REAL_ENSURE_MAIN(runner)
                self.assertEqual(m.read_json(self.run/'main-lifecycle.json')['phase'],'stop_rejected')
            self.assertEqual([c.kwargs['action'] for c in call.call_args_list],['status','stop','status','stop'])


    def test_main_start_rejection_retries_but_unknown_only_reconciles(self):
        runner=self.runner();runner.plan['release']='/release'
        runner.main_step('stopped',old={'pane_id':'pane','session_id':'old'},previous_pid=999)
        with patch.object(runner,'main_call',side_effect=[{'outcome':'rejected'},{'outcome':'accepted_unknown'},{'exists':False},{'exists':False}]) as call:
            with self.assertRaisesRegex(RuntimeError,'main_start_rejected'): REAL_ENSURE_MAIN(runner)
            self.assertEqual(m.read_json(self.run/'main-lifecycle.json')['phase'],'start_rejected')
            for _ in range(2):
                with self.assertRaisesRegex(RuntimeError,'new_main_not_ready'): REAL_ENSURE_MAIN(runner)
                self.assertEqual(m.read_json(self.run/'main-lifecycle.json')['phase'],'start_intent')
            self.assertEqual([c.kwargs['action'] for c in call.call_args_list],['start','start','status','status'])
