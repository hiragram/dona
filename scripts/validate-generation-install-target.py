#!/usr/bin/env python3
"""Validate an explicitly selected installed generation before control upgrade."""
import inspect
import json
import os
from pathlib import Path
import plistlib
import re
import sys


def require(condition):
    if not condition:
        raise RuntimeError(f'selected generation check failed at {inspect.currentframe().f_back.f_lineno}')


def regular(path):
    require(path.is_file() and not path.is_symlink())
    return path


def main():
    root, rendered, launch_agents = map(Path, sys.argv[1:])
    generation_parent = Path.home() / '.dona' / 'g'
    require(root.parent == generation_parent and re.fullmatch(r'[0-9a-f]{12}', root.name))
    require(root.is_dir() and not root.is_symlink())
    for suffix in ('control', 'control/updater', 'runtime', 'runtime/releases', 'config', 'logs', 'run'):
        entry = root / suffix
        require(entry.is_dir() and not entry.is_symlink())
    control = root / 'control'
    policy = json.loads(regular(control / 'policy.json').read_text())
    expected = {
        'control_root': control,
        'config_root': root / 'config',
        'release_root': root / 'runtime/releases',
        'current_pointer': root / 'runtime/current',
        'dispatcher_socket': root / 'run/d.sock',
        'slack_socket': root / 'run/s.sock',
        'dispatcher_internal_token_file': control / 'dispatcher.token',
    }
    require(all(policy.get(key) == str(value) for key, value in expected.items()))
    current = root / 'runtime/current'
    require(current.is_symlink())
    active = current.resolve(strict=True)
    require(active.parent == root / 'runtime/releases' and re.fullmatch(r'[0-9a-f]{40}', active.name))
    old_updater_sha = None
    for label in ('dev.dona.updater', 'dev.dona.dispatcher'):
        installed = plistlib.loads(regular(launch_agents / (label + '.plist')).read_bytes())
        candidate_file = rendered / (label + '.plist')
        candidate = plistlib.loads(regular(candidate_file).read_bytes())
        require(installed.get('Label') == label and candidate.get('Label') == label)
        argv = installed.get('ProgramArguments', [])
        expected_program = control / 'updater/dist/cli.js' if label.endswith('updater') else current / 'dispatcher/dist/cli.js'
        require(len(argv) == 3 and argv[1] == str(expected_program) and argv[2] == 'serve')
        env = installed.get('EnvironmentVariables', {})
        require(isinstance(env, dict))
        if label.endswith('updater'):
            require(env.get('DONA_UPDATE_POLICY_PATH') == str(control / 'policy.json'))
            require(re.fullmatch(r'[0-9a-f]{40}', env.get('DONA_UPDATER_BUILD_SHA', '')))
            old_updater_sha = env['DONA_UPDATER_BUILD_SHA']
        else:
            require(env.get('DONA_UPDATER_SOCKET_PATH') == str(control / 'updater.sock'))
            require(env.get('DONA_UPDATE_INTERNAL_TOKEN_PATH') == str(control / 'dispatcher.token'))
            require(env.get('DONA_SOCKET_PATH') == str(root / 'run/d.sock'))
            require(env.get('SLACK_HEALTH_SOCKET_PATH') == str(root / 'run/s.sock'))
            require(env.get('DONA_DATABASE_PATH') == str(root / 'dona.sqlite3'))
            require(env.get('DONA_RELEASE_MANIFEST_PATH') == str(current / 'release-manifest.json'))
            for key, suffix in {
                'DONA_RESULTS_DIR': 'results',
                'DONA_JOB_RESULTS_DIR': 'job-results',
                'DONA_JOB_PROGRESS_DATABASE_PATH': 'job-progress.sqlite3',
                'DONA_UPDATE_NOTIFICATION_DATABASE_PATH': 'update-notifications.sqlite3',
                'DOTENV_CONFIG_PATH': 'config/dispatcher.env',
            }.items():
                require(env.get(key) == str(root / suffix))
            # Keep generation-specific environment that the generic template does not describe.
            updated = dict(env)
            updated.update(candidate['EnvironmentVariables'])
            candidate['EnvironmentVariables'] = updated
            candidate_file.write_bytes(plistlib.dumps(candidate))
            os.chmod(candidate_file, 0o600)
    receipt = control / 'control-plane-receipt.json'
    if receipt.exists():
        regular(receipt)
    database = control / 'updater.sqlite3'
    require(regular(database))
    print(old_updater_sha)


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 4)
        main()
    except (OSError, ValueError, KeyError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
