#!/usr/bin/env python3
"""Donaの外から実行する、データを保持した停止更新。macOS専用。"""
import argparse
import contextlib
import copy
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import signal
import shlex
import subprocess
import sys
import tarfile
import time

import reset_upgrade as common

LABELS = common.LABELS
require = common.require
atomic = common.atomic
encode = common.encode
read_json = common.read_json
command = common.command


def progress(message):
    print(message, flush=True)


def process_table():
    body = command(['/bin/ps', '-axo', 'pid=,ppid=,uid=,lstart=,stat='])
    table = {}
    for line in body.splitlines():
        fields = line.split()
        require(len(fields) == 9, 'process_table_format')
        pid, parent, uid = map(int, fields[:3])
        table[pid] = {'pid': pid, 'parent': parent, 'uid': uid,
                      'start': ' '.join(fields[3:8]), 'state': fields[8]}
    return table


def same_process(a, b):
    return b is not None and all(a[k] == b[k] for k in ('pid', 'uid', 'start'))


class ProcessStop:
    """親から順に停止してforkを止め、確認済み子孫だけを終了する。"""
    def __init__(self, save, table=process_table, send=os.kill, sleep=time.sleep):
        self.save, self.table, self.send, self.sleep = save, table, send, sleep

    def stop(self, roots, known, before_kill=lambda: None):
        pending = list(roots) + list(known)
        captured = {str(p['pid']): p for p in known}
        visited = set()
        while pending:
            expected = pending.pop(0)
            pid = expected['pid']
            if pid in visited:
                continue
            visited.add(pid)
            now = self.table().get(pid)
            if not same_process(expected, now) or 'Z' in now['state']:
                continue
            require(now['uid'] == os.getuid() and pid not in (1, os.getpid(), os.getppid()), 'process_stop_scope')
            captured[str(pid)] = expected
            self.save(list(captured.values()))  # signalより先。SIGKILLでrunnerが落ちても再開できる。
            self.send(pid, signal.SIGSTOP)
            deadline = time.monotonic() + 5
            while True:
                now = self.table().get(pid)
                if not same_process(expected, now) or any(s in now['state'] for s in ('T', 'Z')):
                    break
                require(time.monotonic() < deadline, 'process_freeze_timeout')
                self.sleep(.05)
            # 親が停止済みなので、この親から新しい子が生まれる窓を閉じて列挙する。
            pending.extend(p for p in self.table().values() if p['parent'] == pid)
        before_kill()  # launchd登録を外してからkillし、KeepAliveによる再生成を止める。
        # 親を最後にkillする。再開時も保存したstart identityを再照合する。
        for expected in reversed(list(captured.values())):
            now = self.table().get(expected['pid'])
            if same_process(expected, now) and 'Z' not in now['state']:
                self.send(expected['pid'], signal.SIGKILL)
        deadline = time.monotonic() + 10
        while True:
            table = self.table()
            if all(not same_process(p, table.get(p['pid'])) or 'Z' in table[p['pid']]['state'] for p in captured.values()):
                return
            require(time.monotonic() < deadline, 'process_exit_timeout')
            self.sleep(.1)


def herdr_root(executable):
    sessions = json.loads(command([executable, 'session', 'list', '--json']))['sessions']
    rows = [s for s in sessions if s['name'] == 'dona']
    require(len(rows) <= 1, 'herdr_session_ambiguous')
    if not rows or not rows[0]['running']:
        return []
    socket = rows[0]['socket_path']
    result = subprocess.run(['/usr/sbin/lsof', '-n', '-a', '-U', '-u', str(os.getuid()), '-F', 'pcn'],
                            capture_output=True, timeout=10)
    require(result.returncode == 0, 'herdr_socket_owner_unknown')
    pid, name, found = None, None, set()
    for line in result.stdout.decode().splitlines():
        if line.startswith('p'):
            pid = int(line[1:])
        elif line.startswith('c'):
            name = line[1:]
        elif line == 'n' + socket and name == 'herdr':
            found.add(pid)
    require(len(found) == 1, 'herdr_socket_owner_ambiguous')
    table = process_table()
    root = table.get(next(iter(found)))
    require(root and root['uid'] == os.getuid(), 'herdr_process_owner')
    # Herdrのforeground clientがserverを保持する構成も同じ停止単位にする。
    parent = table.get(root['parent'])
    if parent:
        args = shlex.split(command(['/bin/ps', '-ww', '-p', str(parent['pid']), '-o', 'command=']))
        if args and Path(args[0]).name == 'herdr' and args[1:] == ['--session', 'dona']:
            root = parent
    # 更新CLIをDona自身のpaneから起動すると、自分も停止対象になるので拒否。
    ancestor = os.getpid()
    while ancestor in table:
        require(ancestor != root['pid'], 'run_from_terminal_outside_dona')
        ancestor = table[ancestor]['parent']
    return [root]


def herdr_starting(executable):
    # socket公開前のserverも照合する。PopenとPID記録の間のcrashでも二重起動しない。
    roots = []
    for process in process_table().values():
        if process['uid'] != os.getuid() or 'Z' in process['state']:
            continue
        result = subprocess.run(['/bin/ps', '-ww', '-p', str(process['pid']), '-o', 'command='],
                                capture_output=True, text=True, timeout=10)
        if result.returncode != 0:  # 観測中に終了したprocess。
            continue
        argv = result.stdout.strip()
        suffix = ' --session dona server'
        if argv.endswith(suffix) and Path(argv[:-len(suffix)]).resolve() == Path(executable).resolve():
            roots.append(process)
    return roots


def toolchain(executables):
    node, npm = executables['node'], executables['npm']
    require(all(Path(p).is_absolute() and os.access(p, os.X_OK) for p in (node, npm)), 'node_npm_missing')
    # npmのshebangと子scriptのnodeもpolicyで固定した実体を使う。
    env = dict(os.environ, PATH=str(Path(node).parent)+os.pathsep+os.environ.get('PATH', ''),
               npm_config_engine_strict='true')
    selected = shutil.which('node', path=env['PATH'])
    require(selected and Path(selected).resolve() == Path(node).resolve(), 'node_path_mismatch')
    return node, npm, env


def fresh(plan):
    return plan.get('mode') == 'fresh_generation'


def fresh_databases(g):
    return [str(g/name) for name in ('dona.sqlite3', 'update-notifications.sqlite3', 'job-progress.sqlite3', 'control/updater.sqlite3')]


def validate_mode(release, inv, node, fresh_generation):
    contract = read_json(release/'config/schema-rollout.json')
    if fresh_generation:
        require(contract.get('phase') == 'fresh_generation' and contract.get('database_schema') == 4, 'fresh_generation_contract_required')
    elif contract.get('online_migration') is False:
        db = common.NodeDatabase(node, release/'updater/node_modules/better-sqlite3/lib/index.js')
        require(db.read(inv['databases'][0], 'PRAGMA user_version') == [(contract['database_schema'],)],
                'fresh_generation_required; --fresh-generationで新しい空DBへの切替を指定してください')


def render(run, plan, inv):
    """code/configを世代分離し、既存DBとResultの絶対pathはそのまま保持する。"""
    g, release = Path(plan['generation']), Path(plan['release'])
    if fresh(plan):
        for name in ('config', 'control', 'logs', 'run', 'results', 'job-results'):
            common.private_dir(g/name)
        inputs = copy.deepcopy(inv)
        inputs['policy']['executables']['node'] = plan['node']
        common.render(run, dict(plan, codex_executable=common.installed_codex()), inputs)
        common.validate_staging(run, plan, plan['node'])
        protected = [Path(p).resolve() for p in inv['databases'] + inv['old_results']]
        for target in [Path(p) for p in fresh_databases(g)] + [g/'results', g/'job-results', g/'run']:
            require(not any(target.resolve() == old or old in target.resolve().parents or target.resolve() in old.parents for old in protected), 'fresh_paths_overlap_source')
        return
    for name in ('config', 'control', 'logs', 'run'):
        common.private_dir(g/name)
    policy = copy.deepcopy(inv['policy'])
    policy.update(control_root=str(g/'control'), config_root=str(g/'config'), release_root=str(g/'runtime/releases'),
                  current_pointer=str(g/'runtime/current'), previous_pointer=str(g/'runtime/previous'))
    policy['executables'].update(node=plan['node'], codex=common.installed_codex())
    policy['compatibility'] = {k: v for k, v in read_json(release/'config/release-compatibility.json').items() if k != 'schema_version'}
    policy['compatibility_transitions'] = read_json(release/'config/update-compatibility-transitions.json')['transitions']
    policy['required_checks'] = common.target_required_checks(release)
    # Updater ledgerは停止後のsnapshotを新controlへ引き継ぐ。
    policy['dispatcher_internal_token_file'] = str(g/'control/dispatcher.token')
    atomic(g/'control/dispatcher.token', (os.urandom(32).hex()+'\n').encode())
    shutil.copytree(release/'updater', g/'control/updater', symlinks=True)
    atomic(g/'control/policy.json', encode(policy))
    os.symlink(release, g/'runtime/current')
    common.private_dir(run/'plists')
    for label in LABELS:
        plist = copy.deepcopy(inv['plists'][label])
        env = plist['EnvironmentVariables']
        if label == 'dev.dona.updater':
            env.update(DONA_UPDATE_POLICY_PATH=str(g/'control/policy.json'), DONA_UPDATER_BUILD_SHA=plan['target_sha'])
            code, entry = g/'control/updater', 'cli.js'
        else:
            key = 'dispatcher' if label == 'dev.dona.dispatcher' else 'slack'
            component = 'dispatcher' if key == 'dispatcher' else 'sources/slack'
            values = dict(inv['configs'][key]['values'])
            values.pop('DOTENV_CONFIG_PATH', None)
            values.pop('DONA_BUILD_SHA', None)
            values.update(DONA_RELEASE_MANIFEST_PATH=str(Path(policy['current_pointer'])/'release-manifest.json'),
                          DONA_CODEX_PATH=policy['executables']['codex'],
                          DONA_UPDATER_SOCKET_PATH=str(g/'control/updater.sock'),
                          DONA_UPDATE_INTERNAL_TOKEN_PATH=policy['dispatcher_internal_token_file'])
            file = g/'config'/(key+'.env')
            atomic(file, common.dotenv(values).encode())
            env.update(values)
            env.pop('DONA_BUILD_SHA', None)
            env['DOTENV_CONFIG_PATH'] = str(file)
            code, entry = g/'runtime/current'/component, 'cli.js' if key == 'dispatcher' else 'index.js'
            wrapper = f'''import fs from 'node:fs';
import {{parse}} from {json.dumps((Path(policy['current_pointer'])/component/'node_modules/dotenv/lib/main.js').as_uri())};
Object.assign(process.env,parse(fs.readFileSync({json.dumps(str(file))})));
delete process.env.DONA_BUILD_SHA;
await import({json.dumps((Path(policy['current_pointer'])/component/'dist/mcp/index.js').as_uri())});
'''
            atomic(g/'config'/('mcp-'+key+'.mjs'), wrapper.encode())
        plist.update(ProgramArguments=[plan['node'], str(code/'dist'/entry)] + ([] if entry == 'index.js' else ['serve']),
                     WorkingDirectory=str(code), StandardOutPath=str(g/'logs'/(label+'.log')),
                     StandardErrorPath=str(g/'logs'/(label+'.error.log')))
        atomic(run/'plists'/(label+'.plist'), plistlib.dumps(plist))
    command([plan['node'], '--input-type=module', '-e',
             f'import {{loadPolicy}} from {json.dumps((release/"updater/dist/policy.js").as_uri())};loadPolicy(process.argv[1]);',
             str(g/'control/policy.json')])
    for component, label in [('dispatcher', 'dev.dona.dispatcher'), ('slack', 'dev.dona.slack-adapter')]:
        config = common.effective_config(plistlib.loads((run/'plists'/(label+'.plist')).read_bytes()), component)['config']
        old = inv['configs'][component]['config']
        keys = ('databasePath', 'resultsDir', 'jobResultsDir', 'jobProgressDatabasePath', 'updateNotificationDatabasePath', 'socketPath') if component == 'dispatcher' else ('healthSocketPath', 'dispatcherSocketPath')
        require(all(config[k] == old[k] for k in keys) and config['buildSha'] == plan['target_sha'], 'rendered_paths_mismatch')



def prepare_rollback(run, inv, plan):
    root = common.private_dir(run/'rollback')
    config = common.private_dir(root/'config')
    control = common.private_dir(root/'control')
    policy = copy.deepcopy(inv['policy'])
    policy['executables']['codex'] = common.installed_codex()
    atomic(control/'policy.json', encode(policy))
    # 復旧対象は旧releaseのまま、main lifecycleの実装は検証済みの新版を使う。
    shutil.copytree(Path(plan['release'])/'updater', control/'updater', symlinks=True)
    command([plan['node'], '--input-type=module', '-e',
             f'import {{loadPolicy}} from {json.dumps((control/"updater/dist/policy.js").as_uri())};loadPolicy(process.argv[1]);',
             str(control/'policy.json')])
    release = Path(inv['old_pointer'])
    for key, component in [('dispatcher', 'dispatcher'), ('slack', 'sources/slack')]:
        values = dict(inv['configs'][key]['values'])
        values.pop('DOTENV_CONFIG_PATH', None)
        file = config/(key+'.env')
        atomic(file, common.dotenv(values).encode())
        wrapper = f'''import fs from 'node:fs';
import {{parse}} from {json.dumps((release/component/'node_modules/dotenv/lib/main.js').as_uri())};
Object.assign(process.env,parse(fs.readFileSync({json.dumps(str(file))})));
await import({json.dumps((release/component/'dist/mcp/index.js').as_uri())});
'''
        atomic(config/('mcp-'+key+'.mjs'), wrapper.encode())


def asset_seal(g):
    return common.digest(encode({name: common.tree_seal(g/name) if (g/name).is_dir() else common.file_digest(g/name)
        for name in ('config', 'control/updater', 'control/policy.json', 'control/dispatcher.token', 'runtime')}))



def build_command(argv, cwd, run, timeout=900, env=None):
    # privateな完全logを保持する。失敗理由を失ったまま同じコマンドを再試行しない。
    descriptor = os.open(run/'prepare.log', os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
    try:
        os.write(descriptor, (common.stamp()+' '+Path(cwd).name+' '+ ' '.join(argv[1:])+'\n').encode())
        child = subprocess.Popen(argv, cwd=cwd, env=env, stdout=descriptor, stderr=descriptor, start_new_session=True)
        try:
            result = child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            table = process_table()
            if child.pid in table:
                ProcessStop(lambda _: None).stop([table[child.pid]], [])
            child.wait(timeout=10)
            raise RuntimeError('build_timeout; prepare.logを確認してください')
        require(result == 0, 'build_failed; prepare.logを確認してください')
    finally:
        os.close(descriptor)

def prepare_herdr_config(run, plan, executable):
    source = Path(os.environ.get('HERDR_CONFIG_PATH', str(Path.home()/'.config/herdr/config.toml')))
    content = source.read_text() if source.exists() else ''
    result = json.loads(command([plan['node'], str(run/'main_bridge.mjs'),
        str(Path(plan['generation'])/'control')],
        input=encode({'action': 'herdr_config', 'source': content})))
    atomic(run/'herdr-config.toml', result['config'].encode())
    command([executable, 'config', 'check'],
            env=dict(os.environ, HERDR_CONFIG_PATH=str(run/'herdr-config.toml')))


def probe_main(run, plan):
    results = json.loads(command([plan['node'], str(run/'main_bridge.mjs'),
        str(Path(plan['generation'])/'control')], input=encode({'action':'probe'}), timeout=120))
    require({row['server'] for row in results if row.get('initialized')} == {'dispatcher','slack'}, 'mcp_probe_failed')


def prepare(run, repository, fresh_generation=False):
    require(not run.exists(), 'run_already_exists')
    common.private_dir(run.parent)
    run.mkdir(mode=0o700)
    for name in ('offline_update.py', 'reset_upgrade.py', 'main_bridge.mjs', 'offline_state.mjs'):
        atomic(run/name, Path(__file__).with_name(name).read_bytes())
    progress('設定を確認しています（サービス停止中でも準備できます）。')
    inv = common.inventory(require_running=False)
    atomic(run/'inventory.json', encode(inv))
    executables = inv['policy']['executables']
    git = executables['git']
    node, npm, build_env = toolchain(executables)
    remote = command([git, '-C', str(repository), 'remote', 'get-url', 'origin'])
    require(remote in (common.REMOTE, common.REMOTE[:-4], 'git@github.com:hiragram/dona.git',
                       'https://github.com/reirei-lab/dona.git', 'git@github.com:reirei-lab/dona.git'), 'repository_scope')
    command([git, '-C', str(repository), 'fetch', 'origin', 'main'], timeout=120)
    sha = command([git, '-C', str(repository), 'rev-parse', 'refs/remotes/origin/main^{commit}'])
    require(re.fullmatch('[0-9a-f]{40}', sha), 'target_sha')
    common.verify_trust(sha, inv['policy'])
    g = Path.home()/'.dona/g'/('offline-'+common.digest(str(run).encode())[:12])
    require(not g.exists(), 'generation_exists')
    for source in inv['old_results']:
        root = Path(source).resolve()
        require(root not in (Path('/'), Path.home()), 'result_directory_scope')
        for protected in (run.resolve(), g.resolve(), Path(inv['old_pointer']), Path(inv['policy']['config_root'])):
            require(root != protected and root not in protected.parents, 'result_directory_overlaps_update')
    release = common.private_dir(g/'runtime/releases'/sha)
    plan = {'schema_version': 1, 'target_sha': sha, 'generation': str(g), 'release': str(release),
            'node': node, 'mode': 'fresh_generation' if fresh_generation else 'preserve', 'created_at': common.stamp(), 'inventory_hash': common.file_digest(run/'inventory.json')}
    common.staging_space(g, inv['policy'])
    archive = run/'source.tar'
    command([git, '-C', str(repository), 'archive', '--format=tar', '-o', str(archive), sha])
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            require(not member.issym() and not member.islnk() and not member.name.startswith('/') and '..' not in Path(member.name).parts, 'archive_path')
        tar.extractall(release)
    archive.unlink()
    common.verify_trust(sha, dict(inv['policy'], required_checks=common.target_required_checks(release)))
    for component in ('dispatcher', 'sources/slack', 'updater'):
        progress(component + ' の依存関係・テスト・型検査・ビルドを確認しています。')
        for args in (['ci'], ['test'], ['run', 'typecheck'], ['run', 'build']):
            common.staging_space(g, inv['policy'])
            build_command([node, npm, *args], release/component, run, env=build_env)
    command([node, str(release/'scripts/write-release-manifest.mjs'), str(release), sha,
             command([node, npm, '--version'], env=build_env), inv['policy']['policy_version']])
    validate_mode(release, inv, node, fresh_generation)
    build_command([node, str(Path(__file__).resolve().parents[2]/'test/offline-state-integration.mjs'), str(release)] + (['--fresh-generation'] if fresh_generation else []), release, run)
    progress('更新用の設定と復旧用の設定を検証しています。')
    render(run, plan, inv)
    probe_main(run, plan)
    prepare_herdr_config(run, plan, inv['policy']['executables']['herdr'])
    prepare_rollback(run, inv, plan)
    common.make_immutable(release)
    common.make_immutable(g/'control/updater')
    plan['rollback_seal'] = common.tree_seal(run/'rollback')
    plan['seal'] = asset_seal(g)
    plan['plists_seal'] = common.tree_seal(run/'plists')
    plan['bundle'] = {name: common.file_digest(run/name) for name in ('offline_update.py', 'reset_upgrade.py', 'main_bridge.mjs', 'offline_state.mjs', 'herdr-config.toml')}
    atomic(run/'plan.json', encode(plan))
    atomic(run/'journal.json', encode({'phase': 'prepared', 'plan_hash': common.file_digest(run/'plan.json'), 'processes': [], 'steps': []}))
    progress('準備完了: ' + sha)
    return plan


class Runner:
    def __init__(self, run):
        self.run = run
        self.plan = read_json(run/'plan.json')
        self.inv = read_json(run/'inventory.json')
        self.journal = read_json(run/'journal.json')
        require(common.file_digest(run/'plan.json') == self.journal['plan_hash'], 'plan_changed')
        require(common.file_digest(run/'inventory.json') == self.plan['inventory_hash'], 'inventory_changed')
        for name, expected in self.plan['bundle'].items():
            require(common.file_digest(run/name) == expected, 'runner_changed')
        require(Path(__file__).resolve() == (run/'offline_update.py').resolve(), 'use_prepared_runner')
        self.live = common.Launchd()
        self.g = Path(self.plan['generation'])
        self.node = self.plan['node']
        self.policy = read_json(self.g/'control/policy.json')

    def record(self, phase=None, **fields):
        if phase:
            self.journal['phase'] = phase
            self.journal['steps'].append({'phase': phase, 'at': common.stamp()})
        self.journal.update(fields)
        atomic(self.run/'journal.json', encode(self.journal))

    def validate(self):
        require(common.tree_seal(self.run/'rollback') == self.plan['rollback_seal'], 'rollback_files_changed')
        require(asset_seal(self.g) == self.plan['seal'], 'staged_files_changed')
        require(common.tree_seal(self.run/'plists') == self.plan['plists_seal'], 'staged_plists_changed')

    def validate_source(self):
        for file, expected in self.inv['files'].items():
            require(common.file_digest(file) == expected, 'source_configuration_changed')
        require(str(Path(self.inv['policy']['current_pointer']).resolve()) == self.inv['old_pointer'], 'source_release_changed')
        if fresh(self.plan):
            database = common.NodeDatabase(self.node, Path(self.plan['release'])/'updater/node_modules/better-sqlite3/lib/index.js')
            rows = database.read(self.inv['databases'][3], "SELECT count(*) FROM update_requests WHERE state NOT IN ('succeeded','failed','rolled_back','needs_review','cancelled','awaiting_approval')")
            require(rows == [(0,)], 'source_update_in_progress')

    def source_preflight(self):
        try:
            self.validate_source()
        except Exception:
            if not self.journal.get('source_stop_guard'):
                self.record('aborted')
            raise

    def undo_source_freeze(self):
        guard = self.journal.get('source_stop_guard')
        require(guard and guard['phase'] == 'freezing', 'source_stop_already_committed')
        # bootout/killより前の凍結だけを取り消す。PID再利用先にはsignalを送らない。
        for expected in reversed(self.journal.get('processes', [])):
            current = process_table().get(expected['pid'])
            if same_process(expected, current) and 'Z' not in current['state']:
                require(current['uid'] == os.getuid(), 'process_thaw_scope')
                os.kill(expected['pid'], signal.SIGCONT)
        for label, disabled in guard['disabled'].items():
            require(label in LABELS, 'launchd_restore_scope')
            command(['/bin/launchctl', 'disable' if disabled else 'enable', self.live.domain+'/'+label])
        self.record(processes=[], source_stop_guard=None)

    def probe(self):
        probe_main(self.run, self.plan)

    def switch_disabled(self, disabled):
        # login/rebootが途中に入ってもLaunchAgentを勝手に起動させない。
        for label in LABELS:
            command(['/bin/launchctl', 'disable' if disabled else 'enable', self.live.domain+'/'+label])

    def stop(self, check_source=False):
        roots = list(herdr_root(self.policy['executables']['herdr']))
        roots.extend(herdr_starting(self.policy['executables']['herdr']))
        table = process_table()
        ancestor = os.getpid()
        while ancestor in table:
            require(all(ancestor != p['pid'] for p in roots), 'run_from_terminal_outside_dona')
            ancestor = table[ancestor]['parent']
        for label in LABELS:
            observation = self.live.observe(label)
            if observation and observation['pid']:
                p = table.get(observation['pid'])
                require(p and p['uid'] == os.getuid(), 'service_process_owner')
                roots.append(p)
        if self.journal.get('source_stop_receipt') and not self.journal.get('activation_started') and roots:
            # 初回停止後の再生成は、その間の外部作用が不明。killして証拠を消さない。
            self.record(source_recreation_detected=True, source_recreation_processes=roots)
            raise RuntimeError('source_recreation_requires_reconciliation')
        if check_source and not self.journal.get('source_stop_guard'):
            listing = command(['/bin/launchctl', 'print-disabled', self.live.domain])
            require('disabled services = {' in listing, 'launchd_disabled_state_unknown')
            states = dict(re.findall(r'"([^"]+)"\s*=>\s*(enabled|disabled|true|false)', listing))
            self.record(source_stop_guard={'phase':'freezing',
                'disabled':{label:states.get(label) in ('disabled','true') for label in LABELS}})
        self.switch_disabled(True)
        def unregister():
            if check_source:
                try:
                    self.validate_source()  # Updaterも凍結済み。ここではまだbootout/killしていない。
                except Exception:
                    if self.journal['source_stop_guard']['phase'] == 'freezing':
                        self.undo_source_freeze()
                        self.record('aborted')
                    raise
                self.record(source_stop_guard={**self.journal['source_stop_guard'], 'phase':'committed'})
            for label in LABELS:
                self.live.stop(label)
        ProcessStop(lambda processes: self.record(processes=processes)).stop(roots, self.journal.get('processes', []), unregister)
        require(not herdr_root(self.policy['executables']['herdr']) and
                not herdr_starting(self.policy['executables']['herdr']), 'herdr_still_running')
        # receipt保存後・phase遷移前のcrashでも、確認済みidentityを空で上書きしない。
        previous = self.journal.get('source_stop_receipt', {}).get('processes', []) if check_source else []
        identities = {(p['pid'], p['uid'], p['start']): p for p in previous + self.journal.get('processes', [])}
        receipt = {'verified_at': common.stamp(), 'processes': list(identities.values()),
                   'launch_agents': list(LABELS), 'herdr_session': 'dona',
                   'herdr_config_sha256': self.plan['bundle']['herdr-config.toml'] if check_source else None}
        for label in LABELS:
            require(self.live.observe(label) is None, 'service_still_registered')
        self.record(processes=[], server_start_intent=False, server_pid=None,
                    **({'source_stop_receipt': receipt} if check_source else {}))

    def backup(self):
        backup = common.private_dir(self.run/'backup')
        size = 0
        for source in self.inv['databases']:
            size += sum(p.stat().st_size for p in (Path(source+suffix) for suffix in ('', '-wal')) if p.exists())
        for source in self.inv['old_results']:
            size += sum(p.lstat().st_size for p in Path(source).rglob('*') if p.is_file() and not p.is_symlink())
        require(shutil.disk_usage(backup).free >= size + self.policy['disk_floor_bytes'], 'backup_disk_space_insufficient')
        db = common.NodeDatabase(self.node, Path(self.plan['release'])/'updater/node_modules/better-sqlite3/lib/index.js')
        entries = []
        for index, source in enumerate(self.inv['databases']):
            destination = backup/('db-'+str(index))
            if destination.exists():
                destination.unlink()  # 未完了backupは停止状態で再作成。
            exists = Path(source).exists()
            if exists:
                common.regular(source)
                db.backup(source, destination)
            entries.append({'source': source, 'backup': str(destination), 'exists': exists,
                            'hash': common.file_digest(destination) if exists else None})
        for index, source in enumerate(self.inv['old_results']):
            destination = backup/('results-'+str(index))
            if destination.exists():
                shutil.rmtree(destination)
            exists = Path(source).exists()
            if exists:
                require(not Path(source).is_symlink() and Path(source).is_dir(), 'result_directory_invalid')
                require(Path(source).resolve() not in (Path('/'), Path.home()), 'result_directory_scope')
                shutil.copytree(source, destination, symlinks=True)
            entries.append({'source': source, 'backup': str(destination), 'exists': exists, 'directory': True,
                            'hash': common.tree_seal(destination) if exists else None})
        atomic(backup/'index.json', encode(entries))
        self.record('backed_up', backup_index_hash=common.file_digest(backup/'index.json'))

    def migrate(self, retire_only=False):
        if fresh(self.plan):
            if retire_only:
                return  # 旧世代のledgerは変更しない。
            require(self.journal.get('source_stop_receipt'), 'fresh_generation_stop_receipt_required')
            request = {'release': self.plan['release'], 'databases': fresh_databases(self.g),
                       'fresh_generation': True, 'run_id': self.run.name, 'target_sha': self.plan['target_sha']}
            env = dict(os.environ, DONA_RELEASE_MANIFEST_PATH=str(Path(self.plan['release'])/'release-manifest.json'))
            command([self.node, str(self.run/'offline_state.mjs')], env=env, input=encode(request), timeout=120)
            return
        databases = list(self.inv['databases'])
        if not retire_only:
            # 常に確定backupから複製するため、migration途中からの再開でも旧ledgerを壊さない。
            databases[3] = str(self.g/'control/updater.sqlite3')
            backup = self.run/'backup/db-3'
            for suffix in ('', '-wal', '-shm'):
                Path(databases[3]+suffix).unlink(missing_ok=True)
            if backup.exists():
                atomic(Path(databases[3]), backup.read_bytes())
            diagnostics = Path(self.inv['policy']['control_root'])/'diagnostics'
            target = self.g/'control/diagnostics'
            if diagnostics.is_dir():
                shutil.copytree(diagnostics, target, symlinks=True, dirs_exist_ok=True)
        request = {'release': self.plan['release'], 'databases': databases,
                   'run_id': self.run.name, 'target_sha': self.plan['target_sha'], 'retire_only': retire_only}
        env = dict(os.environ, DONA_RELEASE_MANIFEST_PATH=str(Path(self.plan['release'])/'release-manifest.json'))
        command([self.node, str(self.run/'offline_state.mjs')], env=env, input=encode(request), timeout=120)

    def install(self, old=False):
        for label in LABELS:
            data = plistlib.dumps(self.inv['plists'][label]) if old else (self.run/'plists'/(label+'.plist')).read_bytes()
            atomic(Path.home()/'Library/LaunchAgents'/(label+'.plist'), data)

    def ensure_herdr(self):
        executable = self.policy['executables']['herdr']
        if herdr_root(executable):
            return
        if not herdr_starting(executable):
            # intentは実行の証拠ではない。不在を再観測できた場合は新しい起動を記録する。
            self.record(server_start_intent=True)
            log = os.open(self.run/'herdr.log', os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
            try:
                child = subprocess.Popen([executable, '--session', 'dona', 'server'], stdin=subprocess.DEVNULL,
                                         stdout=log, stderr=log, start_new_session=True,
                                         env=dict(os.environ, HERDR_CONFIG_PATH=str(self.run/'herdr-config.toml')))
                self.record(server_pid=child.pid)
            finally:
                os.close(log)
        deadline = time.monotonic()+20
        while not herdr_root(executable):
            require(time.monotonic() < deadline, 'herdr_start_not_confirmed')
            time.sleep(.2)

    def start_main(self, old=False):
        self.ensure_herdr()
        release = self.inv['old_pointer'] if old else self.plan['release']
        # 専用serverの起動はHerdr自身の--session起動経路を使う。
        # workspace createは応答不明時に再送せず、journalでpaneを固定する。
        herdr = self.policy['executables']['herdr']
        key = 'old_main' if old else 'main'
        state = self.journal.get(key, {})
        if 'pane' not in state:
            label = 'dona-offline-' + self.run.name + ('-restore' if old else '')
            listing = json.loads(command([herdr, '--session', 'dona', 'workspace', 'list']))
            matches = [w for w in listing['result']['workspaces'] if w['label'] == label]
            require(len(matches) <= 1, 'workspace_identity_ambiguous')
            if matches:
                panes = json.loads(command([herdr, '--session', 'dona', 'pane', 'list', '--workspace', matches[0]['workspace_id']]))
                require(len(panes['result']['panes']) == 1, 'workspace_pane_ambiguous')
                pane = panes['result']['panes'][0]['pane_id']
            else:
                # workspace一覧で不在を確認してから作成。応答喪失時は次回一覧から回収する。
                self.record(**{key: {'create_intent': True}})
                result = json.loads(command([herdr, '--session', 'dona', 'workspace', 'create', '--cwd', release,
                                             '--label', label, '--no-focus'], timeout=30))
                pane = result['result']['root_pane']['pane_id']
            state = {'pane': pane}
            self.record(**{key: state})
        control = self.run/'rollback/control' if old else self.g/'control'
        request = {'action': 'status', 'release': release}
        def bridge(req):
            if old: req['mcp_root'] = str(self.run/'rollback/config')
            return json.loads(command([self.node, str(self.run/'main_bridge.mjs'), str(control)], input=encode(req), timeout=120))
        observed = bridge(request)
        if observed.get('exists'):
            require(observed.get('matches_release') and observed.get('interactive_ready') and
                    observed.get('pane_id') == state['pane'] and observed.get('status') in ('idle', 'done'), 'main_not_ready')
            state['session_id'] = observed['session_id']
            self.record(**{key: state})
            return
        require(not state.get('start_intent'), 'main_start_unknown')
        state['start_intent'] = True
        self.record(**{key: state})
        result = bridge({'action': 'start', 'release': release, 'pane': state['pane']})
        if result['outcome'] == 'rejected':
            state.pop('start_intent')
            self.record(**{key: state})
        require(result['outcome'] == 'started', 'main_start_not_confirmed')
        state['session_id'] = result['observation']['session_id']
        self.record(**{key: state})

    def start_service(self, label):
        command(['/bin/launchctl', 'enable', self.live.domain+'/'+label])
        self.live.start(label, Path.home()/'Library/LaunchAgents'/(label+'.plist'))

    def verify_main(self, old=False):
        control = self.run/'rollback/control' if old else self.g/'control'
        node = self.node
        release = self.inv['old_pointer'] if old else self.plan['release']
        observed = json.loads(command([node, str(self.run/'main_bridge.mjs'), str(control)],
            input=encode({'action': 'status', 'release': release}), timeout=30))
        state = self.journal.get('old_main' if old else 'main', {})
        policy = self.inv['policy'] if old else self.policy
        require(observed.get('exists') and observed.get('matches_release') and
                observed.get('interactive_ready') is True and observed.get('name') == policy['main_agent']['name'] and
                observed.get('kind') == 'codex' and observed.get('status') in ('idle','done','working','blocked') and
                observed.get('pane_id') == state.get('pane') and state.get('session_id') is not None and
                observed.get('session_id') == state['session_id'], 'main_health_not_confirmed')

    def health(self, old=False):
        policy = self.inv['policy'] if old else self.policy
        sha = Path(self.inv['old_pointer']).name if old else self.plan['target_sha']
        for socket, service in ((policy['dispatcher_socket'], 'dispatcher'), (policy['slack_socket'], 'slack_adapter'),
                                (str(Path(policy['control_root'])/'updater.sock'), 'updater')):
            deadline = time.monotonic()+60
            while True:
                try:
                    value = common.http_unix(socket, '/health/version')
                    expected_sha = self.inv['plists']['dev.dona.updater']['EnvironmentVariables']['DONA_UPDATER_BUILD_SHA'] if old and service == 'updater' else sha
                    require(value.get('build_sha') == expected_sha and value.get('status') == 'ready' and value.get('service') == service, 'version_not_ready')
                    if service == 'slack_adapter':
                        require(value.get('workspaces_ready') and value.get('dispatcher_ready'), 'slack_not_connected')
                    break
                except Exception:
                    require(time.monotonic() < deadline, 'health_timeout_'+service)
                    time.sleep(.5)
        self.verify_main(old)  # serviceの起動待ち中にmainが異常化していないか最後に照合。

    def restore(self):
        require(common.tree_seal(self.run/'rollback') == self.plan['rollback_seal'], 'rollback_files_changed')
        require(not self.journal.get('activation_started'), 'rollback_after_activation_forbidden')
        if (self.journal.get('source_stop_guard') or {}).get('phase') == 'freezing':
            self.undo_source_freeze()
        require(self.journal['phase'] in ('stopping','stopped','backed_up','migrating','migrated','installed','main_ready','restoring'), 'restore_phase_invalid')
        if not self.journal.get('backup_index_hash'):
            # backup前の停止失敗だけは、まだ同じ旧設定・DBであることを確認して復旧する。
            require(self.journal['phase'] in ('stopping','stopped','restoring'), 'restore_backup_required')
            self.source_preflight()
        self.record('restoring')
        self.stop()
        index = self.run/'backup/index.json'
        if not fresh(self.plan) and self.journal.get('backup_index_hash') and not self.journal.get('rollback_activation_started'):
            require(common.file_digest(index) == self.journal['backup_index_hash'], 'backup_index_changed')
            entries = read_json(index)
            for item in entries:
                backup = Path(item['backup'])
                if item['exists']:
                    actual = common.tree_seal(backup) if item.get('directory') else common.file_digest(backup)
                    require(actual == item['hash'], 'backup_changed')
            for item in entries:
                source, backup = Path(item['source']), Path(item['backup'])
                if item.get('directory'):
                    if source.exists():
                        shutil.rmtree(source)
                    if item['exists']:
                        shutil.copytree(backup, source, symlinks=True)
                else:
                    for suffix in ('', '-wal', '-shm'):
                        Path(str(source)+suffix).unlink(missing_ok=True)
                    if item['exists']:
                        atomic(source, backup.read_bytes())
        if not fresh(self.plan) and Path(self.inv['databases'][3]).exists():
            self.migrate(retire_only=True)
        self.install(old=True)
        self.journal.pop('old_main', None)
        self.record(rollback_activation_started=True)
        self.start_main(old=True)
        for label in ('dev.dona.dispatcher', 'dev.dona.slack-adapter', 'dev.dona.updater'):
            self.start_service(label)
        self.health(old=True)
        self.record('rolled_back')

    def execute(self):
        phase = self.journal['phase']
        require(not self.journal.get('source_recreation_detected'), 'source_recreation_requires_reconciliation')
        require(phase in ('prepared','stopping','stopped','backed_up','migrating','migrated','installed','main_ready','activating','restarting_target','succeeded','restoring','rolled_back','aborted'), 'unknown_phase')
        if phase == 'succeeded':
            self.health()
            return
        require(phase != 'rolled_back', 'already_rolled_back')
        require(phase != 'aborted', 'source_changed; 新しいrunで更新を準備してください')
        if phase == 'restoring':
            self.restore()
            return
        try:
            if phase == 'stopping' and (self.journal.get('source_stop_guard') or {}).get('phase') == 'freezing':
                self.undo_source_freeze()
            self.validate()
            if phase in ('stopped', 'backed_up', 'migrating', 'migrated'):
                self.stop()  # crash/reboot後もwriter停止を実状態で取り直す。
            if phase in ('installed', 'main_ready'):
                self.stop()
                self.record('installed', main={})
            if phase in ('activating', 'restarting_target'):
                # 前回の起動途中で停止・rebootされても、現データを保持して全体を再起動する。
                self.record('restarting_target', activation_started=True)
                self.stop()
                self.record(main={})
                self.install()
                self.start_main()
                self.record('main_ready')
            if phase == 'prepared':
                self.source_preflight()
                self.probe()
                herdr_root(self.policy['executables']['herdr'])  # 自分が停止対象でないことを先に確認。
                self.record('stopping')
            if self.journal['phase'] == 'stopping':
                if phase == 'stopping':
                    # 停止intent直後のcrashでも、別更新後のサービスを先に止めない。
                    self.source_preflight()
                    self.probe()
                progress('Donaの3サービスと専用Herdrプロセスを停止しています。')
                self.stop(check_source=True)
                self.record('stopped')
            if self.journal['phase'] == 'stopped':
                progress('DBとResultをバックアップしています。')
                self.backup()
            if self.journal['phase'] in ('backed_up', 'migrating'):
                self.record('migrating')
                self.migrate()
                self.record('migrated')
            if self.journal['phase'] == 'migrated':
                self.install()
                self.record('installed')
            if self.journal['phase'] == 'installed':
                progress('新しいmain agentとMCPを起動しています。')
                # mainの必須MCPにも書き込み権限がある。起動応答を失っても巻き戻さない。
                self.record(activation_started=True)
                self.start_main()
                self.record('main_ready')
            if self.journal['phase'] in ('main_ready', 'activating'):
                # Dispatcherの起動だけでもschedule/jobが動く。この後はDBを巻き戻さない。
                self.record('activating', activation_started=True)
                progress('新しいサービスを起動し、バージョンとSlack接続を確認しています。')
                for label in ('dev.dona.dispatcher', 'dev.dona.slack-adapter', 'dev.dona.updater'):
                    self.start_service(label)
                self.health()
                self.record('succeeded')
        except Exception as error:
            self.record(error=type(error).__name__ + ': ' + str(error))
            # 受付開始後は新データを保ち、同じrunで前進復旧する。
            if self.journal.get('source_recreation_detected'):
                progress('旧世代processの再生成を検出しました。副作用の照合が必要なため切替・自動復旧を保留します。')
            elif self.journal.get('activation_started'):
                progress('起動確認に失敗しました。データを保持しています。同じrunのresumeで再確認できます。')
            elif self.journal['phase'] not in ('prepared', 'stopping', 'aborted'):
                progress('起動前の失敗のため、バックアップから復元します。')
                self.restore()
            raise



def active_run():
    file = Path.home()/'.dona-maintenance/offline-active.json'
    if not file.exists():
        return None
    owner = read_json(common.regular(file))
    run = Path(owner['run'])
    require(run.is_absolute() and common.file_digest(common.regular(run/'plan.json')) == owner['plan_hash'], 'active_run_changed')
    journal = read_json(common.regular(run/'journal.json'))
    if journal['phase'] in ('succeeded', 'rolled_back', 'aborted'):
        return None
    return run


def claim_run(run):
    active = active_run()
    require(active is None or active == run, '別の停止更新が未完了です。./scripts/dona-update resumeで既存runを再開してください')
    atomic(Path.home()/'.dona-maintenance/offline-active.json',
           encode({'run': str(run), 'plan_hash': common.file_digest(run/'plan.json')}))

def main():
    parser = argparse.ArgumentParser(description='Dona停止更新CLI。Donaの外のターミナルで実行してください。')
    parser.add_argument('action', choices=('update', 'prepare', 'resume', 'status', 'restore'))
    parser.add_argument('--run', type=Path)
    parser.add_argument('--fresh-generation', action='store_true', help='旧履歴を保全し、独立した空DBへ切り替える')
    parser.add_argument('--repository', type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    require(sys.platform == 'darwin' and os.getuid() != 0, 'macos_gui_user_required')
    require(not args.fresh_generation or args.action in ('prepare', 'update'), 'fresh_mode_only_on_prepare')
    previous = active_run() if args.run is None else None
    if args.action == 'update' and previous:
        require(not args.fresh_generation or fresh(read_json(previous/'plan.json')), 'active_run_mode_mismatch')
        progress('未完了の停止更新を同じrunから再開します。')
        os.execv(sys.executable, [sys.executable, str(previous/'offline_update.py'), 'resume', '--run', str(previous)])
    run = args.run or previous or Path.home()/'.dona-maintenance'/('offline-'+time.strftime('%Y%m%d-%H%M%S'))
    require(run.is_absolute(), 'absolute_run_required')
    if args.action == 'status':
        journal = read_json(run/'journal.json')
        print(json.dumps({'phase': journal['phase'], 'target_sha': read_json(run/'plan.json')['target_sha'],
                          'error': journal.get('error')}, ensure_ascii=False))
        return
    if args.action in ('prepare', 'update'):
        # prepare中も既存maintenanceとの競合を防ぐ。外部online updaterは停止直前に照合。
        common.private_dir(run.parent)
        require(not run.exists(), 'run_already_exists')
        with open(common.private_dir(Path.home()/'.dona-maintenance')/'service.lock', 'a') as lock:
            common.fcntl.flock(lock, common.fcntl.LOCK_EX | common.fcntl.LOCK_NB)
            require(active_run() is None, 'another_offline_run_active')
            prepare(run, args.repository.resolve(), args.fresh_generation)
        progress('再開コマンド: python3 ' + str(run/'offline_update.py') + ' resume --run ' + str(run))
        if args.action == 'prepare':
            return
        os.execv(sys.executable, [sys.executable, str(run/'offline_update.py'), 'resume', '--run', str(run)])
    require(args.run is not None or previous is not None, 'run_required')
    if Path(__file__).resolve() != (run/'offline_update.py').resolve():
        os.execv(sys.executable, [sys.executable, str(run/'offline_update.py'), args.action, '--run', str(run)])
    with common.locked(run):
        runner = Runner(run)
        claim_run(run)
        if args.action == 'restore':
            runner.restore()
        else:
            runner.execute()
        progress(runner.journal['phase'] + ': ' + runner.plan['target_sha'])


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('停止更新に失敗しました: ' + str(error), file=sys.stderr)
        sys.exit(1)
