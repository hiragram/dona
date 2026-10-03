#!/usr/bin/env python3
"""外部operatorが保存した旧世代成果の照合。workerの起動・停止やDB変更は行わない。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

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
        untracked.append({'path': name, 'sha256': digest(p.read_bytes())})
    return {'head': head, 'diff_sha256': digest(diff), 'untracked': untracked}


def verify_cutover(run, expected=None):
    run = Path(run)
    plan, journal = read(run/'plan.json'), read(run/'journal.json')
    seals = {name: digest((run/name).read_bytes()) for name in ['plan.json', 'journal.json', 'inventory.json', 'backup/index.json']}
    if expected is not None:
        require(seals == expected, 'cutover_evidence_changed')
    require(plan.get('mode') == 'fresh_generation' and journal.get('phase') == 'succeeded', 'fresh_cutover_not_succeeded')
    require(journal['plan_hash'] == seals['plan.json'] and plan['inventory_hash'] == seals['inventory.json'] and journal['backup_index_hash'] == seals['backup/index.json'], 'cutover_seal_mismatch')
    receipt = journal.get('source_stop_receipt', {})
    require(receipt.get('processes') and receipt.get('herdr_session') == 'dona' and
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
    require(len([item for item in entries if not item.get('directory')]) == 4, 'old_database_backup_incomplete')
    for item in entries:
        if item['exists'] and not item.get('directory'):
            require(digest(Path(item['backup']).read_bytes()) == item['hash'], 'old_database_backup_changed')
    return seals


def key(repository, issue):
    require(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository) and issue > 0, 'issue_identity_invalid')
    return repository.replace('/', '--') + '--' + str(issue) + '.json'


def inspect(root, repository, issue, legacy_job):
    value = read(root/key(repository, issue))
    require(value.get('schema_version') == 1 and value['repository'] == repository and value['issue_number'] == issue
            and value['legacy_job_id'] == legacy_job, 'handoff_identity_mismatch')
    verify_cutover(value['cutover_run'], value['cutover_seals'])
    require(fingerprint(value['workspace']) == value['workspace_fingerprint'], 'legacy_workspace_changed')
    return {**value, 'verified': True, 'scope': '旧Dona管理下の停止記録と旧成果の一致。外部操作の完了証明・再実行許可ではない。'}


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
        ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
        # operatorのみ作成する。既存recordは上書きせず、異内容なら照合へ戻す。
        if target.exists():
            require(read(target) == value, 'handoff_record_conflict')
        else:
            with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as file:
                json.dump(value, file, ensure_ascii=False, indent=2)
                file.flush()
                os.fsync(file.fileno())
    print(json.dumps(inspect(ROOT, args.repository, args.issue, args.legacy_job), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)
