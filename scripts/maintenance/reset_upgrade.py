#!/usr/bin/env python3
"""Dona専用の独立保守runner。通常self-updateの承認・停止証明とは別契約。"""
import argparse
import contextlib
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import time
import urllib.parse

LABELS = ('dev.dona.updater', 'dev.dona.slack-adapter', 'dev.dona.dispatcher')
START = ('dev.dona.updater', 'dev.dona.dispatcher', 'dev.dona.slack-adapter')
TERMINAL = ('completed', 'failed', 'cancelled')
REMOTE = 'https://github.com/hiragram/dona.git'


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def stamp():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(file):
    h = hashlib.sha256()
    with open(file, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def verify_trust(sha, policy):
    require(re.fullmatch('[0-9a-f]{40}', sha), 'trust_sha')
    gh = policy['executables']['gh']
    route = 'repos/hiragram/dona/commits/' + sha
    pages = json.loads(command([gh, 'api', '--method', 'GET', route+'/check-runs?per_page=100', '--paginate', '--slurp']))
    runs = [run for page in pages for run in page['check_runs']]
    accepted = []
    for name in policy['required_checks']:
        matches = [r for r in runs if r.get('name') == name and r.get('app', {}).get('slug') == 'github-actions' and r.get('head_sha') == sha]
        require(bool(matches), 'required_check_missing')
        latest = max(matches, key=lambda r: r['id'])
        require(latest.get('status') == 'completed' and latest.get('conclusion') == 'success', 'required_check_not_success')
        accepted.append({'name': name, 'id': latest['id']})
    if policy['require_verified_signature']:
        commit = json.loads(command([gh, 'api', '--method', 'GET', route]))
        require(commit.get('sha') == sha and commit.get('commit', {}).get('verification', {}).get('verified') is True, 'signature_not_verified')
    return {'sha': sha, 'checks': accepted, 'signature_required': policy['require_verified_signature'], 'checked_at': stamp()}


def encode(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def atomic(file, data):
    file = Path(file)
    temporary = file.with_name(file.name + '.tmp')
    if temporary.exists() or temporary.is_symlink():
        regular(temporary)
        temporary.unlink()  # 前回crashの未公開write。canonical fileが確定state。
    with open(temporary, 'xb') as out:
        os.chmod(temporary, 0o600)
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temporary, file)
    fd = os.open(file.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read_json(file):
    return json.loads(Path(file).read_text())


def command(argv, cwd=None, env=None, timeout=60):
    # コマンド出力にはsecretが含まれ得るので例外・journalへ転載しない。
    result = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, timeout=timeout)
    require(result.returncode == 0, 'command_failed: ' + Path(argv[0]).name)
    return result.stdout.decode().strip()


def private_dir(p):
    p = Path(p)
    p.mkdir(parents=True, exist_ok=True, mode=0o700)
    require(not p.is_symlink() and p.stat().st_uid == os.getuid(), 'directory_owner')
    os.chmod(p, 0o700)
    return p


def regular(p):
    p = Path(p)
    require(p.is_file() and not p.is_symlink() and p.stat().st_uid == os.getuid(), 'file_owner')
    return p


class NodeDatabase:
    """Donaと同じSQLite/VFSでWALを読む。Python/macOSの別VFSを混在させない。"""
    def __init__(self, node, module):
        self.node, self.module = node, Path(module).as_uri()

    def invoke(self, source, operation, args):
        script = f'''import Database from {json.dumps(self.module)};
const [source,operation,encoded]=process.argv.slice(1);
const args=JSON.parse(encoded);
const db=new Database(source,{{readonly:true,fileMustExist:true}});
try {{
  if(operation==='read') console.log(JSON.stringify(db.prepare(args.sql).raw().all(...args.values)));
  else {{
    const start=Date.now();
    await db.backup(args.destination,{{progress:()=>{{if(Date.now()-start>60000)throw Error('backup_timeout');return 256;}}}});
    const snapshot=new Database(args.destination,{{readonly:true,fileMustExist:true}});
    try {{if(snapshot.pragma('integrity_check',{{simple:true}})!=='ok')throw Error('backup_integrity');}}finally{{snapshot.close();}}
  }}
}} finally {{db.close();}}
'''
        return command([self.node, '--input-type=module', '-e', script, str(source), operation, json.dumps(args)], timeout=75)

    def read(self, file, sql, args=()):
        return [tuple(row) for row in json.loads(self.invoke(file, 'read', {'sql': sql, 'values': args}))]

    def backup(self, source, destination):
        self.invoke(source, 'backup', {'destination': str(destination)})


def http_unix(socket_path, route):
    conn = http.client.HTTPConnection('localhost', timeout=3)
    conn.sock = socket.socket(socket.AF_UNIX)
    conn.sock.settimeout(3)
    try:
        conn.sock.connect(str(socket_path))
        conn.request('GET', route)
        response = conn.getresponse()
        require(response.status == 200, 'health_not_ready')
        return json.loads(response.read(1024 * 1024))
    finally:
        conn.close()


class Launchd:
    def __init__(self):
        self.domain = 'gui/' + str(os.getuid())

    def observe(self, label):
        require(label in LABELS, 'label_scope')
        r = subprocess.run(['/bin/launchctl', 'print', self.domain + '/' + label], capture_output=True, timeout=5)
        if r.returncode != 0:
            # 他のエラー（権限やdomain不在）を未登録と取り違えない。
            require(b'Could not find service' in r.stderr, 'launchd_observation_unknown')
            return None
        body = r.stdout.decode()
        pid = re.search(r'^\s*pid = (\d+)$', body, re.M)
        return {'pid': int(pid[1]) if pid else None, 'registered': True}

    def stop(self, label):
        if self.observe(label) is None:
            return
        subprocess.run(['/bin/launchctl', 'bootout', self.domain + '/' + label], capture_output=True, timeout=40)
        deadline = time.monotonic() + 35
        consecutive = 0
        while time.monotonic() < deadline:
            consecutive = consecutive + 1 if self.observe(label) is None else 0
            if consecutive >= 3:
                return
            time.sleep(.2)
        raise RuntimeError('service_stop_unconfirmed')

    def start(self, label, plist):
        if self.observe(label) is None:
            # 受理不明でも再送せずprint/healthにより照合する。
            try:
                subprocess.run(['/bin/launchctl', 'bootstrap', self.domain, str(plist)], capture_output=True, timeout=35)
            except subprocess.TimeoutExpired:
                pass
        require(self.observe(label) is not None, 'service_start_unconfirmed')

    def process(self, pid):
        r = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'uid=', '-o', 'lstart=', '-o', 'command='], capture_output=True, timeout=5)
        if r.returncode == 1:
            return None
        require(r.returncode == 0, 'process_observation_unknown')
        return r.stdout.decode().strip()


def effective_config(plist, component):
    env = dict(plist.get('EnvironmentVariables', {}))
    cwd = Path(plist['WorkingDirectory']).resolve()
    node = plist['ProgramArguments'][0]
    module = 'config' if component == 'dispatcher' else 'adapter-config'
    method = 'loadConfig' if component == 'dispatcher' else 'loadAdapterConfig'
    script = f'''import fs from 'node:fs';
import {{parse}} from {json.dumps((cwd/'node_modules/dotenv/lib/main.js').as_uri())};
import {{{method}}} from {json.dumps((cwd/'dist'/ (module+'.js')).as_uri())};
const input=JSON.parse(process.argv[1]);
const values={{...parse(fs.readFileSync(input.DOTENV_CONFIG_PATH)),...input}};
console.log(JSON.stringify({{config:{method}(values),values}}));'''
    return json.loads(command([node, '--input-type=module', '-e', script, json.dumps(env)], cwd=cwd))


def inventory():
    home = Path.home()
    plists = {}
    files = {}
    live = Launchd()
    observations = {}
    for label in LABELS:
        p = regular(home/'Library/LaunchAgents'/ (label+'.plist'))
        plists[label] = plistlib.loads(p.read_bytes())
        require(plists[label]['Label'] == label, 'plist_label_mismatch')
        files[str(p)] = digest(p.read_bytes())
        observation = live.observe(label)
        require(observation and observation['pid'], 'source_service_not_running')
        process = live.process(observation['pid'])
        args = plists[label]['ProgramArguments']
        require(process and process.split()[0] == str(os.getuid()) and args[1] in process, 'service_process_owner')
        observations[label] = {**observation, 'identity_hash': digest(process.encode())}
    configs = {c: effective_config(plists['dev.dona.'+label], c) for c, label in [('dispatcher', 'dispatcher'), ('slack', 'slack-adapter')]}
    policy_path = regular(plists['dev.dona.updater']['EnvironmentVariables']['DONA_UPDATE_POLICY_PATH'])
    policy = read_json(policy_path)
    require(policy['repository'] == 'hiragram/dona' and policy['canonical_remote'] == REMOTE, 'policy_scope')
    d = configs['dispatcher']['config']
    s = configs['slack']['config']
    require(d['herdrSession'] == 'dona' and d['socketPath'] == s['dispatcherSocketPath'], 'runtime_scope')
    for component in configs.values():
        p = regular(component['values']['DOTENV_CONFIG_PATH'])
        files[str(p)] = digest(p.read_bytes())
    files[str(policy_path)] = digest(policy_path.read_bytes())
    # tokenは保存するが出力しない。新世代ではrotateして旧MCPによる内部通知を拒否する。
    token = regular(d['updateInternalTokenPath'])
    files[str(token)] = digest(token.read_bytes())
    pointer = Path(policy['current_pointer'])
    require(pointer.is_symlink(), 'current_pointer_not_symlink')
    return {'plists': plists, 'configs': configs, 'policy': policy, 'files': files,
            'old_pointer': str(pointer.resolve()), 'services': observations,
            'databases': [d['databasePath'], d['updateNotificationDatabasePath'], d['jobProgressDatabasePath'],
                          str(Path(policy['control_root'])/'updater.sqlite3')],
            'old_results': [d['resultsDir'], d['jobResultsDir']], 'captured_at': stamp()}


def prepare(run, repository, event_id, job_id):
    require(re.fullmatch(r'evt_[0-9A-HJKMNP-TV-Z]{26}', event_id, re.I), 'event_id')
    require(re.fullmatch(r'job_[0-9a-hjkmnp-tv-z]{26}', job_id, re.I), 'job_id')
    require(not run.exists(), 'run_already_exists')
    run.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    run.mkdir(mode=0o700)  # exclusive prepare
    atomic(run/'runner.py', Path(__file__).read_bytes())
    inv = inventory()
    atomic(run/'inventory.json', encode(inv))
    sha = command(['gh', 'api', 'repos/hiragram/dona/git/ref/heads/main', '--jq', '.object.sha'])
    require(re.fullmatch('[0-9a-f]{40}', sha), 'canonical_sha')
    require(command(['git', '-C', str(repository), 'remote', 'get-url', 'origin']) in (REMOTE, REMOTE[:-4]), 'remote_scope')
    command(['git', '-C', str(repository), 'fetch', 'origin', 'main'])
    require(command(['git', '-C', str(repository), 'rev-parse', 'origin/main']) == sha, 'main_drift')
    trust = verify_trust(sha, inv['policy'])
    generation = private_dir(Path.home()/'.dona/g'/digest(str(run).encode())[:12])
    require(not list(generation.iterdir()), 'generation_not_empty')
    release = private_dir(generation/'runtime/releases'/sha)
    archive = run/'source.tar'
    command(['git', '-C', str(repository), 'archive', '--format=tar', '-o', str(archive), sha])
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            require(not member.issym() and not member.islnk() and not member.name.startswith('/') and '..' not in Path(member.name).parts, 'archive_path')
        tar.extractall(release)
    archive.unlink()
    npm = inv['policy']['executables']['npm']
    node = inv['policy']['executables']['node']
    for component in ('dispatcher', 'sources/slack', 'updater'):
        command([npm, 'ci'], cwd=release/component, timeout=900)
        command([npm, 'run', 'build'], cwd=release/component, timeout=180)
    command([node, str(release/'scripts/write-release-manifest.mjs'), str(release), sha,
             command([npm, '--version']), inv['policy']['policy_version']])
    for p in ('config', 'control', 'results', 'job-results', 'run', 'logs'):
        private_dir(generation/p)
    # updaterはcontrol_root/updater.sock固定なので長いUNIX socket pathを準備段階で拒否。
    require(len(str(generation/'control/updater.sock').encode()) < 104, 'socket_path_too_long')
    plan = {'schema_version': 1, 'trust': trust, 'target_sha': sha, 'generation': str(generation), 'release': str(release),
            'event_id': event_id, 'job_id': job_id, 'inventory_sha256': digest((run/'inventory.json').read_bytes()),
            'runner_sha256': digest((run/'runner.py').read_bytes()),
            'created_at': stamp(), 'strategy': 'isolated_generation', 'operator_assertion_required': True}
    render(run, plan, inv)
    validate_staging(run, plan, node)
    migrate(plan, node)
    # staging成果全体をseal。node_modulesを含め、prepare後の変更を停止前に検知する。
    plan['generation_seal'] = tree_seal(generation)
    plan['plists_seal'] = tree_seal(run/'plists')
    plan['static_seal'] = static_seal(generation)
    atomic(run/'plan.json', encode(plan))
    atomic(run/'journal.json', encode({'phase': 'prepared', 'plan_sha256': digest((run/'plan.json').read_bytes()), 'steps': []}))
    return plan


def tree_seal(root):
    h = hashlib.sha256()
    for p in sorted(Path(root).rglob('*')):
        h.update(str(p.relative_to(root)).encode() + b'\0')
        h.update(str(p.lstat().st_mode & 0o777).encode() + b'\0')
        if p.is_symlink():
            h.update(b'L' + os.readlink(p).encode())
        elif p.is_file():
            h.update(file_digest(p).encode())
    return h.hexdigest()


def static_seal(generation):
    h = hashlib.sha256()
    for name in ('config', 'control/updater', 'control/policy.json', 'control/dispatcher.token', 'runtime'):
        p = Path(generation)/name
        h.update(name.encode())
        h.update(str(p.lstat().st_mode & 0o777).encode() + b'\0')
        if p.is_dir() and not p.is_symlink():
            h.update(tree_seal(p).encode())
        elif p.is_file() and not p.is_symlink():
            h.update(file_digest(p).encode())
        else:
            raise RuntimeError('static_asset_missing')
    return h.hexdigest()


def dotenv(values):
    lines = []
    for key, value in values.items():
        require(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key), 'dotenv_key')
        value = str(value)
        quote = next((q for q in ("'", '`', '"') if q not in value and (q != '"' or '\\' not in value)), None)
        require(quote is not None and '\x00' not in value, 'dotenv_value_unrepresentable')
        lines.append(key + '=' + quote + value + quote + '\n')
    return ''.join(lines)


def render(run, plan, inv):
    g = Path(plan['generation'])
    release = Path(plan['release'])
    policy = dict(inv['policy'])
    policy.update(control_root=str(g/'control'), config_root=str(g/'config'), release_root=str(g/'runtime/releases'),
                  current_pointer=str(g/'runtime/current'), previous_pointer=str(g/'runtime/previous'),
                  dispatcher_socket=str(g/'run/d.sock'), slack_socket=str(g/'run/s.sock'),
                  dispatcher_internal_token_file=str(g/'control/dispatcher.token'))
    compatibility = read_json(release/'config/release-compatibility.json')
    policy['compatibility'] = {k: v for k, v in compatibility.items() if k != 'schema_version'}
    policy['compatibility_transitions'] = read_json(release/'config/update-compatibility-transitions.json')['transitions']
    # stable updater自身を通常release retentionの削除対象へ置かない。
    shutil.copytree(release/'updater', g/'control/updater', symlinks=True)
    atomic(g/'control/policy.json', encode(policy))
    atomic(g/'control/dispatcher.token', (os.urandom(32).hex()+'\n').encode())
    overrides = {'DONA_DATABASE_PATH': str(g/'dona.sqlite3'), 'DONA_RESULTS_DIR': str(g/'results'),
                 'DONA_JOB_RESULTS_DIR': str(g/'job-results'), 'DONA_JOB_PROGRESS_DATABASE_PATH': str(g/'job-progress.sqlite3'),
                 'DONA_UPDATE_NOTIFICATION_DATABASE_PATH': str(g/'update-notifications.sqlite3'),
                 'DONA_SOCKET_PATH': policy['dispatcher_socket'], 'SLACK_HEALTH_SOCKET_PATH': policy['slack_socket'],
                 'DONA_UPDATER_SOCKET_PATH': str(g/'control/updater.sock'),
                 'DONA_UPDATE_INTERNAL_TOKEN_PATH': policy['dispatcher_internal_token_file'],
                 'DONA_RELEASE_MANIFEST_PATH': str(g/'runtime/current/release-manifest.json')}
    private_dir(run/'plists')
    for label in LABELS:
        plist = dict(inv['plists'][label])
        env = dict(plist['EnvironmentVariables'])
        if label == 'dev.dona.updater':
            env['DONA_UPDATE_POLICY_PATH'] = str(g/'control/policy.json')
            env['DONA_UPDATER_BUILD_SHA'] = plan['target_sha']
            component, entry = 'updater', 'cli.js'
        else:
            key = 'dispatcher' if label == 'dev.dona.dispatcher' else 'slack'
            component, entry = ('dispatcher', 'cli.js') if key == 'dispatcher' else ('sources/slack', 'index.js')
            values = dict(inv['configs'][key]['values'])
            values.update(overrides)
            values.pop('DONA_BUILD_SHA', None)
            values.pop('DOTENV_CONFIG_PATH', None)
            # 通常updaterのmain MCPもこの世代固有envを読む。
            body = dotenv(values)
            atomic(g/'config'/ (key+'.env'), body.encode())
            env.update(overrides)
            env.pop('DONA_BUILD_SHA', None)
            env['DOTENV_CONFIG_PATH'] = str(g/'config'/ (key+'.env'))
        plist['EnvironmentVariables'] = env
        code_root = g/'control/updater' if label == 'dev.dona.updater' else g/'runtime/current'/component
        plist['ProgramArguments'] = [inv['policy']['executables']['node'], str(code_root/'dist'/entry)] + ([] if entry == 'index.js' else ['serve'])
        plist['WorkingDirectory'] = str(code_root)
        plist['StandardOutPath'] = str(g/'logs'/ (label+'.log'))
        plist['StandardErrorPath'] = str(g/'logs'/ (label+'.error.log'))
        atomic(run/'plists'/ (label+'.plist'), plistlib.dumps(plist))
    os.symlink(release, g/'runtime/current')


def validate_staging(run, plan, node):
    g = Path(plan['generation'])
    configs = {}
    for component, label in [('dispatcher', 'dev.dona.dispatcher'), ('slack', 'dev.dona.slack-adapter')]:
        configs[component] = effective_config(plistlib.loads((run/'plists'/(label+'.plist')).read_bytes()), component)['config']
    d, s = configs['dispatcher'], configs['slack']
    expected = {'databasePath': g/'dona.sqlite3', 'resultsDir': g/'results', 'jobResultsDir': g/'job-results',
                'jobProgressDatabasePath': g/'job-progress.sqlite3', 'updateNotificationDatabasePath': g/'update-notifications.sqlite3',
                'socketPath': g/'run/d.sock', 'slackAdapterSocketPath': g/'run/s.sock',
                'updaterSocketPath': g/'control/updater.sock', 'updateInternalTokenPath': g/'control/dispatcher.token'}
    require(all(d[key] == str(value) for key, value in expected.items()), 'generated_state_paths')
    require(s['dispatcherSocketPath'] == d['socketPath'] and s['healthSocketPath'] == d['slackAdapterSocketPath'] and s['updateInternalTokenPath'] == d['updateInternalTokenPath'], 'generated_slack_paths')
    require(d['buildSha'] == plan['target_sha'] and s['buildSha'] == plan['target_sha'], 'generated_build_sha')
    module = (Path(plan['release'])/'updater/dist/policy.js').as_uri()
    command([node, '--input-type=module', '-e', f'import {{loadPolicy}} from {json.dumps(module)};loadPolicy(process.argv[1]);', str(g/'control/policy.json')])


def migrate(plan, node):
    g, release = Path(plan['generation']), Path(plan['release'])
    modules = [('dispatcher', 'database', 'DispatcherDatabase', g/'dona.sqlite3'),
               ('dispatcher', 'update-notification', 'UpdateNotificationDatabase', g/'update-notifications.sqlite3'),
               ('dispatcher', 'job-progress', 'JobProgressStore', g/'job-progress.sqlite3'),
               ('updater', 'database', 'UpdateDatabase', g/'control/updater.sqlite3')]
    script = ''
    for i, (component, module, cls, db) in enumerate(modules):
        script += f'import {{{cls} as C{i}}} from {json.dumps((release/component/"dist"/(module+".js")).as_uri())};\n'
        script += f'new C{i}({json.dumps(str(db))}).close();\n'
    env = dict(os.environ, DONA_RELEASE_MANIFEST_PATH=str(release/'release-manifest.json'))
    command([node, '--input-type=module', '-e', script], env=env)


def validate_handoff(plan, plan_hash, receipt, inv, database_reader):
    require(receipt.get('schema_version') == 1 and receipt.get('plan_sha256') == plan_hash, 'handoff_plan_mismatch')
    require(receipt.get('event_id') == plan['event_id'] and receipt.get('job_id') == plan['job_id'], 'handoff_identity')
    require(receipt.get('operator_assertion') == {'exclusive_dona_session': True, 'residual_old_workers_accepted': True,
            'parent_handoff_complete': True}, 'operator_assertion_missing')
    # 署名されたmachine fenceではない。DBのterminalとoperator handoffの両方を必要とする。
    database = inv['databases'][0]
    events = database_reader(database, 'SELECT status FROM events WHERE event_id=?', (plan['event_id'],))
    jobs = database_reader(database, 'SELECT status,completion_event_id FROM jobs WHERE job_id=? AND source_event_id=?', (plan['job_id'], plan['event_id']))
    require(events == [('completed',)] and len(jobs) == 1 and jobs[0][0] in TERMINAL, 'handoff_not_terminal')
    require(jobs[0][1] and receipt.get('handoff_event_id') == jobs[0][1], 'parent_notification_identity')
    parent = database_reader(database, 'SELECT status FROM events WHERE event_id=?', (jobs[0][1],))
    require(parent == [('completed',)], 'parent_notification_not_terminal')


class Runner:
    def __init__(self, run, services=None, database=None):
        self.run = Path(run)
        self.plan = read_json(self.run/'plan.json')
        self.inv = read_json(self.run/'inventory.json')
        self.journal = read_json(self.run/'journal.json')
        require(digest((self.run/'plan.json').read_bytes()) == self.journal['plan_sha256'], 'plan_changed')
        require(digest((self.run/'inventory.json').read_bytes()) == self.plan['inventory_sha256'], 'inventory_changed')
        require(digest((self.run/'runner.py').read_bytes()) == self.plan['runner_sha256'], 'runner_changed')
        require(tree_seal(self.run/'plists') == self.plan['plists_seal'], 'staged_plists_changed')
        self.services = services or Launchd()
        self.database = database or NodeDatabase(self.inv['policy']['executables']['node'], Path(self.plan['generation'])/'control/updater/node_modules/better-sqlite3/lib/index.js')
        self.generation = Path(self.plan['generation'])

    def record(self, phase, **fields):
        self.journal.update(phase=phase, updated_at=stamp(), **fields)
        self.journal['steps'].append({'phase': phase, 'at': stamp()})
        atomic(self.run/'journal.json', encode(self.journal))

    def validate_source(self):
        for name, sha in self.inv['files'].items():
            require(digest(regular(name).read_bytes()) == sha, 'source_configuration_drift')
        require(str(Path(self.inv['policy']['current_pointer']).resolve()) == self.inv['old_pointer'], 'source_pointer_drift')

    def assert_updater_idle(self):
        source = Path(self.inv['policy']['control_root'])/'updater.sqlite3'
        rows = self.database.read(source, "SELECT count(*) FROM update_requests WHERE state NOT IN ('succeeded','failed','rolled_back','needs_review','cancelled')")
        require(rows == [(0,)], 'normal_update_in_progress')

    def stop_all(self):
        for label in LABELS:
            # PIDは所有serviceから取得。PIDへsignalは送らない。
            current = self.services.observe(label)
            if current and current.get('pid'):
                identity = self.services.process(current['pid'])
                plist_path = Path.home()/'Library/LaunchAgents'/ (label+'.plist')
                plist = plistlib.loads(plist_path.read_bytes())
                require(identity and identity.split()[0] == str(os.getuid()) and plist['ProgramArguments'][1] in identity, 'service_process_owner')
                self.journal.setdefault('stopping', {})[label] = {'pid': current['pid'], 'identity': digest(identity.encode())}
                self.record(self.journal['phase'])
            self.services.stop(label)
        for item in self.journal.get('stopping', {}).values():
            current = self.services.process(item['pid'])
            require(current is None or digest(current.encode()) != item['identity'], 'service_pid_still_alive')
        require(all(self.services.observe(label) is None for label in LABELS), 'service_recreated')

    def backup(self):
        backup = private_dir(self.run/'backup')
        manifest = []
        for i, name in enumerate(self.inv['databases']):
            source = Path(name)
            if not source.exists():
                manifest.append({'source': name, 'absent': True})
                continue
            # SQLite backup APIはWALを含む整合snapshot。旧workerの後続writeは旧世代だけに残る。
            destination = backup/(str(i)+'.sqlite3')
            temporary = destination.with_suffix('.tmp')
            if temporary.exists():
                temporary.unlink()
            self.database.backup(source, temporary)
            with open(temporary, 'rb') as snapshot:
                os.fsync(snapshot.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, destination)
            manifest.append({'source': name, 'file': destination.name, 'sha256': file_digest(destination)})
        atomic(backup/'manifest.json', encode({'generation': 'old', 'snapshot_at': stamp(), 'databases': manifest,
            'results_retained_in_place': self.inv['old_results'], 'old_worker_writes_may_continue': True}))

    def switch(self):
        for label in LABELS:
            atomic(Path.home()/'Library/LaunchAgents'/ (label+'.plist'), (self.run/'plists'/ (label+'.plist')).read_bytes())

    def assert_installed(self, original=False):
        for label in LABELS:
            p = regular(Path.home()/'Library/LaunchAgents'/(label+'.plist'))
            expected = plistlib.dumps(self.inv['plists'][label]) if original else (self.run/'plists'/p.name).read_bytes()
            require(p.read_bytes() == expected, 'installed_plist_drift')

    def start_all(self, include_slack=True, original=False):
        self.assert_installed(original)
        for label in START if include_slack else START[:2]:
            self.services.start(label, Path.home()/'Library/LaunchAgents'/ (label+'.plist'))

    def health(self, include_slack=True):
        targets = [('control/updater.sock', 'updater'), ('run/d.sock', 'dispatcher')]
        if include_slack:
            targets.append(('run/s.sock', 'slack_adapter'))
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            try:
                for socket_name, service in targets:
                    h = http_unix(self.generation/socket_name, '/health/version')
                    require(h.get('status') == 'ready' and h.get('build_sha') == self.plan['target_sha'] and h.get('service') == service, 'target_health_mismatch')
                    if service in ('dispatcher', 'slack_adapter'):
                        require(h.get('update_notification_protocol') == 1, 'internal_notification_not_ready')
                    if service == 'slack_adapter':
                        require(h.get('workspaces_ready') is True and h.get('dispatcher_ready') is True, 'slack_not_connected')
                return
            except (OSError, RuntimeError, ValueError, http.client.HTTPException):
                time.sleep(.5)
        raise RuntimeError('target_health_timeout')

    def old_health(self):
        d = self.inv['configs']['dispatcher']['config']
        s = self.inv['configs']['slack']['config']
        targets = [(d['socketPath'], d['buildSha']), (s['healthSocketPath'], s['buildSha']),
                   (str(Path(self.inv['policy']['control_root'])/'updater.sock'), self.inv['plists']['dev.dona.updater']['EnvironmentVariables']['DONA_UPDATER_BUILD_SHA'])]
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            try:
                for socket_path, sha in targets:
                    health = http_unix(socket_path, '/health/version')
                    require(health.get('status') == 'ready' and health.get('build_sha') == sha, 'rollback_health_mismatch')
                return
            except (OSError, RuntimeError, ValueError, http.client.HTTPException):
                time.sleep(.5)
        raise RuntimeError('rollback_health_unconfirmed')

    def rollback(self):
        # 旧DB/Result/pointerは変更していない。旧世代への復帰前に新サービス停止を確認。
        self.record('rolling_back')
        self.stop_all()
        for label in LABELS:
            atomic(Path.home()/'Library/LaunchAgents'/ (label+'.plist'), plistlib.dumps(self.inv['plists'][label]))
        self.start_all(original=True)
        self.old_health()
        self.record('rolled_back', rollback_scope='original_plists_and_retained_old_generation')

    def restore(self):
        require(self.journal['phase'] in ('stopping', 'backing_up', 'switching', 'starting_core', 'rolling_back'), 'restore_after_ingress_forbidden')
        self.rollback()

    def execute(self, receipt):
        phase = self.journal['phase']
        require(phase in ('prepared', 'stopping', 'backing_up', 'switching', 'starting_core', 'starting_ingress', 'forward_recovery', 'rolling_back', 'rolled_back', 'succeeded'), 'journal_phase')
        if phase in ('succeeded', 'rolled_back'):
            return
        if phase == 'rolling_back':
            self.rollback()
            return
        try:
            # DB/log/socketは起動後mutable。code/config/pointerは全再開で照合する。
            require(static_seal(self.generation) == self.plan['static_seal'], 'static_generation_drift')
            if phase in ('prepared', 'stopping', 'backing_up', 'switching'):
                require(tree_seal(self.generation) == self.plan['generation_seal'], 'prepared_generation_drift')
            verify_trust(self.plan['target_sha'], self.inv['policy'])
            if phase == 'prepared':
                validate_handoff(self.plan, self.journal['plan_sha256'], receipt, self.inv, self.database.read)
                self.validate_source()
                self.assert_updater_idle()
                self.record('stopping', handoff_sha256=digest(encode(receipt)), residual_risk='operator_assertion_not_machine_stop_proof')
            if self.journal['phase'] == 'stopping':
                self.stop_all()  # Updaterを最初に止め、並行activationの生成元を除く。
                self.assert_updater_idle()  # 最初のcheckと停止の間に承認されたrequestを検出。
                self.validate_source()  # 停止中のpointer/config変更もbackup前に検出。
                self.record('backing_up')
            if self.journal['phase'] == 'backing_up':
                self.stop_all()
                self.assert_updater_idle()
                self.validate_source()
                self.backup()
                self.record('switching')
            if self.journal['phase'] == 'switching':
                self.stop_all()
                self.switch()
                self.record('starting_core')
            if self.journal['phase'] == 'starting_core':
                self.stop_all()  # 再開時も検証済plistから新しくbootstrapする。
                self.start_all(include_slack=False)
                self.health(include_slack=False)
                # このintent以後はACK済eventがあり得る。旧DBへの自動rollbackは禁止。
                self.record('starting_ingress')
            if self.journal['phase'] in ('starting_ingress', 'forward_recovery'):
                if phase in ('starting_ingress', 'forward_recovery'):
                    self.stop_all()
                self.start_all(include_slack=False)
                self.health(include_slack=False)
                self.assert_installed()
                label = 'dev.dona.slack-adapter'
                self.services.start(label, Path.home()/'Library/LaunchAgents'/(label+'.plist'))
                self.health()
                self.record('succeeded', target_sha=self.plan['target_sha'], slack_connected=True)
        except Exception:
            if self.journal['phase'] == 'prepared':
                raise
            if self.journal['phase'] in ('starting_ingress', 'forward_recovery'):
                self.record('forward_recovery', failure='ingress_may_have_accepted_events', old_generation_restore_forbidden=True)
                self.stop_all()
            else:
                self.record('rolling_back', failure='activation_failed')
                self.rollback()
            raise


@contextlib.contextmanager
def locked(run):
    lock_root = private_dir(Path.home()/'.dona-maintenance')
    with open(lock_root/'service.lock', 'a') as global_lock, open(run/'runner.lock', 'a') as file:
        os.chmod(lock_root/'service.lock', 0o600)
        os.chmod(run/'runner.lock', 0o600)
        fcntl.flock(global_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    p = sub.add_parser('prepare')
    p.add_argument('--run', type=Path, required=True)
    p.add_argument('--repository', type=Path, required=True)
    p.add_argument('--event-id', required=True)
    p.add_argument('--job-id', required=True)
    p = sub.add_parser('execute')
    p.add_argument('--run', type=Path, required=True)
    p.add_argument('--handoff', type=Path, required=True)
    p = sub.add_parser('restore')
    p.add_argument('--run', type=Path, required=True)
    p = sub.add_parser('status')
    p.add_argument('--run', type=Path, required=True)
    args = parser.parse_args()
    require(args.run.is_absolute(), 'run_path_absolute')
    if args.action == 'prepare':
        plan = prepare(args.run, args.repository, args.event_id, args.job_id)
        print(json.dumps({'phase': 'prepared', 'target_sha': plan['target_sha'], 'plan_sha256': digest((args.run/'plan.json').read_bytes())}))
    elif args.action == 'execute':
        with locked(args.run):
            Runner(args.run).execute(read_json(regular(args.handoff)))
        print(json.dumps({'phase': read_json(args.run/'journal.json')['phase']}))
    elif args.action == 'restore':
        with locked(args.run):
            Runner(args.run).restore()
        print(json.dumps({'phase': read_json(args.run/'journal.json')['phase']}))
    else:
        journal = read_json(args.run/'journal.json')
        print(json.dumps({k: journal[k] for k in ('phase', 'updated_at', 'target_sha') if k in journal}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('maintenance runner failed: ' + (str(error) if isinstance(error, RuntimeError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
