#!/usr/bin/env python3
"""Dona専用の独立保守runner。通常self-updateの承認・停止証明とは別契約。"""
import argparse
import contextlib
import datetime
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


def command(argv, cwd=None, env=None, timeout=60, input=None):
    # コマンド出力にはsecretが含まれ得るので例外・journalへ転載しない。
    result = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, timeout=timeout, input=input)
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


def http_unix(socket_path, route, method='GET', payload=None):
    conn = http.client.HTTPConnection('localhost', timeout=3)
    conn.sock = socket.socket(socket.AF_UNIX)
    conn.sock.settimeout(3)
    try:
        conn.sock.connect(str(socket_path))
        conn.request(method, route, body=encode(payload) if payload is not None else None,
                     headers={'content-type': 'application/json'} if payload is not None else {})
        response = conn.getresponse()
        require(response.status in (200, 202), 'health_not_ready')
        return json.loads(response.read(1024 * 1024))
    finally:
        conn.close()


class LaunchdRejected(RuntimeError):
    pass


class Launchd:
    def __init__(self, maintenance_label=None):
        self.maintenance_label = maintenance_label
        self.domain = 'gui/' + str(os.getuid())

    def observe(self, label):
        require(label in LABELS or label == self.maintenance_label, 'label_scope')
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
        if self.observe(label) is not None: return
        result = None
        try:
            result = subprocess.run(['/bin/launchctl', 'bootstrap', self.domain, str(plist)], capture_output=True, timeout=35)
        except subprocess.TimeoutExpired:
            pass
        if self.observe(label) is None:
            if result is not None and result.returncode > 0:
                raise LaunchdRejected('service_start_rejected')
            raise RuntimeError('service_start_unconfirmed')

    def process(self, pid):
        r = subprocess.run(['/bin/ps', '-ww', '-p', str(pid), '-o', 'uid=', '-o', 'lstart=', '-o', 'command='], capture_output=True, timeout=5)
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
    dotenv_bytes = regular(env['DOTENV_CONFIG_PATH']).read_bytes()
    script = f'''import fs from 'node:fs';
import {{parse}} from {json.dumps((cwd/'node_modules/dotenv/lib/main.js').as_uri())};
import {{{method}}} from {json.dumps((cwd/'dist'/ (module+'.js')).as_uri())};
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const values={{...parse(input.dotenv),...input.env}};
console.log(JSON.stringify({{config:{method}(values),values}}));'''
    result = json.loads(command([node, '--input-type=module', '-e', script], cwd=cwd, input=encode({'env': env, 'dotenv': dotenv_bytes.decode('utf8')})))
    return dict(result, dotenv_sha256=digest(dotenv_bytes), cwd=str(cwd))


def inventory():
    home = Path.home()
    plists = {}
    files = {}
    live = Launchd()
    observations = {}
    for label in LABELS:
        p = regular(home/'Library/LaunchAgents'/ (label+'.plist'))
        plist_bytes = p.read_bytes()
        plists[label] = plistlib.loads(plist_bytes)
        require(plists[label]['Label'] == label, 'plist_label_mismatch')
        files[str(p)] = digest(plist_bytes)
        observation = live.observe(label)
        require(observation and observation['pid'], 'source_service_not_running')
        process = live.process(observation['pid'])
        args = plists[label]['ProgramArguments']
        require(process and process.split()[0] == str(os.getuid()) and args[1] in process, 'service_process_owner')
        observations[label] = {**observation, 'identity_hash': digest(process.encode())}
    configs = {c: effective_config(plists['dev.dona.'+label], c) for c, label in [('dispatcher', 'dispatcher'), ('slack', 'slack-adapter')]}
    policy_path = regular(plists['dev.dona.updater']['EnvironmentVariables']['DONA_UPDATE_POLICY_PATH'])
    policy_bytes = policy_path.read_bytes()
    policy = json.loads(policy_bytes)
    require(policy['repository'] == 'hiragram/dona' and policy['canonical_remote'] == REMOTE, 'policy_scope')
    d = configs['dispatcher']['config']
    s = configs['slack']['config']
    require(d['herdrSession'] == 'dona' and d['socketPath'] == s['dispatcherSocketPath'], 'runtime_scope')
    for component in configs.values():
        p = regular(component['values']['DOTENV_CONFIG_PATH'])
        files[str(p)] = component['dotenv_sha256']
    files[str(policy_path)] = digest(policy_bytes)
    # tokenは保存するが出力しない。新世代ではrotateして旧MCPによる内部通知を拒否する。
    token = regular(d['updateInternalTokenPath'])
    files[str(token)] = digest(token.read_bytes())
    pointer = Path(policy['current_pointer'])
    require(pointer.is_symlink(), 'current_pointer_not_symlink')
    resolved_pointer = pointer.resolve()
    require(Path(configs['dispatcher']['cwd']) == resolved_pointer/'dispatcher' and Path(configs['slack']['cwd']) == resolved_pointer/'sources/slack', 'inventory_pointer_drift')
    for file, expected in files.items():
        require(file_digest(file) == expected, 'inventory_configuration_drift')
    require(pointer.resolve() == resolved_pointer, 'inventory_pointer_drift')
    return {'plists': plists, 'configs': configs, 'policy': policy, 'files': files,
            'old_pointer': str(pointer.resolve()), 'services': observations,
            'databases': [d['databasePath'], d['updateNotificationDatabasePath'], d['jobProgressDatabasePath'],
                          str(Path(policy['control_root'])/'updater.sqlite3')],
            'old_results': [d['resultsDir'], d['jobResultsDir']], 'captured_at': stamp()}


def installed_codex():
    # RealRuntimeがHerdrへ渡すminimalEnvironmentと同じPATHで解決する。
    executable = shutil.which('codex', path='/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin')
    require(executable is not None, 'codex_not_installed')
    executable = str(Path(executable).resolve())
    require(os.access(executable, os.X_OK) and command([executable, '--version']).startswith('codex-cli '), 'codex_executable_invalid')
    return executable


def prepare(run, repository, event_id, job_id, snapshot_old_databases=False):
    require(re.fullmatch(r'evt_[0-9A-HJKMNP-TV-Z]{26}', event_id, re.I), 'event_id')
    require(re.fullmatch(r'job_[0-9a-hjkmnp-tv-z]{26}', job_id, re.I), 'job_id')
    require(not run.exists(), 'run_already_exists')
    run.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    run.mkdir(mode=0o700)  # exclusive prepare
    atomic(run/'runner.py', Path(__file__).read_bytes())
    atomic(run/'main_bridge.mjs', Path(__file__).with_name('main_bridge.mjs').read_bytes())
    inv = inventory()
    atomic(run/'inventory.json', encode(inv))
    executables = inv['policy']['executables']
    sha = command([executables['gh'], 'api', 'repos/hiragram/dona/git/ref/heads/main', '--jq', '.object.sha'])
    require(re.fullmatch('[0-9a-f]{40}', sha), 'canonical_sha')
    require(command([executables['git'], '-C', str(repository), 'remote', 'get-url', 'origin']) in (REMOTE, REMOTE[:-4]), 'remote_scope')
    command([executables['git'], '-C', str(repository), 'fetch', 'origin', 'main'])
    require(command([executables['git'], '-C', str(repository), 'rev-parse', 'origin/main']) == sha, 'main_drift')
    trust = verify_trust(sha, inv['policy'])
    generation = private_dir(Path.home()/'.dona/g'/digest(str(run).encode())[:12])
    require(not list(generation.iterdir()), 'generation_not_empty')
    release = private_dir(generation/'runtime/releases'/sha)
    archive = run/'source.tar'
    command([executables['git'], '-C', str(repository), 'archive', '--format=tar', '-o', str(archive), sha])
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
            'created_at': stamp(), 'strategy': 'isolated_generation', 'operator_assertion_required': True, 'snapshot_old_databases': snapshot_old_databases}
    plan['codex_executable'] = installed_codex()
    state = NodeDatabase(node, release/'updater/node_modules/better-sqlite3/lib/index.js')
    rows = state.read(Path(inv['databases'][0]), 'SELECT result_path FROM jobs WHERE job_id=? AND source_event_id=?', (job_id, event_id))
    require(len(rows) == 1 and Path(rows[0][0]).is_absolute(), 'handoff_job_not_found')
    plan['job_result_path'] = rows[0][0]
    render(run, plan, inv)
    validate_staging(run, plan, node)
    migrate(plan, node)
    make_immutable(release)
    make_immutable(generation/'control/updater')
    # staging成果全体をseal。node_modulesを含め、prepare後の変更を停止前に検知する。
    plan['generation_seal'] = tree_seal(generation)
    plan['plists_seal'] = tree_seal(run/'plists')
    plan['service_programs'] = {label: plistlib.loads((run/'plists'/(label+'.plist')).read_bytes())['ProgramArguments'][1] for label in LABELS}
    plan['static_seal'] = static_seal(generation)
    atomic(run/'plan.json', encode(plan))
    atomic(run/'journal.json', encode({'phase': 'prepared', 'plan_sha256': digest((run/'plan.json').read_bytes()), 'steps': []}))
    return plan


def make_immutable(root):
    root = Path(root)
    for file in root.rglob('*'):
        if not file.is_symlink():
            os.chmod(file, 0o500 if file.is_dir() else 0o400)
    os.chmod(root, 0o500)


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
    policy['executables'] = dict(policy['executables'], codex=plan.get('codex_executable', policy['executables']['codex']))
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
    atomic(g/'config/main_bridge.mjs', (run/'main_bridge.mjs').read_bytes())
    atomic(g/'control/dispatcher.token', (os.urandom(32).hex()+'\n').encode())
    overrides = {'DONA_CODEX_PATH': policy['executables']['codex'], 'DONA_DATABASE_PATH': str(g/'dona.sqlite3'), 'DONA_RESULTS_DIR': str(g/'results'),
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
            # argvから接続設定を監査でき、古い継承envを新世代設定で上書きする固定wrapper。
            wrapper = f'''import fs from 'node:fs';
import {{parse}} from {json.dumps((release/component/'node_modules/dotenv/lib/main.js').as_uri())};
const file={json.dumps(str(g/'config'/(key+'.env')))};
Object.assign(process.env,parse(fs.readFileSync(file)),{{DOTENV_CONFIG_PATH:file}});
delete process.env.DONA_BUILD_SHA;
await import({json.dumps((g/'runtime/current'/component/'dist/mcp/index.js').as_uri())});
'''
            wrapper_path = g/'config'/('mcp-'+key+'.mjs')
            atomic(wrapper_path, wrapper.encode())
            os.chmod(wrapper_path, 0o400)
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


def final_job_result(plan, inv, expected_digest):
    require(isinstance(expected_digest, str) and re.fullmatch('[0-9a-f]{64}', expected_digest), 'final_result_digest_required')
    file = regular(plan['job_result_path'])
    require(file.stat().st_size <= 1048576, 'final_result_too_large')
    content = file.read_bytes()
    require(digest(content) == expected_digest, 'final_result_changed')
    # hashとschemaは同じbytesへ結び付ける。旧DBやResultは書き換えない。
    module = (Path(plan['release'])/'dispatcher/dist/validation.js').as_uri()
    script = f"import fs from 'node:fs';import {{parseJobResultEnvelope}} from {json.dumps(module)};const r=parseJobResultEnvelope(JSON.parse(fs.readFileSync(0,'utf8')),process.argv[1]);console.log(JSON.stringify({{status:r.status,completed_at:r.completed_at}}));"
    result = json.loads(command([inv['policy']['executables']['node'], '--input-type=module', '-e', script, plan['job_id']], input=content))
    require(result['status'] == 'completed', 'final_job_not_completed')
    return result


def validate_handoff(plan, plan_hash, receipt, inv, database_reader):
    require(receipt.get('schema_version') == 1 and receipt.get('plan_sha256') == plan_hash, 'handoff_plan_mismatch')
    require(receipt.get('event_id') == plan['event_id'] and receipt.get('job_id') == plan['job_id'], 'handoff_identity')
    require(receipt.get('operator_assertion') == {'exclusive_dona_session': True, 'residual_old_workers_accepted': True,
            'parent_handoff_complete': True}, 'operator_assertion_missing')
    database = inv['databases'][0]
    events = database_reader(database, 'SELECT status FROM events WHERE event_id=?', (plan['event_id'],))
    jobs = database_reader(database, 'SELECT status,completion_event_id,last_error_code,result_path FROM jobs WHERE job_id=? AND source_event_id=?', (plan['job_id'], plan['event_id']))
    require(events == [('completed',)] and len(jobs) == 1, 'handoff_not_terminal')
    job = jobs[0]
    late = job[0] == 'needs_review' and job[2] == 'timeout'
    require(job[0] in TERMINAL or late, 'handoff_not_terminal')
    if late:
        # この保守job自身の完了成果だけをoperatorが受理する経路。旧履歴のreconcileはしない。
        require(job[3] == plan.get('job_result_path'), 'final_result_path_changed')
        result = final_job_result(plan, inv, receipt.get('job_result_sha256'))
        source = database_reader(database, 'SELECT subject_json,reply_target_json FROM events WHERE event_id=?', (plan['event_id'],))[0]
        parent = database_reader(database, 'SELECT status,subject_json,reply_target_json,completed_at FROM events WHERE event_id=?', (receipt.get('handoff_event_id'),))
        require(len(parent) == 1, 'parent_notification_identity')
        original_subject, parent_subject = json.loads(source[0]), json.loads(parent[0][1])
        require(all(original_subject.get(k) and original_subject[k] == parent_subject.get(k) for k in ('workspace_id','channel_id'))
                and source[1] is not None and json.loads(source[1]) == json.loads(parent[0][2] or 'null'), 'parent_notification_scope')
        require(parent[0][0] == 'completed', 'parent_notification_not_terminal')
        completed = lambda value: datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        require(parent[0][3] and completed(parent[0][3]) >= completed(result['completed_at']), 'parent_handoff_predates_result')
    else:
        require(job[1] and receipt.get('handoff_event_id') == job[1], 'parent_notification_identity')
        parent = database_reader(database, 'SELECT status FROM events WHERE event_id=?', (job[1],))
        require(parent == [('completed',)], 'parent_notification_not_terminal')



def read_process(pid):
    result = subprocess.run(['/bin/ps', '-ww', '-p', str(pid), '-o', 'uid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'command='], capture_output=True, timeout=5)
    require(result.returncode == 0, 'main_process_missing')
    raw = result.stdout.decode().strip()
    uid, parent, rest = raw.split(maxsplit=2)
    return {'uid': int(uid), 'parent': int(parent), 'identity': digest((str(pid)+raw).encode()), 'command': rest}


def main_evidence(plan, inv, spec, observer=read_process):
    require(spec.get('dispatcher_target_confirmed') is True and spec.get('mcp_handshake_confirmed') is True, 'main_operator_mapping_required')
    require(isinstance(spec.get('session_id'), str) and 0 < len(spec['session_id']) <= 512 and '\n' not in spec['session_id'], 'main_session_identity')
    ids = [spec.get(key) for key in ('main_pid', 'dispatcher_pid', 'slack_pid', 'previous_main_pid')]
    require(all(type(pid) is int and pid > 1 for pid in ids) and len(set(ids)) == 4, 'main_pid_identity')
    expected = {'main': [plan.get('codex_executable', inv['policy']['executables']['codex']), plan['release']],
                'dispatcher': [inv['policy']['executables']['node'], str(Path(plan['generation'])/'config/mcp-dispatcher.mjs')],
                'slack': [inv['policy']['executables']['node'], str(Path(plan['generation'])/'config/mcp-slack.mjs')]}
    observations = []
    for role, pid in zip(('main', 'dispatcher', 'slack'), ids[:3]):
        record = observer(pid)
        require(record['uid'] == os.getuid() and any(value in record['command'] for value in (expected[role][0], str(Path(expected[role][0]).resolve()))) and expected[role][1] in record['command'], 'main_process_binding')
        if role != 'main':
            parent = record['parent']
            for _ in range(16):
                if parent == ids[0]: break
                ancestor = observer(parent)
                require(ancestor['uid'] == os.getuid() and ancestor['parent'] != parent, 'main_parent_binding')
                parent = ancestor['parent']
            require(parent == ids[0], 'main_parent_binding')
        observations.append({'role': role, 'pid': pid, 'identity': record['identity']})
    for record in observations:
        require(observer(record['pid'])['identity'] == record['identity'], 'main_process_changed')
    return observations


class Runner:
    def __init__(self, run, services=None, database=None):
        self.run = Path(run)
        self.plan = read_json(self.run/'plan.json')
        self.inv = read_json(self.run/'inventory.json')
        self.journal = read_json(self.run/'journal.json')
        require(digest((self.run/'plan.json').read_bytes()) == self.journal['plan_sha256'], 'plan_changed')
        require(digest((self.run/'inventory.json').read_bytes()) == self.plan['inventory_sha256'], 'inventory_changed')
        require(digest((self.run/'runner.py').read_bytes()) == self.plan['runner_sha256'], 'runner_changed')
        self.services = services or Launchd()
        self.database = database or NodeDatabase(self.inv['policy']['executables']['node'], Path(self.plan['generation'])/'control/updater/node_modules/better-sqlite3/lib/index.js')
        self.generation = Path(self.plan['generation'])

    def record(self, phase, **fields):
        updated = json.loads(json.dumps(self.journal))
        updated.update(phase=phase, updated_at=stamp(), **fields)
        updated['steps'].append({'phase': phase, 'at': stamp()})
        atomic(self.run/'journal.json', encode(updated))
        self.journal = updated

    def validate_source(self):
        for name, sha in self.inv['files'].items():
            require(digest(regular(name).read_bytes()) == sha, 'source_configuration_drift')
        require(str(Path(self.inv['policy']['current_pointer']).resolve()) == self.inv['old_pointer'], 'source_pointer_drift')

    def assert_updater_idle(self):
        source = Path(self.inv['policy']['control_root'])/'updater.sqlite3'
        rows = self.database.read(source, "SELECT count(*) FROM update_requests WHERE state NOT IN ('succeeded','failed','rolled_back','needs_review','cancelled','awaiting_approval')")
        require(rows == [(0,)], 'normal_update_in_progress')

    def stop_all(self, tolerate_journal_failure=False):
        failures = []
        for label in LABELS:
            try:
                # PIDは所有serviceから取得。PIDへsignalは送らない。
                current = self.services.observe(label)
                if current and current.get('pid'):
                    identity = self.services.process(current['pid'])
                    programs = [self.inv['plists'][label]['ProgramArguments'][1], self.plan.get('service_programs', {}).get(label)]
                    require(identity and identity.split()[0] == str(os.getuid()) and any(program and program in identity for program in programs), 'service_process_owner')
                    self.journal.setdefault('stopping', {})[label] = {'pid': current['pid'], 'identity': digest(identity.encode())}
                    try:
                        self.record(self.journal['phase'])
                    except OSError as error:
                        if not tolerate_journal_failure: failures.append(error)  # journal障害でも確認済serviceを止める。
                self.services.stop(label)
            except Exception as error:
                failures.append(error)  # 1serviceの失敗でSlackの停止までskipしない。
        for item in self.journal.get('stopping', {}).values():
            current = self.services.process(item['pid'])
            require(current is None or digest(current.encode()) != item['identity'], 'service_pid_still_alive')
        if failures: raise failures[0]
        require(all(self.services.observe(label) is None for label in LABELS), 'service_recreated')

    def quiesce_old_slack(self):
        socket_path = self.inv['configs']['slack']['config']['healthSocketPath']
        intent = self.run/'quiesce.json'
        if not intent.exists():
            atomic(intent, encode({'plan_sha256': self.journal['plan_sha256'], 'at': stamp()}))
            try:
                http_unix(socket_path, '/v1/admin/quiesce', 'POST', {'schema_version': 1, 'protocol': 1,
                    'operation_id': 'upd_'+self.journal['plan_sha256'][:26], 'target_sha': self.plan['target_sha']})
            except (OSError, http.client.HTTPException):
                pass  # 受理不明のPOSTは再送せず、socket側の現在状態を読む。
        require(read_json(intent)['plan_sha256'] == self.journal['plan_sha256'], 'quiesce_plan_changed')
        deadline = time.monotonic() + 60
        while True:
            state = http_unix(socket_path, '/v1/admin/drain-status')
            require(state.get('schema_version') == 1 and state.get('protocol') == 1 and state.get('service') == 'slack_adapter'
                    and state.get('quiescing') is True, 'slack_quiesce_unconfirmed')
            if state.get('drained') is True and state.get('in_flight') == 0: return
            require(time.monotonic() < deadline, 'slack_drain_timeout')
            time.sleep(.2)

    def arm(self, receipt_path, launcher=None):
        require(self.journal['phase'] == 'prepared', 'arm_phase')
        require(receipt_path.resolve().parent == self.run.resolve(), 'handoff_location')
        self.validate_source()
        require(tree_seal(self.generation) == self.plan['generation_seal'], 'prepared_generation_drift')
        require(tree_seal(self.run/'plists') == self.plan['plists_seal'], 'staged_plists_changed')
        receipt = read_json(regular(receipt_path))
        try:
            validate_handoff(self.plan, self.journal['plan_sha256'], receipt, self.inv, self.database.read)
        except RuntimeError as error:
            require(str(error) in ('handoff_not_terminal', 'parent_notification_not_terminal'), str(error))
        label = 'dev.dona.maintenance.' + self.journal['plan_sha256'][:16]
        launcher = launcher or Launchd(label)
        intent = self.run/'arm.json'
        if intent.exists():
            prior = read_json(intent)
            require(prior.get('label') == label, 'arm_identity_changed')
            if launcher.observe(label) is not None: return label  # 登録済みone-shotをkickstartしない。
            require(prior.get('phase') == 'bootstrap_rejected', 'arm_acceptance_unknown')
        require(launcher.observe(label) is None, 'maintenance_label_busy')
        plist = self.run/'maintenance.plist'
        atomic(plist, plistlib.dumps({'Label': label, 'RunAtLoad': True, 'KeepAlive': False,
            'ProgramArguments': [str(Path(sys.executable).resolve()), '-B', str(self.run/'runner.py'), 'wait-execute',
                                 '--run', str(self.run), '--handoff', str(receipt_path)],
            'WorkingDirectory': str(self.run), 'StandardOutPath': str(self.run/'operator.log'),
            'StandardErrorPath': str(self.run/'operator.log'), 'Umask': 0o077}))
        atomic(intent, encode({'label': label, 'phase': 'bootstrap_intent', 'at': stamp(),
                              'handoff_sha256': digest(encode(receipt))}))
        try:
            launcher.start(label, plist)
        except LaunchdRejected:
            atomic(intent, encode({'label': label, 'phase': 'bootstrap_rejected', 'at': stamp(),
                                  'handoff_sha256': digest(encode(receipt))}))
            raise
        return label

    def wait_handoff(self, receipt, timeout=600):
        deadline = time.monotonic() + timeout
        while True:
            try:
                validate_handoff(self.plan, self.journal['plan_sha256'], receipt, self.inv, self.database.read)
                return
            except RuntimeError as error:
                if str(error) not in ('handoff_not_terminal', 'parent_notification_not_terminal'): raise
                require(time.monotonic() < deadline, 'handoff_wait_expired')
                time.sleep(1)

    def main_call(self, **request):
        proc = subprocess.run([self.inv['policy']['executables']['node'], str(self.generation/'config/main_bridge.mjs'),
                               str(self.generation/'control')], input=encode(request), capture_output=True, timeout=300)
        require(proc.returncode == 0, 'main_bridge_failed')
        return json.loads(proc.stdout)

    def find_main_pid(self, release):
        raw = command(['/bin/ps', '-ww', '-axo', 'pid=,command='])
        executable = self.inv['policy']['executables']['codex'] if release == self.inv['old_pointer'] else self.plan.get('codex_executable', self.inv['policy']['executables']['codex'])
        candidates = []
        for line in raw.splitlines():
            pid, cmd = line.strip().split(maxsplit=1)
            if str(release) in cmd and any(value in cmd for value in (executable, str(Path(executable).resolve()))):
                candidates.append(int(pid))
        require(len(candidates) == 1, 'main_process_not_unique')
        return candidates[0]

    def main_step(self, phase, **fields):
        state = read_json(self.run/'main-lifecycle.json') if (self.run/'main-lifecycle.json').exists() else {}
        state.update(phase=phase, **fields)
        atomic(self.run/'main-lifecycle.json', encode(state))
        return state

    def ensure_main(self):
        # main制御は通常UpdaterのRealRuntimeを再利用。旧jobの解決・worker操作は行わない。
        file = self.run/'main-lifecycle.json'
        state = read_json(file) if file.exists() else None
        if state is None or state['phase'] == 'stop_rejected':
            deadline = time.monotonic() + 60
            while True:
                old = self.main_call(action='status', release=self.inv['old_pointer'])
                if old.get('status') != 'working' or time.monotonic() >= deadline: break
                time.sleep(1)
            require(old.get('exists') and old.get('name') == 'dona-main' and old.get('kind') == 'codex'
                    and old.get('matches_release') and old.get('session_id') and old.get('pane_id')
                    and old.get('status') in ('idle', 'done'), 'old_main_not_ready_for_handoff')
            previous_pid = self.find_main_pid(self.inv['old_pointer'])
            state = self.main_step('stop_intent', old=old, previous_pid=previous_pid)
            outcome = self.main_call(action='stop', expected=old)
            if outcome.get('outcome') == 'rejected':
                self.main_step('stop_rejected')
                raise RuntimeError('main_stop_rejected')
            require(outcome.get('outcome') == 'stopped', 'main_stop_acceptance_unknown')
            state = self.main_step('stopped')
        if state['phase'] == 'stop_intent':
            # 喪失したstopを再送しない。固定paneの非在だけをmachine fenceとは扱わない。
            raise RuntimeError('main_stop_acceptance_unknown')
        if state['phase'] in ('stopped', 'start_rejected'):
            state = self.main_step('start_intent')
            outcome = self.main_call(action='start', release=self.plan['release'], pane=state['old']['pane_id'],
                                     previous_session=state['old']['session_id'])
            if outcome.get('outcome') == 'rejected':
                self.main_step('start_rejected')
                raise RuntimeError('main_start_rejected')
            # timeout後も以下のread-only照合で受理済みmainを発見できる。start再送はしない。
            if outcome.get('outcome') == 'started':
                state = self.main_step('started', observation=outcome['observation'])
        observed = self.main_call(action='status', release=self.plan['release'])
        require(observed.get('exists') and observed.get('name') == 'dona-main' and observed.get('kind') == 'codex'
                and observed.get('pane_id') == state['old']['pane_id'] and observed.get('matches_release')
                and observed.get('session_id') and observed['session_id'] != state['old']['session_id']
                and observed.get('interactive_ready') and observed.get('status') in ('idle', 'done'), 'new_main_not_ready')
        if state.get('observation'):
            require(observed['session_id'] == state['observation']['session_id'], 'new_main_session_changed')
        state = self.main_step('started', observation=observed)
        main_pid = self.find_main_pid(self.plan['release'])
        main_command = read_process(main_pid)['command']
        require(all('mcp_servers.'+name+'.required=true' in main_command and 'mcp_servers.'+name+'.enabled=true' in main_command
                    for name in ('dona_dispatcher', 'dona_slack')), 'main_required_mcp_configuration')
        # required=trueの両MCPが初期化に成功したCodexだけが起動確認READYを終えられる。
        # 実process treeでも固定wrapperの子processを確認し、別世代/別mainを排除する。
        raw = command(['/bin/ps', '-ww', '-axo', 'pid=,command='])
        pids = {}
        for role in ('dispatcher', 'slack'):
            wrapper = str(self.generation/'config'/('mcp-'+role+'.mjs'))
            matches = []
            for line in raw.splitlines():
                pid, cmd = line.strip().split(maxsplit=1)
                if wrapper in cmd and int(pid) != main_pid:
                    record = read_process(int(pid))
                    parent = record['parent']
                    for _ in range(16):
                        if parent == main_pid: break
                        ancestor = read_process(parent)
                        if ancestor['parent'] == parent: break
                        parent = ancestor['parent']
                    if parent == main_pid: matches.append(int(pid))
            require(len(matches) == 1, 'main_mcp_process_not_unique')
            pids[role+'_pid'] = matches[0]
        spec = dict(pids, main_pid=main_pid, previous_main_pid=state['previous_pid'], session_id=observed['session_id'],
                    dispatcher_target_confirmed=True, mcp_handshake_confirmed=True)
        evidence = main_evidence(self.plan, self.inv, spec)
        atomic(self.run/'main-ready.json', encode({'schema_version': 1, 'plan_sha256': self.journal['plan_sha256'],
               'mapping_evidence': 'updater_runtime_and_required_mcp', 'spec': spec, 'observations': evidence,
               'issued_at_unix': time.time(), 'created_at': stamp()}))

    def assert_main_ready(self):
        file = self.run/'main-ready.json'
        if not file.exists(): return False
        receipt = read_json(regular(file))
        require(receipt.get('schema_version') == 1 and receipt.get('plan_sha256') == self.journal['plan_sha256']
                and receipt.get('mapping_evidence') == 'updater_runtime_and_required_mcp', 'main_receipt_binding')
        issued = receipt.get('issued_at_unix')
        require(type(issued) in (int, float) and 0 <= time.time() - issued, 'main_receipt_time_invalid')
        require(main_evidence(self.plan, self.inv, receipt['spec']) == receipt['observations'], 'main_receipt_stale')
        state = read_json(self.run/'main-lifecycle.json')
        observed = self.main_call(action='status', release=self.plan['release'])
        require(observed.get('exists') and observed.get('name') == 'dona-main' and observed.get('kind') == 'codex'
                and observed.get('pane_id') == state['old']['pane_id'] and observed.get('matches_release')
                and observed.get('session_id') == receipt['spec']['session_id'], 'main_mapping_changed')
        # 保存時刻だけを根拠にせず、現在のprocessとHerdr mappingの一致後に更新する。
        receipt['issued_at_unix'] = time.time()
        receipt['last_verified_at'] = stamp()
        atomic(file, encode(receipt))
        return True

    def cleanup_partial_backups(self):
        for index in range(len(self.inv['databases'])):
            for suffix in ('', '-wal', '-shm'):
                partial = self.run/'backup'/(str(index)+'.tmp'+suffix)
                if partial.is_file() or partial.is_symlink(): partial.unlink()

    def preflight_space(self):
        if not self.plan.get('snapshot_old_databases', True): return
        size = 0
        for source in self.inv['databases']:
            for suffix in ('', '-wal'):
                p = Path(source + suffix)
                if p.exists(): size += p.stat().st_size
        require(shutil.disk_usage(self.run).free >= size + self.inv['policy'].get('disk_floor_bytes', 0), 'backup_disk_floor')

    def backup(self):
        if not self.plan.get('snapshot_old_databases', True):
            self.record('backing_up', backup_scope='old_generation_retained_in_place_without_snapshot')
            return
        self.preflight_space()
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
            try:
                self.database.backup(source, temporary)
            except Exception:
                for suffix in ('', '-wal', '-shm'):
                    partial = Path(str(temporary) + suffix)
                    if partial.is_file() or partial.is_symlink(): partial.unlink()
                raise
            with open(temporary, 'rb') as snapshot:
                os.fsync(snapshot.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, destination)
            manifest.append({'source': name, 'file': destination.name, 'sha256': file_digest(destination)})
        atomic(backup/'manifest.json', encode({'generation': 'old', 'snapshot_at': stamp(), 'databases': manifest,
            'results_retained_in_place': self.inv['old_results'], 'old_worker_writes_may_continue': True}))

    def switch(self):
        for label in LABELS:
            if label == 'dev.dona.slack-adapter': continue
            atomic(Path.home()/'Library/LaunchAgents'/ (label+'.plist'), (self.run/'plists'/ (label+'.plist')).read_bytes())

    def install_slack(self):
        label = 'dev.dona.slack-adapter'
        p = regular(Path.home()/'Library/LaunchAgents'/(label+'.plist'))
        staged = (self.run/'plists'/p.name).read_bytes()
        require(p.read_bytes() == staged or file_digest(p) == self.inv['files'][str(p)], 'installed_plist_drift')
        atomic(p, staged)

    def assert_installed(self, original=False):
        for label in LABELS:
            p = regular(Path.home()/'Library/LaunchAgents'/(label+'.plist'))
            if not original and label == 'dev.dona.slack-adapter' and self.journal['phase'] in ('starting_core', 'awaiting_main'):
                require(file_digest(p) == self.inv['files'][str(p)], 'installed_plist_drift')
                continue
            expected = plistlib.dumps(self.inv['plists'][label]) if original else (self.run/'plists'/p.name).read_bytes()
            require(p.read_bytes() == expected, 'installed_plist_drift')

    def start_all(self, include_slack=True, original=False):
        if not original: require(static_seal(self.generation) == self.plan['static_seal'], 'static_generation_drift')
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
        journal_error = None
        try:
            self.record('rolling_back')
        except OSError as error:
            journal_error = error
        self.stop_all(tolerate_journal_failure=True)
        for label in LABELS:
            atomic(Path.home()/'Library/LaunchAgents'/ (label+'.plist'), plistlib.dumps(self.inv['plists'][label]))
        self.start_all(original=True)
        self.old_health()
        self.record('rolled_back', rollback_scope='original_plists_and_retained_old_generation')
        if journal_error: raise journal_error

    def restore(self):
        require(self.journal['phase'] in ('quiescing', 'stopping', 'backing_up', 'switching', 'starting_core', 'rolling_back'), 'restore_after_ingress_forbidden')
        self.rollback()

    def execute(self, receipt):
        phase = self.journal['phase']
        require(phase in ('prepared', 'quiescing', 'stopping', 'backing_up', 'switching', 'starting_core', 'awaiting_main', 'starting_ingress', 'forward_recovery', 'rolling_back', 'rolled_back', 'succeeded'), 'journal_phase')
        if phase in ('succeeded', 'rolled_back'):
            return
        if phase in ('backing_up', 'rolling_back'):
            self.cleanup_partial_backups()  # crash後も容量確認やjournal writeより先に部分fileを回収。
        if phase == 'rolling_back':
            self.rollback()
            return
        try:
            require(tree_seal(self.run/'plists') == self.plan['plists_seal'], 'staged_plists_changed')
            # DB/log/socketは起動後mutable。code/config/pointerは全再開で照合する。
            require(static_seal(self.generation) == self.plan['static_seal'], 'static_generation_drift')
            if phase in ('prepared', 'quiescing', 'stopping', 'backing_up', 'switching'):
                require(tree_seal(self.generation) == self.plan['generation_seal'], 'prepared_generation_drift')
            verify_trust(self.plan['target_sha'], self.inv['policy'])
            if phase == 'prepared':
                validate_handoff(self.plan, self.journal['plan_sha256'], receipt, self.inv, self.database.read)
                self.validate_source()
                self.assert_updater_idle()
                self.preflight_space()
                self.record('quiescing', handoff_sha256=digest(encode(receipt)), residual_risk='operator_assertion_not_machine_stop_proof')
            if self.journal['phase'] == 'quiescing':
                self.quiesce_old_slack()
                self.record('stopping')
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
                self.validate_source()
                self.record('switching')
            if self.journal['phase'] == 'switching':
                self.stop_all()
                self.switch()
                self.record('starting_core')
            if self.journal['phase'] == 'starting_core':
                self.stop_all()  # 再開時も検証済plistから新しくbootstrapする。
                if phase != 'starting_core':
                    require(tree_seal(self.generation) == self.plan['generation_seal'], 'prepared_generation_drift')
                self.start_all(include_slack=False)
                self.health(include_slack=False)
                self.record('awaiting_main')
            if self.journal['phase'] == 'awaiting_main':
                if phase == 'awaiting_main':
                    self.stop_all()
                    self.start_all(include_slack=False)
                    self.health(include_slack=False)
                self.ensure_main()
                require(self.assert_main_ready(), 'main_not_ready')
                self.health(include_slack=False)
                # このintent以後はACK済eventがあり得る。旧DBへの自動rollbackは禁止。
                self.record('starting_ingress')
            if self.journal['phase'] in ('starting_ingress', 'forward_recovery'):
                if self.journal['phase'] == 'forward_recovery': self.ensure_main()
                require(self.assert_main_ready(), 'main_not_ready')
                self.install_slack()
                if phase in ('starting_ingress', 'forward_recovery'):
                    self.stop_all()
                self.start_all(include_slack=False)
                self.health(include_slack=False)
                self.assert_installed()
                require(self.assert_main_ready(), 'main_not_ready')
                label = 'dev.dona.slack-adapter'
                self.services.start(label, Path.home()/'Library/LaunchAgents'/(label+'.plist'))
                self.health()
                require(self.assert_main_ready(), 'main_not_ready')
                self.record('succeeded', target_sha=self.plan['target_sha'], slack_connected=True)
        except Exception:
            if self.journal['phase'] == 'prepared':
                raise
            if self.journal['phase'] in ('awaiting_main', 'starting_ingress', 'forward_recovery', 'succeeded'):
                try:
                    self.record('forward_recovery', failure='main_handoff_or_ingress_started', old_generation_restore_forbidden=True)
                finally:
                    self.stop_all()
            else:
                self.rollback()
            raise


@contextlib.contextmanager
def locked(run, wait=False):
    lock_root = private_dir(Path.home()/'.dona-maintenance')
    with open(lock_root/'service.lock', 'a') as global_lock, open(run/'runner.lock', 'a') as file:
        os.chmod(lock_root/'service.lock', 0o600)
        os.chmod(run/'runner.lock', 0o600)
        fcntl.flock(global_lock, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
        fcntl.flock(file, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
        yield


def assert_running_copy(run):
    expected = regular(run/'runner.py')
    require(Path(__file__).resolve() == expected.resolve() and file_digest(__file__) == read_json(run/'plan.json')['runner_sha256'], 'sealed_runner_required')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    p = sub.add_parser('prepare')
    p.add_argument('--run', type=Path, required=True)
    p.add_argument('--repository', type=Path, required=True)
    p.add_argument('--event-id', required=True)
    p.add_argument('--job-id', required=True)
    p.add_argument('--snapshot-old-databases', action='store_true')
    for action in ('execute', 'arm', 'wait-execute'):
        p = sub.add_parser(action)
        p.add_argument('--run', type=Path, required=True)
        p.add_argument('--handoff', type=Path, required=True)
    p = sub.add_parser('probe-mcp')
    p.add_argument('--run', type=Path, required=True)
    p = sub.add_parser('restore')
    p.add_argument('--run', type=Path, required=True)
    p = sub.add_parser('status')
    p.add_argument('--run', type=Path, required=True)
    args = parser.parse_args()
    require(args.run.is_absolute(), 'run_path_absolute')
    if args.action == 'prepare':
        plan = prepare(args.run, args.repository, args.event_id, args.job_id, args.snapshot_old_databases)
        print(json.dumps({'phase': 'prepared', 'target_sha': plan['target_sha'], 'plan_sha256': digest((args.run/'plan.json').read_bytes())}))
    elif args.action == 'probe-mcp':
        assert_running_copy(args.run)
        with locked(args.run):
            runner = Runner(args.run)
            require(static_seal(runner.generation) == runner.plan['static_seal'], 'static_generation_drift')
            result = runner.main_call(action='probe')
            atomic(args.run/'mcp-probe.json', encode({'at': stamp(), 'plan_sha256': runner.journal['plan_sha256'], 'servers': result}))
        print(json.dumps({'servers': result}))
    elif args.action == 'arm':
        assert_running_copy(args.run)
        with locked(args.run):
            label = Runner(args.run).arm(args.handoff)
        print(json.dumps({'phase': 'armed', 'label': label}))
    elif args.action in ('execute', 'wait-execute'):
        assert_running_copy(args.run)
        receipt = read_json(regular(args.handoff))
        if args.action == 'wait-execute':
            intent = read_json(args.run/'arm.json')
            require(intent['handoff_sha256'] == digest(encode(receipt)), 'armed_handoff_changed')
            Runner(args.run).wait_handoff(receipt)
        with locked(args.run, wait=args.action == 'wait-execute'):
            Runner(args.run).execute(receipt)
        print(json.dumps({'phase': read_json(args.run/'journal.json')['phase']}))
    elif args.action == 'restore':
        assert_running_copy(args.run)
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
