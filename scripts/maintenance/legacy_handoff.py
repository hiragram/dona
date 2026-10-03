#!/usr/bin/env python3
"""外部operatorが保存した旧世代成果の照合。workerの起動・停止やDB変更は行わない。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import stat
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reset_upgrade as maintenance
import offline_update as offline

ROOT = Path.home() / '.dona-maintenance/legacy-handoffs'


def require(value, message):
    if not value:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    path = Path(path)
    info = path.lstat()
    require(path.is_file() and not path.is_symlink() and info.st_uid == os.getuid() and not info.st_mode & 0o022,
            'handoff_file_not_private_or_owned')
    return json.loads(path.read_text())


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], timeout=30,
                                   env=dict(os.environ, GIT_OPTIONAL_LOCKS='0'))


def fingerprint(root):
    root = Path(root)
    require(root.is_absolute() and root.is_dir() and not root.is_symlink(), 'workspace_invalid')
    require(Path(git(root, 'rev-parse', '--show-toplevel').decode().strip()).resolve() == root.resolve(), 'workspace_root_mismatch')
    head = git(root, 'rev-parse', 'HEAD').decode().strip()
    diff = git(root, 'diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--')
    untracked = []
    for raw in sorted(filter(None, git(root, 'ls-files', '--others', '--exclude-standard', '-z').split(b'\0'))):
        name = os.fsdecode(raw)
        p = root / name
        require(not p.is_symlink() and p.is_file() and p.resolve().is_relative_to(root.resolve()), 'untracked_file_unsafe')
        untracked.append({'path': name, 'sha256': digest(p.read_bytes()), 'executable': bool(p.stat().st_mode & 0o111)})
    return {'head': head, 'diff_sha256': digest(diff), 'untracked': untracked}


def retired_roots(inventory, workspace):
    return [Path(inventory['old_pointer']).resolve(), Path(inventory['policy']['control_root']).resolve(), Path(workspace).resolve()]


def assert_no_retired_process(rows, cwds, retired_roots, exempt):
    # psとlsofの間に生まれたPIDもcwd一覧だけで検出する。lsofは同一userへ限定済み。
    for cwd in cwds.values():
        require(not any(cwd == root or root in cwd.parents for root in retired_roots), 'retired_generation_process_running')
    for pid, uid, command in rows:
        if uid != os.getuid():
            continue
        cwd = cwds.get(pid)
        for root in retired_roots:
            # shell/workerと子processのcwd、または旧releaseを指定したargvを照合する。
            if cwd and (cwd == root or root in cwd.parents):
                raise RuntimeError('retired_generation_process_running')
            if pid not in exempt and str(root) in command:
                raise RuntimeError('retired_generation_process_running')


def database_identities(paths):
    identities = set()
    for value in paths:
        file = Path(value)
        info = file.stat()
        require(not file.is_symlink() and stat.S_ISREG(info.st_mode), 'database_not_regular')
        identities.add((info.st_dev, info.st_ino))
    require(len(identities) == len(paths), 'database_identity_overlap')
    return identities


def expected_storage(seed_run, owner_path=None):
    owner = read(owner_path or Path.home()/'.dona-maintenance/offline-active.json')
    chain, seen = [], set()
    for _ in range(64):
        require(Path(owner['run']).is_absolute(), 'offline_lineage_invalid')
        run = Path(owner['run']).resolve()
        require(run.is_absolute() and str(run) not in seen, 'offline_lineage_invalid')
        seen.add(str(run))
        plan, journal, inventory = (read(run/name) for name in ('plan.json', 'journal.json', 'inventory.json'))
        require(owner['plan_hash'] == journal['plan_hash'] == digest((run/'plan.json').read_bytes()) and
                plan['inventory_hash'] == digest((run/'inventory.json').read_bytes()), 'offline_lineage_seal_mismatch')
        require(journal['phase'] in ('succeeded', 'rolled_back', 'aborted') and
                (not journal.get('source_recreation_detected') or
                 (journal['phase'] == 'rolled_back' and offline.recreation_reconciled(journal))), 'offline_lineage_not_terminal')
        chain.append((plan, inventory, journal['phase']))
        if run == Path(seed_run).resolve():
            require(plan.get('mode') == 'fresh_generation' and journal['phase'] == 'succeeded', 'offline_lineage_seed_invalid')
            generation = Path(plan['generation'])
            paths = [str(generation/name) for name in ('dona.sqlite3', 'update-notifications.sqlite3', 'job-progress.sqlite3', 'control/updater.sqlite3')]
            results = [str(generation/name) for name in ('results', 'job-results')]
            roots = [generation] * 6
            for descendant, source, phase in reversed(chain[:-1]):
                require(source['databases'] == paths and source['old_results'] == results, 'offline_lineage_storage_mismatch')
                # 正規の復旧・中止は更新元の4DBを維持する。次回成功runからもたどれる。
                if phase == 'succeeded':
                    require(descendant.get('mode') != 'fresh_generation', 'new_fresh_cutover_requires_inventory')
                    require(descendant.get('mode') == 'preserve', 'offline_lineage_storage_mismatch')
                    next_root = Path(descendant['generation'])
                    paths = paths[:3] + [str(next_root/'control/updater.sqlite3')]
                    roots[3] = next_root
            return paths, results, roots
        owner = plan.get('previous_offline_run')
        require(isinstance(owner, dict), 'offline_lineage_missing')
    raise RuntimeError('offline_lineage_too_deep')


def expected_databases(seed_run, owner_path=None):
    return expected_storage(seed_run, owner_path)[0]


def verify_storage_roots(paths, roots):
    require(len(paths) == len(roots), 'storage_root_mapping_invalid')
    for value, generation in zip(paths, roots):
        root = Path(generation)
        require(root.is_absolute() and root.is_dir() and not root.is_symlink(), 'generation_root_not_regular')
        require(Path(value).resolve().is_relative_to(root.resolve()), 'storage_outside_generation')


def verify_result_directories(current, old):
    identities = set()
    for value in current:
        directory = Path(value)
        require(directory.is_dir() and not directory.is_symlink(), 'result_directory_not_regular')
        info = directory.stat(); identities.add((info.st_dev, info.st_ino))
    require(len(identities) == len(current), 'result_directory_overlap')
    current_roots, old_roots = ([Path(value).resolve() for value in paths] for paths in (current, old))
    for index, root in enumerate(current_roots):
        for other in old_roots + current_roots[:index]:
            require(root != other and root not in other.parents and other not in root.parents, 'result_directory_overlap')
    for value in old:
        directory = Path(value)
        if directory.exists():
            info = directory.stat()
            require(stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino) not in identities, 'result_directory_overlap')


def verify_no_recreation(run, workspace):
    old = read(run/'inventory.json')
    current = maintenance.inventory(require_running=True)
    require(current['old_pointer'] != old['old_pointer'], 'old_release_restored')
    databases, results, roots = expected_storage(run)
    require(current['databases'] == databases and current['old_results'] == results, 'handoff_generation_mismatch')
    verify_storage_roots(databases + results, roots)
    verify_result_directories(current['old_results'], old['old_results'])
    require(not set(current['databases']) & set(old['databases']), 'old_database_reactivated')
    require(not database_identities(current['databases']) & database_identities(old['databases']), 'old_database_reactivated')
    raw = subprocess.check_output(['/bin/ps', '-axo', 'pid=,ppid=,uid=,args='], text=True)
    rows, parents = [], {}
    for line in raw.splitlines():
        fields = line.strip().split(None, 3)
        require(len(fields) == 4, 'process_command_table_invalid')
        pid, parent, uid = map(int, fields[:3])
        rows.append((pid, uid, fields[3]));parents[pid] = parent
    exempt = set()
    pid = os.getpid()
    while pid and pid not in exempt:
        exempt.add(pid);pid = parents.get(pid, 0)
    # operator自身とancestorのargvは引数に旧pathを含み得るため除外する。cwdは除外しない。
    output = subprocess.run(['/usr/sbin/lsof', '-n', '-a', '-u', str(os.getuid()), '-d', 'cwd', '-F', 'pn'],
                            capture_output=True, text=True, timeout=30)
    require(output.returncode == 0, 'process_cwd_observation_failed')
    cwds, pid = {}, None
    for line in output.stdout.splitlines():
        if line.startswith('p'):pid = int(line[1:])
        elif line.startswith('n') and pid is not None:cwds[pid] = Path(line[1:]).resolve()
    for pid, uid, _ in rows:
        if uid != os.getuid() or pid in exempt or pid in cwds:
            continue
        state = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True, timeout=5)
        require(state.returncode != 0 or 'Z' in state.stdout, 'process_cwd_observation_incomplete')
    assert_no_retired_process(rows, cwds, retired_roots(old, workspace), exempt)


def verify_cutover(run, expected=None):
    run = Path(run)
    plan, journal = read(run/'plan.json'), read(run/'journal.json')
    seals = {name: digest((run/name).read_bytes()) for name in ['plan.json', 'journal.json', 'inventory.json', 'backup/index.json']}
    if expected is not None:
        require(seals == expected, 'cutover_evidence_changed')
    require(plan.get('mode') == 'fresh_generation' and journal.get('phase') == 'succeeded' and not journal.get('source_recreation_detected'), 'fresh_cutover_not_succeeded')
    require(journal['plan_hash'] == seals['plan.json'] and plan['inventory_hash'] == seals['inventory.json'] and journal['backup_index_hash'] == seals['backup/index.json'], 'cutover_seal_mismatch')
    receipt = journal.get('source_stop_receipt', {})
    require(isinstance(receipt.get('processes'), list) and receipt.get('verified_at') and
            (journal.get('source_stop_guard') or {}).get('phase') == 'committed' and
            receipt.get('herdr_session') == 'dona' and
            receipt.get('herdr_config_sha256') == plan.get('bundle', {}).get('herdr-config.toml') and
            isinstance(receipt.get('herdr_config_sha256'), str) and
            set(receipt.get('launch_agents', [])) == {'dev.dona.dispatcher', 'dev.dona.slack-adapter', 'dev.dona.updater'}, 'cutover_stop_evidence_missing')
    rows = subprocess.check_output(['/bin/ps', '-axo', 'pid=,uid=,lstart=,stat='], text=True).splitlines()
    processes = {}
    for row in rows:
        parts = row.split()
        require(len(parts) == 8, 'process_table_invalid')
        processes[int(parts[0])] = (int(parts[1]), ' '.join(parts[2:7]), parts[7])
    for old in receipt['processes']:
        current = processes.get(old['pid'])
        require(not current or current[:2] != (old['uid'], old['start']) or 'Z' in current[2], 'old_process_still_alive')
    entries = read(run/'backup/index.json')
    databases = [item for item in entries if not item.get('directory')]
    source_databases = read(run/'inventory.json')['databases']
    require(len(databases) == len(source_databases) == 4 and len(set(source_databases)) == 4 and
            [item.get('source') for item in databases] == source_databases, 'old_database_backup_incomplete')
    for item in databases:
        require(item.get('exists') is True and isinstance(item.get('backup'), str) and
                isinstance(item.get('hash'), str), 'old_database_backup_incomplete')
        backup = Path(item['backup'])
        require(backup.is_file() and not backup.is_symlink(), 'old_database_backup_incomplete')
        require(digest(backup.read_bytes()) == item['hash'], 'old_database_backup_changed')
    return seals


def key(repository, issue):
    require(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository) and issue > 0, 'issue_identity_invalid')
    return repository.replace('/', '--') + '--' + str(issue) + '.json'


def inspect(root, repository, issue, legacy_job):
    value = read(root/key(repository, issue))
    require(value.get('schema_version') == 1 and value['repository'] == repository and value['issue_number'] == issue
            and value['legacy_job_id'] == legacy_job, 'handoff_identity_mismatch')
    verify_cutover(value['cutover_run'], value['cutover_seals'])
    verify_no_recreation(Path(value['cutover_run']), value['workspace'])
    require(fingerprint(value['workspace']) == value['workspace_fingerprint'], 'legacy_workspace_changed')
    return {**value, 'verified': True, 'scope': '旧Dona管理下の停止記録と旧成果の一致。外部操作の完了証明・再実行許可ではない。'}



def publish_record(target, value):
    payload = json.dumps(value, ensure_ascii=False, indent=2).encode()
    descriptor, temporary = tempfile.mkstemp(prefix='.record-', suffix='.tmp', dir=target.parent)
    try:
        with os.fdopen(descriptor, 'wb') as file:
            file.write(payload)
            file.flush()
            os.fsync(file.fileno())
        try:
            # 完成済みinodeを原子的に公開する。競合時も既存recordを上書きしない。
            os.link(temporary, target)
        except FileExistsError:
            require(read(target) == value, 'handoff_record_conflict')
        directory = os.open(target.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['record', 'inspect'])
    parser.add_argument('--repository', required=True)
    parser.add_argument('--issue', type=int, required=True)
    parser.add_argument('--legacy-job', required=True)
    parser.add_argument('--run', type=Path)
    parser.add_argument('--workspace', type=Path)
    parser.add_argument('--issue-node')
    parser.add_argument('--project-item')
    args = parser.parse_args()
    require(re.fullmatch(r'job_[0-9a-z]+', args.legacy_job), 'legacy_job_invalid')
    target = ROOT/key(args.repository, args.issue)
    if args.action == 'record':
        require(args.run and args.workspace and args.issue_node and args.project_item, 'record_identity_required')
        require(args.workspace.name == args.legacy_job, 'workspace_job_mismatch')
        value = {'schema_version': 1, 'repository': args.repository, 'issue_number': args.issue,
                 'issue_node_id': args.issue_node, 'project_item_id': args.project_item,
                 'legacy_job_id': args.legacy_job, 'workspace': str(args.workspace.resolve()),
                 'workspace_fingerprint': fingerprint(args.workspace), 'cutover_run': str(args.run.resolve()),
                 'cutover_seals': verify_cutover(args.run)}
        verify_no_recreation(args.run, args.workspace)
        ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
        publish_record(target, value)
    print(json.dumps(inspect(ROOT, args.repository, args.issue, args.legacy_job), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)
