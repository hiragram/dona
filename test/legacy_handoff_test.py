import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('handoff', Path(__file__).parents[1]/'scripts/maintenance/legacy_handoff.py')
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


class HandoffTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.workspace = self.root/'job_test'
        self.workspace.mkdir()
        def git(*args):
            return subprocess.check_output(['git', '-C', str(self.workspace), *args], stderr=subprocess.DEVNULL)
        self.git = git
        git('init')
        git('config', 'user.name', 'Test')
        git('config', 'user.email', 'test@example.invalid')
        (self.workspace/'tracked').write_text('base\n')
        git('add', '.')
        git('commit', '-m', 'base')

    def test_fingerprint_tracks_staged_unstaged_untracked_without_mutation(self):
        base = h.fingerprint(self.workspace)
        (self.workspace/'tracked').write_text('staged\n')
        self.git('add', '.')
        staged = h.fingerprint(self.workspace)
        self.assertNotEqual(base, staged)
        (self.workspace/'tracked').write_text('unstaged\n')
        unstaged = h.fingerprint(self.workspace)
        self.assertNotEqual(staged, unstaged)
        (self.workspace/'new').write_text('untracked\n')
        before = self.git('status', '--porcelain')
        current = h.fingerprint(self.workspace)
        self.assertEqual(current['untracked'][0]['path'], 'new')
        self.assertEqual(self.git('status', '--porcelain'), before)
        self.assertEqual(current['head'], base['head'])

    def test_untracked_symlink_refused(self):
        (self.workspace/'outside').symlink_to(self.root)
        with self.assertRaisesRegex(RuntimeError, 'untracked_file_unsafe'):
            h.fingerprint(self.workspace)

    def test_identity_and_workspace_drift(self):
        value = {'schema_version': 1, 'repository': 'owner/repo', 'issue_number': 12,
                 'legacy_job_id': 'job_test', 'cutover_run': '/unused', 'cutover_seals': {},
                 'workspace': str(self.workspace), 'workspace_fingerprint': h.fingerprint(self.workspace)}
        p = self.root/h.key('owner/repo', 12)
        p.write_text(json.dumps(value));p.chmod(0o600)
        with patch.object(h, 'verify_cutover'), patch.object(h, 'verify_no_recreation'):
            self.assertTrue(h.inspect(self.root, 'owner/repo', 12, 'job_test')['verified'])
            with self.assertRaisesRegex(RuntimeError, 'identity_mismatch'):
                h.inspect(self.root, 'owner/repo', 12, 'job_other')
            (self.workspace/'tracked').write_text('changed\n')
            with self.assertRaisesRegex(RuntimeError, 'workspace_changed'):
                h.inspect(self.root, 'owner/repo', 12, 'job_test')

    def test_cutover_rejects_live_process_tamper_and_nonfresh(self):
        run = self.root/'run';run.mkdir();(run/'backup').mkdir()
        def save(name, value):
            p=run/name;p.write_text(json.dumps(value));p.chmod(0o600)
            return h.digest(p.read_bytes())
        inventory=save('inventory.json', {'databases':['/old/db-'+str(i) for i in range(4)],'old_results':['/old/results','/old/job-results']})
        entries=[]
        for index in range(4):
            file=run/'backup'/str(index);file.write_bytes(b'old database')
            entries.append({'source':'/old/db-'+str(index),'exists':True,'backup':str(file),'hash':h.digest(file.read_bytes())})
        for index,name in enumerate(('results','job-results')):
            directory=run/'backup'/('results-'+str(index));directory.mkdir()
            entries.append({'directory':True,'source':'/old/'+name,'exists':True,'backup':str(directory),'hash':h.maintenance.tree_seal(directory)})
        backup=save('backup/index.json', entries)
        plan=save('plan.json', {'mode':'fresh_generation','inventory_hash':inventory,'bundle':{'herdr-config.toml':'sealed-config'}})
        receipt={'verified_at':'2026-10-03T12:00:00Z','processes':[{'pid':123,'uid':456,'start':'Sat Oct 3 12:00:00 2026'}],
                 'herdr_session':'dona','herdr_config_sha256':'sealed-config','launch_agents':['dev.dona.dispatcher','dev.dona.slack-adapter','dev.dona.updater']}
        journal={'phase':'succeeded','plan_hash':plan,'backup_index_hash':backup,'source_stop_receipt':receipt,'source_stop_guard':{'phase':'committed'}}
        save('journal.json',journal)
        with patch.object(subprocess,'check_output',return_value=''):
            seals=h.verify_cutover(run)
            self.assertEqual(h.verify_cutover(run,seals),seals)
        with patch.object(subprocess,'check_output',return_value='123 456 Sat Oct 3 12:00:00 2026 S\n'):
            with self.assertRaisesRegex(RuntimeError,'old_process_still_alive'):h.verify_cutover(run,seals)
        changed_result=run/'backup/results-0/changed.json';changed_result.write_text('{}')
        with patch.object(subprocess,'check_output',return_value=''):
            with self.assertRaisesRegex(RuntimeError,'old_result_backup_changed'):h.verify_cutover(run,seals)
        changed_result.unlink()
        for changed in ({'exists':False,'hash':None}, {'source':'/different/db'}):
            original=entries[0].copy();entries[0].update(changed)
            journal['backup_index_hash']=save('backup/index.json',entries);save('journal.json',journal)
            with patch.object(subprocess,'check_output',return_value=''):
                with self.assertRaisesRegex(RuntimeError,'old_database_backup_incomplete'):h.verify_cutover(run)
            entries[0]=original
        journal['backup_index_hash']=save('backup/index.json',entries)
        receipt['processes']=[];save('journal.json',journal)
        with patch.object(subprocess,'check_output',return_value=''):
            h.verify_cutover(run)
            journal['source_stop_guard']['phase']='freezing';save('journal.json',journal)
            with self.assertRaisesRegex(RuntimeError,'cutover_stop_evidence_missing'):h.verify_cutover(run)
        journal['phase']='prepared';save('journal.json',journal)
        with self.assertRaisesRegex(RuntimeError,'cutover_evidence_changed'):h.verify_cutover(run,seals)
        with self.assertRaisesRegex(RuntimeError,'fresh_cutover_not_succeeded'):h.verify_cutover(run)

    def test_untracked_executable_bit_drift(self):
        file=self.workspace/'new.sh';file.write_text('echo example\n');file.chmod(0o644)
        before=h.fingerprint(self.workspace);file.chmod(0o755)
        self.assertNotEqual(before,h.fingerprint(self.workspace))

    def test_new_pid_using_retired_workspace_or_release_is_rejected(self):
        old=Path('/retired/worktree')
        for argv,cwd in [('codex',old),('node /retired/worktree/server.js',Path('/tmp'))]:
            with self.assertRaisesRegex(RuntimeError,'retired_generation_process_running'):
                h.assert_no_retired_process([(9876,os.getuid(),argv)],{9876:cwd},[old],set())
        h.assert_no_retired_process([(9876,os.getuid(),'codex')],{9876:Path('/new/worktree')},[old],set())
        with self.assertRaisesRegex(RuntimeError,'retired_generation_process_running'):
            h.assert_no_retired_process([(9876,os.getuid(),'python')],{9876:old},[old],{9876})

    def test_old_control_root_and_new_cwd_pid_are_checked(self):
        roots=h.retired_roots({'old_pointer':'/old/release','policy':{'control_root':'/old/control'}},'/old/worktree')
        self.assertIn(Path('/old/control'),roots)
        with self.assertRaisesRegex(RuntimeError,'retired_generation_process_running'):
            h.assert_no_retired_process([(9876,os.getuid(),'node /old/control/updater/dist/cli.js')],{9876:Path('/tmp')},roots,set())
        with self.assertRaisesRegex(RuntimeError,'retired_generation_process_running'):
            h.assert_no_retired_process([],{9999:Path('/old/control/updater')},roots,set())

    def test_database_symlink_and_hardlink_alias_are_detected(self):
        old=self.root/'old.sqlite';old.write_bytes(b'db')
        new=self.root/'new.sqlite';new.symlink_to(old)
        with self.assertRaisesRegex(RuntimeError,'database_not_regular'):h.database_identities([new])
        new.unlink();os.link(old,new)
        self.assertTrue(h.database_identities([old]) & h.database_identities([new]))
        with self.assertRaisesRegex(RuntimeError,'database_identity_overlap'):h.database_identities([old,new])
        new.unlink();new.write_bytes(b'new db')
        self.assertFalse(h.database_identities([old]) & h.database_identities([new]))

    def test_record_publication_is_atomic_and_does_not_overwrite(self):
        target=self.root/'record.json'
        with patch.object(os, 'fsync', side_effect=OSError('disk error')):
            with self.assertRaises(OSError):h.publish_record(target, {'a':1})
        self.assertFalse(target.exists())
        h.publish_record(target, {'a':1})
        inode=target.stat().st_ino
        h.publish_record(target, {'a':1})
        self.assertEqual(target.stat().st_ino,inode)
        with self.assertRaisesRegex(RuntimeError,'handoff_record_conflict'):h.publish_record(target, {'a':2})
        self.assertEqual(h.read(target),{'a':1})
        self.assertEqual(list(self.root.glob('.record-*')),[])

    def test_database_lineage_supports_preserve_and_rejects_unrelated_storage(self):
        def save(path,value):
            path.write_text(json.dumps(value));path.chmod(0o600)
            return h.digest(path.read_bytes())
        def seal(run,plan,inventory):
            inventory.setdefault('old_results',[str(self.root/'g1'/name) for name in ('results','job-results')])
            run.mkdir(exist_ok=True)
            plan['inventory_hash']=save(run/'inventory.json',inventory)
            hashed=save(run/'plan.json',plan)
            save(run/'journal.json',{'phase':'succeeded','plan_hash':hashed})
            return {'run':str(run),'plan_hash':hashed}
        seed=self.root/'seed'; generation=self.root/'g1'
        owner=self.root/'owner.json'
        seed_owner=seal(seed,{'mode':'fresh_generation','generation':str(generation)},{})
        save(owner,seed_owner)
        expected=[str(generation/name) for name in ('dona.sqlite3','update-notifications.sqlite3','job-progress.sqlite3','control/updater.sqlite3')]
        self.assertEqual(h.expected_databases(seed,owner),expected)
        alias=self.root/'seed-alias';alias.symlink_to(seed)
        save(owner,{**seed_owner,'run':str(alias)})
        self.assertEqual(h.expected_databases(seed,owner),expected)
        self.assertEqual(h.expected_databases(alias,owner),expected)
        save(owner,seed_owner)
        successor=self.root/'successor'
        plan={'mode':'preserve','generation':str(self.root/'g2'),'previous_offline_run':seed_owner}
        save(owner,seal(successor,plan,{'databases':expected}))
        self.assertEqual(h.expected_databases(seed,owner),expected[:3]+[str(self.root/'g2/control/updater.sqlite3')])
        plan['mode']='fresh_generation';save(owner,seal(successor,plan,{'databases':expected}))
        with self.assertRaisesRegex(RuntimeError,'new_fresh_cutover_requires_inventory'):h.expected_databases(seed,owner)
        plan['mode']='preserve'
        save(owner,seal(successor,plan,{'databases':expected,'old_results':['/old/results','/old/job-results']}))
        with self.assertRaisesRegex(RuntimeError,'offline_lineage_storage_mismatch'):h.expected_databases(seed,owner)
        for index in range(4):
            unrelated=expected.copy();unrelated[index]=str(self.root/'copied-old.sqlite')
            save(owner,seal(successor,plan,{'databases':unrelated}))
            with self.assertRaisesRegex(RuntimeError,'offline_lineage_storage_mismatch'):h.expected_databases(seed,owner)
        save(owner,seal(successor,plan,{'databases':expected}))
        save(successor/'journal.json',{'phase':'prepared','plan_hash':h.digest((successor/'plan.json').read_bytes())})
        with self.assertRaisesRegex(RuntimeError,'offline_lineage_not_terminal'):h.expected_databases(seed,owner)

    def test_rollback_and_abort_lineage_remains_usable_after_next_update(self):
        def write(path,value):
            path.write_text(json.dumps(value));path.chmod(0o600)
            return h.digest(path.read_bytes())
        def run(name,phase,mode,previous,databases):
            root=self.root/name;root.mkdir()
            plan={'mode':mode,'generation':str(root/'g'),'previous_offline_run':previous,
                  'inventory_hash':write(root/'inventory.json',{'databases':databases,'old_results':[str(self.root/'seed/g'/part) for part in ('results','job-results')]})}
            hashed=write(root/'plan.json',plan)
            write(root/'journal.json',{'phase':phase,'plan_hash':hashed})
            return {'run':str(root),'plan_hash':hashed}
        seed=run('seed','succeeded','fresh_generation',None,[])
        owner=self.root/'owner.json';write(owner,seed)
        expected=h.expected_databases(seed['run'],owner)
        previous=seed
        for phase in ('rolled_back','aborted'):
            previous=run(phase,phase,'preserve',previous,expected);write(owner,previous)
            self.assertEqual(h.expected_databases(seed['run'],owner),expected)
        rollback=Path(previous['run'])
        journal=h.read(rollback/'journal.json');journal.update(phase='rolled_back',source_recreation_detected=True)
        write(rollback/'journal.json',journal)
        with self.assertRaisesRegex(RuntimeError,'offline_lineage_not_terminal'):h.expected_databases(seed['run'],owner)
        journal['source_recreation_reconciliation']={'plan_hash':journal['plan_hash'],
            'observation_hash':h.offline.recreation_observation_hash(journal),'effects_reconciled':True,
            'cause_removed':True,'summary':'照合済み','operator_uid':os.getuid()}
        write(rollback/'journal.json',journal)
        self.assertEqual(h.expected_databases(seed['run'],owner),expected)
        successor=run('next','succeeded','preserve',previous,expected);write(owner,successor)
        self.assertEqual(h.expected_databases(seed['run'],owner),expected[:3]+[str(self.root/'next/g/control/updater.sqlite3')])

    def test_result_directories_reject_alias_and_nested_old_storage(self):
        current=[self.root/'new-results',self.root/'new-job-results']
        old=[self.root/'old-results',self.root/'old-job-results']
        for path in current+old:path.mkdir()
        h.verify_result_directories(current,old)
        current[0].rmdir();current[0].symlink_to(old[0])
        with self.assertRaisesRegex(RuntimeError,'result_directory_not_regular'):h.verify_result_directories(current,old)
        current[0].unlink();current[0].mkdir()
        alias=self.root/'alias';alias.symlink_to(old[0])
        nested=alias/'nested';nested.mkdir()
        with self.assertRaisesRegex(RuntimeError,'result_directory_overlap'):h.verify_result_directories([nested,current[1]],old)
        with self.assertRaisesRegex(RuntimeError,'result_directory_overlap'):h.verify_result_directories(current,[alias/'..'/'new-results'])

    def test_generation_root_and_storage_parent_alias_cannot_escape(self):
        generation=self.root/'generation';generation.mkdir()
        outside=self.root/'outside';outside.mkdir()
        (generation/'db').write_bytes(b'new');(outside/'db').write_bytes(b'copied old')
        h.verify_storage_roots([generation/'db'],[generation])
        saved=self.root/'original-generation';generation.rename(saved);generation.symlink_to(outside)
        with self.assertRaisesRegex(RuntimeError,'generation_root_not_regular'):h.verify_storage_roots([generation/'db'],[generation])
        generation.unlink();saved.rename(generation)
        (generation/'control').symlink_to(outside)
        with self.assertRaisesRegex(RuntimeError,'storage_outside_generation'):h.verify_storage_roots([generation/'control/db'],[generation])

    def test_generation_ancestor_alias_is_rejected(self):
        actual=self.root/'actual';actual.mkdir();generation=actual/'generation';generation.mkdir()
        (generation/'db').write_bytes(b'db')
        alias=self.root/'alias';alias.symlink_to(actual)
        with self.assertRaisesRegex(RuntimeError,'generation_root_not_regular'):
            h.verify_storage_roots([alias/'generation/db'],[alias/'generation'])

    def test_more_than_64_preserve_updates_keep_lineage(self):
        def save(path,value):
            path.write_text(json.dumps(value));path.chmod(0o600)
            return h.digest(path.read_bytes())
        seed=self.root/'seed';generation=self.root/'generation'
        databases=[str(generation/name) for name in ('dona.sqlite3','update-notifications.sqlite3','job-progress.sqlite3','control/updater.sqlite3')]
        results=[str(generation/name) for name in ('results','job-results')]
        previous=None
        for index in range(70):
            run=seed if index==0 else self.root/('run-'+str(index));run.mkdir()
            target=generation if index==0 else self.root/('generation-'+str(index))
            inventory=save(run/'inventory.json',{'databases':databases,'old_results':results})
            plan={'mode':'fresh_generation' if index==0 else 'preserve','generation':str(target),
                  'inventory_hash':inventory,'previous_offline_run':previous}
            hashed=save(run/'plan.json',plan)
            save(run/'journal.json',{'phase':'succeeded','plan_hash':hashed})
            previous={'run':str(run),'plan_hash':hashed}
            databases=databases[:3]+[str(target/'control/updater.sqlite3')]
        owner=self.root/'owner.json';save(owner,previous)
        self.assertEqual(h.expected_databases(seed,owner),databases)
        # 循環は件数制限に頼らず拒否する。plan hashの照合より先に再訪を検出する。
        final_plan=h.read(run/'plan.json');final_plan['previous_offline_run']=previous
        hashed=save(run/'plan.json',final_plan);save(run/'journal.json',{'phase':'succeeded','plan_hash':hashed})
        save(owner,{'run':str(run),'plan_hash':hashed})
        with self.assertRaisesRegex(RuntimeError,'offline_lineage_invalid'):h.expected_databases(seed,owner)

    def test_untrusted_file_and_path_rejected(self):
        p=self.root/'record';p.write_text('{}');p.chmod(0o666)
        with self.assertRaisesRegex(RuntimeError,'not_private_or_owned'):h.read(p)
        with self.assertRaisesRegex(RuntimeError,'issue_identity_invalid'):h.key('../../other',1)


if __name__ == '__main__':
    unittest.main()
