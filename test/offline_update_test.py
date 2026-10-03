"""停止更新の順序、crash再開、復旧境界を本番に触れず検証する。"""
import copy
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]/'scripts/maintenance'))
import offline_update as m


def proc(pid, parent=1, state='S', start='Thu Oct 1 12:00:00 2026'):
    return dict(pid=pid, parent=parent, uid=os.getuid(), state=state, start=start)


class ProcessTests(unittest.TestCase):
    def test_freezes_parent_before_enumerating_children_and_kills_reverse_order(self):
        root, child, newcomer, unrelated = 800001, 800002, 800003, 800004
        table = {root: proc(root), child: proc(child,root), unrelated: proc(unrelated)}
        saved, signals = [], []
        def send(pid, sig):
            self.assertIn(pid, [p['pid'] for p in saved[-1]])
            signals.append((pid,sig))
            if sig == signal.SIGSTOP:
                table[pid]['state'] = 'T'
                if pid == root: table[newcomer] = proc(newcomer, root)
            else: table.pop(pid)
        m.ProcessStop(lambda rows:saved.append(copy.deepcopy(rows)), lambda:copy.deepcopy(table), send, lambda _:None).stop([table[root]], [])
        self.assertEqual(signals, [(root,signal.SIGSTOP),(child,signal.SIGSTOP),(newcomer,signal.SIGSTOP),
                                   (newcomer,signal.SIGKILL),(child,signal.SIGKILL),(root,signal.SIGKILL)])
        self.assertEqual(list(table), [unrelated])

    def test_crash_resume_kills_recorded_orphan_but_not_reused_pid(self):
        orphan = proc(800001)
        reused = proc(800002,start='Fri Oct 2 12:00:00 2026')
        table = {800001:orphan,800002:reused}
        signals=[]
        def send(pid,sig):
            signals.append(pid)
            if sig == signal.SIGSTOP: table[pid]['state']='T'
            else: table.pop(pid)
        m.ProcessStop(lambda _:None, lambda:copy.deepcopy(table), send).stop([], [orphan, proc(800002)])
        self.assertEqual(signals,[800001,800001])
        self.assertIn(800002,table)

    def test_current_runner_is_never_stopped(self):
        own=proc(os.getpid())
        with self.assertRaisesRegex(RuntimeError,'process_stop_scope'):
            m.ProcessStop(lambda _:None, lambda:{own['pid']:own}, lambda *_:self.fail()).stop([own],[])

    def test_real_process_tree_stops_without_touching_sibling(self):
        root = subprocess.Popen([sys.executable,'-u','-c',
            'import subprocess,sys,time; p=subprocess.Popen([sys.executable,"-c","import time; time.sleep(60)"]); print(p.pid,flush=True); time.sleep(60)'],stdout=subprocess.PIPE)
        sibling = subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])
        child = int(root.stdout.readline())
        try:
            saved=[]
            m.ProcessStop(lambda rows:saved.append(rows)).stop([m.process_table()[root.pid]],[])
            root.wait(timeout=5)
            self.assertIsNone(sibling.poll())
            self.assertIn(child,[p['pid'] for p in saved[-1]])
        finally:
            for p in (root,sibling):
                if p.poll() is None: p.kill()
                p.wait(timeout=5)
            root.stdout.close()


class FakeRunner(m.Runner):
    def __init__(self, phase='prepared', fail=None):
        self.journal={'phase':phase,'steps':[]}
        self.policy={'executables':{'herdr':'herdr'}}
        self.calls=[]
        self.fail=fail
    def hit(self,name):
        self.calls.append(name)
        if self.fail == name: raise RuntimeError(name)
    def record(self,phase=None,**fields):
        if phase: self.journal['phase']=phase
        self.journal.update(fields)
    def validate(self): self.hit('validate')
    def validate_source(self): self.hit('validate_source')
    def probe(self): self.hit('probe')
    def stop(self, **_): self.hit('stop')
    def backup(self): self.hit('backup'); self.record('backed_up')
    def migrate(self): self.hit('migrate')
    def install(self): self.hit('install')
    def start_main(self): self.hit('main')
    def start_service(self,label): self.hit(label)
    def health(self): self.hit('health')
    def restore(self): self.hit('restore'); self.record('rolled_back')


class ExecutionTests(unittest.TestCase):
    def setUp(self):
        self.patch=patch.object(m,'herdr_root',return_value=[]);self.patch.start()
    def tearDown(self): self.patch.stop()
    def test_success_orders_stop_backup_migrate_main_and_services(self):
        runner=FakeRunner();runner.execute()
        self.assertEqual(runner.calls,['validate','validate_source','probe','stop','backup','migrate','install','main',
                                     'dev.dona.dispatcher','dev.dona.slack-adapter','dev.dona.updater','health'])
        self.assertEqual(runner.journal['phase'],'succeeded')
    def test_each_pre_activation_failure_restores(self):
        for step in ('backup','migrate','install'):
            with self.subTest(step=step):
                runner=FakeRunner(fail=step)
                with self.assertRaises(RuntimeError):runner.execute()
                self.assertEqual(runner.journal['phase'],'rolled_back')
    def test_stop_failure_never_modifies_database_or_claims_rollback(self):
        runner=FakeRunner(fail='stop')
        with self.assertRaises(RuntimeError):runner.execute()
        self.assertEqual(runner.journal['phase'],'stopping')
        self.assertNotIn('backup',runner.calls);self.assertNotIn('restore',runner.calls)
    def test_activation_failure_never_restores_database(self):
        for step in ('main','dev.dona.dispatcher','dev.dona.slack-adapter','dev.dona.updater','health'):
            with self.subTest(step=step):
                runner=FakeRunner(fail=step)
                with self.assertRaises(RuntimeError):runner.execute()
                self.assertTrue(runner.journal['activation_started'])
                self.assertNotIn('restore',runner.calls)
                runner.fail=None;runner.calls=[];runner.execute()
                self.assertEqual(runner.journal['phase'],'succeeded')
                self.assertNotIn('backup',runner.calls);self.assertNotIn('migrate',runner.calls)
    def test_crash_at_migration_intent_resumes_without_replacing_backup(self):
        runner=FakeRunner('migrating');runner.execute()
        self.assertNotIn('backup',runner.calls)
        self.assertIn('migrate',runner.calls)
    def test_completed_run_only_checks_health(self):
        runner=FakeRunner('succeeded');runner.execute()
        self.assertEqual(runner.calls,['health'])
    def test_unknown_phase_is_not_success(self):
        runner=FakeRunner('bogus')
        with self.assertRaisesRegex(RuntimeError,'unknown_phase'):runner.execute()
    def test_failed_seal_before_stop_does_not_stop_services(self):
        runner=FakeRunner(fail='validate')
        with self.assertRaises(RuntimeError):runner.execute()
        self.assertNotIn('stop',runner.calls)

    def test_pre_stop_mcp_probe_failure_keeps_live_services(self):
        runner=FakeRunner(fail='probe')
        with self.assertRaisesRegex(RuntimeError,'probe'):runner.execute()
        self.assertEqual(runner.journal['phase'],'prepared')
        self.assertNotIn('stop',runner.calls);self.assertNotIn('restore',runner.calls)


    def test_stopping_resume_checks_source_and_mcp_before_any_stop(self):
        for step in ('validate_source','probe'):
            runner=FakeRunner('stopping',fail=step)
            with self.assertRaisesRegex(RuntimeError,step):runner.execute()
            self.assertNotIn('stop',runner.calls)
        runner=FakeRunner('stopping');runner.execute()
        self.assertLess(runner.calls.index('validate_source'),runner.calls.index('stop'))
        self.assertLess(runner.calls.index('probe'),runner.calls.index('stop'))


class SourceFreezeTests(unittest.TestCase):
    def test_drift_while_frozen_thaws_and_restores_launchd_without_kill(self):
        runner=FakeRunner('stopping',fail='validate_source')
        runner.live=unittest.mock.Mock();runner.live.domain='gui/fixture';runner.live.observe.return_value=None
        root=proc(800001);table={800001:root};signals=[];commands=[]
        def send(pid,sig):
            signals.append(sig)
            table[pid]['state']='T' if sig == signal.SIGSTOP else 'S'
        def command(argv):
            commands.append(argv)
            return 'disabled services = { "dev.dona.slack-adapter" => disabled }'
        process_stop=m.ProcessStop
        with patch.object(m,'herdr_root',side_effect=lambda _: [copy.deepcopy(root)]), \
             patch.object(m,'herdr_starting',return_value=[]),patch.object(m,'process_table',side_effect=lambda:copy.deepcopy(table)), \
             patch.object(m,'command',side_effect=command),patch.object(m.os,'kill',side_effect=send), \
             patch.object(m,'ProcessStop',side_effect=lambda save:process_stop(save,lambda:copy.deepcopy(table),send)):
            with self.assertRaisesRegex(RuntimeError,'validate_source'):m.Runner.stop(runner,check_source=True)
        self.assertEqual(signals,[signal.SIGSTOP,signal.SIGCONT])
        runner.live.stop.assert_not_called()
        self.assertEqual(runner.journal['phase'],'aborted')
        self.assertEqual(commands[-3:],[[ '/bin/launchctl','disable' if label=='dev.dona.slack-adapter' else 'enable','gui/fixture/'+label] for label in m.LABELS])
        self.assertFalse(runner.journal['processes']);self.assertIsNone(runner.journal['source_stop_guard'])

    def test_crash_during_freeze_is_undone_before_source_preflight(self):
        runner=FakeRunner('stopping',fail='validate_source')
        runner.live=unittest.mock.Mock();runner.live.domain='gui/fixture'
        root=proc(800001,state='T');reused=proc(800002,start='different')
        runner.journal.update(processes=[root,proc(800002)],source_stop_guard={'phase':'freezing','disabled':{label:False for label in m.LABELS}})
        with patch.object(m,'process_table',return_value={800001:root,800002:reused}), \
             patch.object(m.os,'kill') as send,patch.object(m,'command'):
            with self.assertRaisesRegex(RuntimeError,'validate_source'):runner.execute()
        send.assert_called_once_with(800001,signal.SIGCONT)
        self.assertNotIn('stop',runner.calls)
        self.assertEqual(runner.journal['phase'],'aborted')



class MainHealthTests(unittest.TestCase):
    def test_same_session_must_still_be_ready_at_final_health(self):
        runner=FakeRunner();runner.run=Path('/fixture/run');runner.g=Path('/fixture/g')
        runner.node='/fixture/node';runner.plan={'release':'/fixture/release'}
        runner.policy['main_agent']={'name':'dona-main'}
        runner.journal['main']={'pane':'pane','session_id':'session'}
        valid={'exists':True,'matches_release':True,'interactive_ready':True,'name':'dona-main',
               'kind':'codex','status':'working','pane_id':'pane','session_id':'session'}
        for field,value in [('interactive_ready',False),('name','other'),('kind','other'),('status','unknown'),('status',None)]:
            with self.subTest(field=field,value=value),patch.object(m,'command',return_value=m.encode(dict(valid,**{field:value}))):
                with self.assertRaisesRegex(RuntimeError,'main_health_not_confirmed'):runner.verify_main()
        for status in ('idle','done','working','blocked'):
            with patch.object(m,'command',return_value=m.encode(dict(valid,status=status))):runner.verify_main()



class RollbackPreparationTests(unittest.TestCase):
    def test_rollback_stages_current_adapter_with_old_policy_and_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);release=root/'target';run=root/'run';run.mkdir()
            (release/'updater/dist').mkdir(parents=True)
            (release/'updater/dist/adapters.js').write_text('current adapter accepts wBR:p1')
            inv={'policy':{'executables':{'node':'/old/node'},'release_root':'/old/releases'},
                 'old_pointer':'/old/releases/sha',
                 'plists':{'dev.dona.updater':{'WorkingDirectory':'/old/broken-updater'}},
                 'configs':{key:{'values':{'KEEP':'old'}} for key in ('dispatcher','slack')}}
            plan={'release':str(release),'node':'/new/node'}
            with patch.object(m.common,'installed_codex',return_value='/new/codex'),patch.object(m,'command') as command:
                m.prepare_rollback(run,inv,plan)
            staged=run/'rollback/control/updater'
            self.assertFalse(staged.is_symlink())
            self.assertEqual((staged/'dist/adapters.js').read_text(),'current adapter accepts wBR:p1')
            self.assertEqual(m.read_json(run/'rollback/control/policy.json')['release_root'],'/old/releases')
            self.assertIn('/old/releases/sha', (run/'rollback/config/mcp-dispatcher.mjs').read_text())
            self.assertEqual(command.call_args.args[0][0],'/new/node')
            self.assertIn(str(staged/'dist/policy.js'),command.call_args.args[0][3])

    def test_rollback_main_start_uses_current_node_and_adapter_with_old_release(self):
        runner=FakeRunner();runner.run=Path('/fixture/run');runner.g=Path('/fixture/g')
        runner.node='/new/node';runner.inv={'old_pointer':'/old/release','policy':{'executables':{'node':'/old/node'}}}
        runner.policy['executables']={'herdr':'/fixture/herdr'}
        runner.journal['old_main']={'pane':'wBR:p1'}
        runner.ensure_herdr=lambda:None
        responses=[{'exists':False},{'outcome':'started','observation':{'session_id':'new-session'}}]
        with patch.object(m,'command',side_effect=[m.encode(v) for v in responses]) as command:
            m.Runner.start_main(runner,old=True)
        for call in command.call_args_list:
            self.assertEqual(call.args[0],['/new/node','/fixture/run/main_bridge.mjs','/fixture/run/rollback/control'])
            request=m.json.loads(call.kwargs['input'])
            self.assertEqual(request['release'],'/old/release')
            self.assertEqual(request['mcp_root'],'/fixture/run/rollback/config')
        self.assertEqual(request['pane'],'wBR:p1')
        self.assertEqual(runner.journal['old_main']['session_id'],'new-session')


class StartupTests(unittest.TestCase):
    def test_intent_without_server_recovers_for_resume_and_rollback(self):
        for intent in (False, True):
            with tempfile.TemporaryDirectory() as directory:
                runner=FakeRunner();runner.run=Path(directory)
                runner.journal['server_start_intent']=intent
                with patch.object(m,'herdr_root',side_effect=[[],[proc(800001)]]), \
                     patch.object(m,'herdr_starting',return_value=False), patch.object(m.subprocess,'Popen') as start:
                    start.return_value.pid=800001
                    runner.ensure_herdr()
                    start.assert_called_once()
                    self.assertEqual(start.call_args.kwargs['env']['HERDR_CONFIG_PATH'],str(runner.run/'herdr-config.toml'))
                    self.assertEqual(runner.journal['server_pid'],800001)

    def test_live_startup_before_socket_or_pid_record_does_not_spawn_twice(self):
        runner=FakeRunner();runner.journal['server_start_intent']=True
        with patch.object(m,'herdr_root',side_effect=[[],[],[proc(800001)]]), \
             patch.object(m,'herdr_starting',return_value=True), patch.object(m.subprocess,'Popen') as start, \
             patch.object(m.time,'sleep'):
            runner.ensure_herdr()
            start.assert_not_called()

    def test_pending_server_requires_exact_command_and_owner(self):
        rows={800001:proc(800001),800002:proc(800002)}
        result=subprocess.CompletedProcess([],0,stdout='/bin/herdr --session other server')
        with patch.object(m,'process_table',return_value=rows), patch.object(m.subprocess,'run',return_value=result):
            self.assertFalse(m.herdr_starting('/bin/herdr'))
            result.stdout='/bin/herdr --session dona server'
            self.assertTrue(m.herdr_starting('/bin/herdr'))

    def test_dona_pane_rejection_never_disables_launchagents(self):
        runner=FakeRunner()
        with patch.object(m,'herdr_root',side_effect=RuntimeError('run_from_terminal_outside_dona')), \
             patch.object(runner,'switch_disabled') as disable:
            with self.assertRaisesRegex(RuntimeError,'run_from_terminal_outside_dona'):
                m.Runner.stop(runner)
            disable.assert_not_called()


    def test_resume_collects_hung_server_before_restarting(self):
        runner=FakeRunner();runner.live=unittest.mock.Mock()
        runner.live.observe.return_value=None
        root=proc(800001)
        with patch.object(m,'herdr_root',return_value=[]), \
             patch.object(m,'herdr_starting',side_effect=[[root],[]]), \
             patch.object(m,'process_table',return_value={root['pid']:root}), \
             patch.object(m,'ProcessStop') as stop,patch.object(runner,'switch_disabled'):
            m.Runner.stop(runner)
            stop.return_value.stop.assert_called_once()
            self.assertEqual(stop.return_value.stop.call_args.args[0],[root])
            self.assertFalse(runner.journal['server_start_intent'])
        with tempfile.TemporaryDirectory() as directory:
            runner.run=Path(directory)
            with patch.object(m,'herdr_root',side_effect=[[],[root]]), \
                 patch.object(m,'herdr_starting',return_value=[]),patch.object(m.subprocess,'Popen') as start:
                start.return_value.pid=800002
                runner.ensure_herdr()
                start.assert_called_once()

    def test_toolchain_uses_policy_even_with_other_node_first_in_shell(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);trusted=root/'trusted';trusted.mkdir();other=root/'other';other.mkdir()
            for file in (trusted/'node',trusted/'npm',other/'node'):
                file.write_text('#!/bin/sh\n');file.chmod(0o700)
            with patch.dict(os.environ,PATH=str(other)):
                node,npm,env=m.toolchain({'node':str(trusted/'node'),'npm':str(trusted/'npm')})
            self.assertEqual(node,str(trusted/'node'));self.assertEqual(npm,str(trusted/'npm'))
            self.assertEqual(m.shutil.which('node',path=env['PATH']),node)
            self.assertEqual(env['npm_config_engine_strict'],'true')


class RenderTests(unittest.TestCase):
    def test_manifest_and_mcp_follow_the_next_current_pointer(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);g=root/'generation';release=g/'runtime/releases/first'
            (release/'config').mkdir(parents=True);(release/'updater').mkdir()
            (release/'config/release-compatibility.json').write_text('{}')
            (release/'config/update-compatibility-transitions.json').write_text('{"transitions":[]}')
            (release/'release-manifest.json').write_text('first')
            token=root/'token';token.write_text('fixture-token')
            run=root/'run';run.mkdir()
            policy={'executables':{},'dispatcher_internal_token_file':str(token)}
            configs={'dispatcher':{'values':{},'config':{k:'fixture' for k in ('databasePath','resultsDir','jobResultsDir','jobProgressDatabasePath','updateNotificationDatabasePath','socketPath')}},
                     'slack':{'values':{},'config':{k:'fixture' for k in ('healthSocketPath','dispatcherSocketPath')}}}
            inv={'policy':policy,'configs':configs,'plists':{label:{'EnvironmentVariables':{}} for label in m.LABELS}}
            def effective(plist,component):return {'config':dict(configs[component]['config'],buildSha='first')}
            with patch.object(m.common,'installed_codex',return_value='/fixture/codex'), \
                 patch.object(m.common,'target_required_checks',return_value=[]), \
                 patch.object(m.common,'effective_config',side_effect=effective),patch.object(m,'command'):
                m.render(run,{'generation':str(g),'release':str(release),'node':'/fixture/node','target_sha':'first'},inv)
            self.assertNotEqual((g/'control/dispatcher.token').read_bytes(),token.read_bytes())
            self.assertEqual(token.read_text(),'fixture-token')
            self.assertEqual((g/'control/dispatcher.token').stat().st_mode & 0o777,0o600)
            second=g/'runtime/releases/second';second.mkdir();(second/'release-manifest.json').write_text('second')
            (g/'runtime/current').unlink();(g/'runtime/current').symlink_to(second)
            for label,key,component in (('dev.dona.dispatcher','dispatcher','dispatcher'),('dev.dona.slack-adapter','slack','sources/slack')):
                plist=m.plistlib.loads((run/'plists'/(label+'.plist')).read_bytes())
                manifest=Path(plist['EnvironmentVariables']['DONA_RELEASE_MANIFEST_PATH'])
                self.assertEqual(manifest.read_text(),'second')
                wrapper=(g/'config'/('mcp-'+key+'.mjs')).read_text()
                self.assertIn((g/'runtime/current'/component/'dist/mcp/index.js').as_uri(),wrapper)
                self.assertNotIn(str(release),wrapper)


class RestoreTests(unittest.TestCase):
    def fixture(self, root):
        runner=object.__new__(m.Runner)
        runner.run=root
        (root/'rollback').mkdir()
        runner.plan={'rollback_seal':m.common.tree_seal(root/'rollback')}
        runner.inv={'databases':[str(root/'absent')]*4}
        runner.journal={'phase':'migrating','steps':[]}
        runner.stop=lambda:None
        runner.install=lambda **_:None
        runner.start_main=lambda **_:None
        runner.start_service=lambda *_:None
        runner.health=lambda **_:None
        runner.migrate=lambda **_:None
        return runner

    def test_corrupt_backup_is_rejected_before_any_database_is_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);runner=self.fixture(root)
            backup=root/'backup';backup.mkdir()
            source=root/'db';source.write_bytes(b'new-state')
            saved=backup/'db-0';saved.write_bytes(b'old-state')
            m.atomic(backup/'index.json',m.encode([{'source':str(source),'backup':str(saved),'exists':True,'hash':m.common.file_digest(saved)}]))
            runner.journal['backup_index_hash']=m.common.file_digest(backup/'index.json')
            saved.write_bytes(b'corrupted')
            with self.assertRaisesRegex(RuntimeError,'backup_changed'):runner.restore()
            self.assertEqual(source.read_bytes(),b'new-state')

    def test_restore_after_target_activation_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            runner=self.fixture(Path(directory));runner.journal['activation_started']=True
            with self.assertRaisesRegex(RuntimeError,'rollback_after_activation_forbidden'):runner.restore()

    def test_resume_failed_rollback_startup_preserves_new_old_version_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);runner=self.fixture(root)
            runner.journal.update(rollback_activation_started=True,backup_index_hash='would-fail-if-read')
            source=root/'db';source.write_bytes(b'new-data-after-old-service-start')
            runner.restore()
            self.assertEqual(source.read_bytes(),b'new-data-after-old-service-start')
            self.assertEqual(runner.journal['phase'],'rolled_back')

    def test_restore_prepared_run_rejects_before_stopping_even_without_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            runner=self.fixture(Path(directory));runner.journal['phase']='prepared'
            runner.stop=lambda:self.fail('prepared restore stopped live services')
            with self.assertRaisesRegex(RuntimeError,'restore_phase_invalid'):runner.restore()

    def test_restore_without_backup_checks_source_before_stopping(self):
        with tempfile.TemporaryDirectory() as directory:
            runner=self.fixture(Path(directory));runner.journal['phase']='stopped'
            runner.stop=lambda:self.fail('changed source was stopped')
            def changed():raise RuntimeError('source_configuration_changed')
            runner.validate_source=changed
            with self.assertRaisesRegex(RuntimeError,'source_configuration_changed'):runner.restore()

    def test_main_start_failure_preserves_writes_on_rollback_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);runner=self.fixture(root)
            backup=root/'backup';backup.mkdir()
            source=root/'db';source.write_bytes(b'old')
            saved=backup/'db-0';saved.write_bytes(b'old')
            m.atomic(backup/'index.json',m.encode([{'source':str(source),'backup':str(saved),'exists':True,'hash':m.common.file_digest(saved)}]))
            runner.journal['backup_index_hash']=m.common.file_digest(backup/'index.json')
            def start(**_):
                self.assertTrue(runner.journal['rollback_activation_started'])
                source.write_bytes(b'write-after-ambiguous-main-start')
                raise RuntimeError('response_lost')
            runner.start_main=start
            with self.assertRaisesRegex(RuntimeError,'response_lost'):runner.restore()
            runner.start_main=lambda **_:None
            runner.restore()
            self.assertEqual(source.read_bytes(),b'write-after-ambiguous-main-start')



class ActiveRunTests(unittest.TestCase):
    def test_interrupted_run_cannot_be_overwritten_by_another_run(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path,'home',return_value=Path(directory)):
            root=Path(directory);(root/'.dona-maintenance').mkdir()
            first=root/'first';first.mkdir();(first/'plan.json').write_text('{}')
            m.atomic(first/'journal.json',m.encode({'phase':'migrating'}))
            second=root/'second';second.mkdir();(second/'plan.json').write_text('{}')
            m.claim_run(first)
            self.assertEqual(m.active_run(),first)
            with self.assertRaisesRegex(RuntimeError,'未完了'):m.claim_run(second)
            m.atomic(first/'journal.json',m.encode({'phase':'aborted'}))
            self.assertIsNone(m.active_run())
            m.claim_run(second)

    def test_changed_plan_is_not_resumed_implicitly(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path,'home',return_value=Path(directory)):
            root=Path(directory);(root/'.dona-maintenance').mkdir()
            run=root/'run';run.mkdir();(run/'plan.json').write_text('{}')
            m.atomic(run/'journal.json',m.encode({'phase':'stopping'}))
            m.claim_run(run);(run/'plan.json').write_text('{"changed":true}')
            with self.assertRaisesRegex(RuntimeError,'active_run_changed'):m.active_run()

if __name__ == '__main__':unittest.main()

class FreshGenerationTests(unittest.TestCase):
    def test_recreated_source_is_held_before_kill_and_cannot_auto_resume(self):
        for phase in ('stopping','stopped','backed_up','migrating','migrated'):
            runner=FakeRunner(phase);runner.live=unittest.mock.Mock();runner.live.observe.return_value=None
            runner.journal['source_stop_receipt']={'processes':[proc(800001)]}
            new=proc(800002)
            with patch.object(m,'herdr_root',return_value=[new]), patch.object(m,'herdr_starting',return_value=[]), \
                 patch.object(m,'process_table',return_value={new['pid']:new}), patch.object(m,'ProcessStop') as stop, \
                 patch.object(runner,'switch_disabled') as disable:
                with self.assertRaisesRegex(RuntimeError,'source_recreation_requires_reconciliation'):
                    m.Runner.stop(runner)
                stop.assert_not_called();disable.assert_not_called()
            self.assertTrue(runner.journal['source_recreation_detected'])
            self.assertEqual(runner.journal['source_recreation_processes'],[new])
            with self.assertRaisesRegex(RuntimeError,'source_recreation_requires_reconciliation'):runner.execute()
            self.assertNotIn('restore',runner.calls)
            self.assertNotIn('main',runner.calls)

    def test_execute_does_not_restore_after_source_recreation(self):
        runner=FakeRunner('backed_up');runner.live=unittest.mock.Mock();runner.live.observe.return_value=None
        runner.journal['source_stop_receipt']={'processes':[proc(800001)]}
        runner.stop=m.Runner.stop.__get__(runner,m.Runner)
        new=proc(800002)
        with patch.object(m,'herdr_root',return_value=[new]), patch.object(m,'herdr_starting',return_value=[]), \
             patch.object(m,'process_table',return_value={new['pid']:new}):
            with self.assertRaisesRegex(RuntimeError,'source_recreation_requires_reconciliation'):runner.execute()
        self.assertTrue(runner.journal['source_recreation_detected'])
        self.assertNotIn('restore',runner.calls)
        self.assertNotIn('main',runner.calls)

    def test_known_rollback_activation_can_resume_but_unreconciled_source_cannot_restore(self):
        runner=FakeRunner('restoring');runner.live=unittest.mock.Mock();runner.live.observe.return_value=None
        runner.journal.update(source_stop_receipt={'processes':[proc(800001)]},rollback_activation_started=True)
        root=proc(800002)
        with patch.object(m,'herdr_root',side_effect=[[root],[]]), patch.object(m,'herdr_starting',return_value=[]), \
             patch.object(m,'process_table',return_value={root['pid']:root}), patch.object(m,'ProcessStop') as stop, \
             patch.object(runner,'switch_disabled'):
            m.Runner.stop(runner)
            stop.return_value.stop.assert_called_once()
        self.assertNotIn('source_recreation_detected',runner.journal)
        runner.journal['source_recreation_detected']=True
        with self.assertRaisesRegex(RuntimeError,'source_recreation_requires_reconciliation'):m.Runner.restore(runner)

    def test_normal_execution_checks_recreation_after_backup_and_before_activation(self):
        for phase in ('stopped','migrated'):
            runner=FakeRunner(phase);runner.live=unittest.mock.Mock();runner.live.observe.return_value=None
            runner.journal['source_stop_receipt']={'processes':[proc(800001)]}
            root=proc(800002)
            with patch.object(m,'herdr_root',return_value=[root]), patch.object(m,'herdr_starting',return_value=[]):
                with self.assertRaisesRegex(RuntimeError,'source_recreation_requires_reconciliation'):runner.execute()
            self.assertTrue(runner.journal['source_recreation_detected'])
            self.assertNotIn('main',runner.calls)
            self.assertNotIn('migrate',runner.calls)
            self.assertNotIn('restore',runner.calls)

    def test_registered_service_without_pid_is_also_recreation(self):
        runner=FakeRunner('backed_up');runner.live=unittest.mock.Mock()
        runner.live.observe.return_value={'registered':True,'pid':None}
        runner.journal['source_stop_receipt']={'processes':[proc(800001)]}
        with patch.object(m,'herdr_root',return_value=[]), patch.object(m,'herdr_starting',return_value=[]):
            with self.assertRaisesRegex(RuntimeError,'source_recreation_requires_reconciliation'):runner.assert_source_stopped()
        self.assertEqual(runner.journal['source_recreation_services'],list(m.LABELS))

    def test_stopping_resume_keeps_previous_stop_receipt(self):
        runner=FakeRunner('stopping');runner.live=unittest.mock.Mock()
        runner.live.observe.return_value=None
        runner.plan={'bundle':{'herdr-config.toml':'config-hash'}}
        old=proc(800001)
        runner.journal.update(source_stop_guard={'phase':'committed'},source_stop_receipt={'processes':[old]},processes=[])
        with patch.object(m,'herdr_root',return_value=[]), patch.object(m,'herdr_starting',return_value=[]), \
             patch.object(m,'process_table',return_value={}), patch.object(m,'ProcessStop'), patch.object(runner,'switch_disabled'):
            m.Runner.stop(runner,check_source=True)
        self.assertEqual(runner.journal['source_stop_receipt']['processes'],[old])
        self.assertEqual(runner.journal['processes'],[])

    def test_fresh_migration_requires_stop_receipt_and_only_targets_new_paths(self):
        runner=object.__new__(m.Runner)
        runner.plan={'mode':'fresh_generation','release':'/target/release','target_sha':'a'*40}
        runner.g=Path('/new-generation');runner.run=Path('/prepared');runner.node='/node'
        runner.journal={}
        with patch.object(m,'command') as call:
            with self.assertRaisesRegex(RuntimeError,'stop_receipt_required'):runner.migrate()
            call.assert_not_called()
            runner.journal['source_stop_receipt']={'verified_at':'now'}
            runner.migrate()
            request=m.json.loads(call.call_args.kwargs['input'])
            self.assertTrue(request['fresh_generation'])
            self.assertTrue(all(p.startswith('/new-generation/') for p in request['databases']))
            call.reset_mock();runner.migrate(retire_only=True);call.assert_not_called()

    def test_fresh_restore_never_replaces_old_data_or_retires_old_ledger(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);runner=RestoreTests().fixture(root)
            runner.plan['mode']='fresh_generation'
            source=root/'old-db';source.write_bytes(b'old-history')
            runner.inv['databases']=[str(source)]*4
            runner.journal['backup_index_hash']='not-read-because-source-was-not-modified'
            runner.migrate=lambda **_:self.fail('old ledger changed')
            runner.restore()
            self.assertEqual(source.read_bytes(),b'old-history')
            self.assertEqual(runner.journal['phase'],'rolled_back')

    def test_mode_guard_rejects_preserving_old_schema_before_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            release=Path(directory);(release/'config').mkdir()
            m.atomic(release/'config/schema-rollout.json',m.encode({'phase':'fresh_generation','database_schema':4,'online_migration':False}))
            with patch.object(m.common,'NodeDatabase') as db:
                db.return_value.read.return_value=[(3,)]
                with self.assertRaisesRegex(RuntimeError,'fresh_generation_required'):m.validate_mode(release,{'databases':['old']},'node',False)
                m.validate_mode(release,{},'node',True)
                db.return_value.read.return_value=[(4,)]
                m.validate_mode(release,{'databases':['new']},'node',False)

    def test_fresh_render_uses_isolated_state_and_preserves_source_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);g=root/'new';release=g/'runtime/releases/target'
            (release/'updater').mkdir(parents=True);(release/'config').mkdir()
            m.atomic(release/'config/release-compatibility.json',m.encode({'schema_version':1,'app_schema_write':4}))
            m.atomic(release/'config/update-compatibility-transitions.json',m.encode({'transitions':[]}))
            run=root/'run';run.mkdir();(run/'main_bridge.mjs').write_text('fixture')
            inv={'policy':{'executables':{'node':'/old-node','codex':'/old-codex'}},
                 'configs':{key:{'values':{'DONA_DATABASE_PATH':'/old/db'}} for key in ('dispatcher','slack')},
                 'databases':['/old/db'], 'old_results':['/old/results'],
                 'plists':{label:{'EnvironmentVariables':{}} for label in m.LABELS}}
            before=copy.deepcopy(inv)
            with patch.object(m.common,'installed_codex',return_value='/new-codex'),patch.object(m.common,'target_required_checks',return_value=[]),patch.object(m.common,'validate_staging') as validate:
                m.render(run,{'mode':'fresh_generation','generation':str(g),'release':str(release),'node':'/new-node','target_sha':'target'},inv)
                validate.assert_called_once()
            self.assertEqual(inv,before)
            plist=m.plistlib.loads((run/'plists/dev.dona.dispatcher.plist').read_bytes())
            self.assertEqual(plist['EnvironmentVariables']['DONA_DATABASE_PATH'],str(g/'dona.sqlite3'))
            self.assertEqual(plist['EnvironmentVariables']['DONA_JOB_RESULTS_DIR'],str(g/'job-results'))
            self.assertEqual(m.read_json(g/'control/policy.json')['dispatcher_socket'],str(g/'run/d.sock'))
