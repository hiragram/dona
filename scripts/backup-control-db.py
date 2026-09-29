#!/usr/bin/env python3
"""Create and verify an offline-restorable SQLite control DB backup."""

import os
import sqlite3
import stat
import sys
from pathlib import Path


def verify(db):
    if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
        raise RuntimeError("control database integrity check failed")
    if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise RuntimeError("control database foreign key check failed")
    return (
        db.execute("PRAGMA user_version").fetchone()[0],
        db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()[0],
        db.execute("SELECT COUNT(*) FROM update_requests").fetchone()[0],
    )


def backup(source, target):
    source_stat = os.lstat(source)
    if (
        not stat.S_ISREG(source_stat.st_mode)
        or source_stat.st_uid != os.getuid()
        or source_stat.st_nlink != 1
        or source_stat.st_mode & 0o077
        or os.path.lexists(target)
    ):
        raise RuntimeError("control backup source or destination is invalid")
    original = sqlite3.connect(Path(source).as_uri() + "?mode=ro", uri=True)
    try:
        before = verify(original)
        copied = sqlite3.connect(target)
        try:
            original.backup(copied)
            copied.commit()
        finally:
            copied.close()
        os.chmod(target, 0o600)
        with sqlite3.connect(Path(target).as_uri() + "?mode=ro", uri=True) as restored:
            after = verify(restored)
        if before != after:
            raise RuntimeError("control backup inventory differs from source")
        directory = os.open(os.path.dirname(target), os.O_RDONLY)
        try:
            with open(target, "rb") as file:
                os.fsync(file.fileno())
            os.fsync(directory)
        finally:
            os.close(directory)
    except Exception:
        if os.path.exists(target):
            os.unlink(target)
        raise
    finally:
        original.close()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: backup-control-db.py <source> <target>")
    backup(sys.argv[1], sys.argv[2])
