from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any


LOGGER = logging.getLogger(__name__)

class SaveJournal:
    """Small durable ledger for browser-save files that outlive one response."""

    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "save-journal.sqlite3"
        self._lock = threading.RLock()
        data_dir.mkdir(parents=True, exist_ok=True)
        with self._connection() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS saves (
                token TEXT PRIMARY KEY, image_id TEXT NOT NULL, revision INTEGER NOT NULL,
                state TEXT NOT NULL, destination TEXT, staged TEXT, staged_mtime INTEGER,
                staged_size INTEGER, staged_identity TEXT, destination_mtime INTEGER, destination_size INTEGER, quarantine TEXT, cleared INTEGER, stale INTEGER,
                deleted INTEGER, catalog_generation INTEGER, destination_identity TEXT,
                source_path TEXT, source_identity TEXT, quarantine_mtime INTEGER, quarantine_size INTEGER, quarantine_identity TEXT,
                replacement_mtime INTEGER, replacement_size INTEGER, replacement_identity TEXT,
                recovery_decision TEXT, cleanup_note TEXT, updated_at INTEGER NOT NULL
            )""")
            # Renames cross the filesystem and the workspace database.  Keep a
            # very small durable intent so a stop between those two operations
            # can be reconciled on the next launch.
            db.execute("""CREATE TABLE IF NOT EXISTS rename_operations (
                token TEXT PRIMARY KEY, kind TEXT NOT NULL, image_id TEXT NOT NULL,
                catalog_id TEXT, source_id TEXT, old_path TEXT NOT NULL, new_path TEXT NOT NULL,
                old_relative TEXT, new_relative TEXT, identity TEXT, state TEXT NOT NULL, updated_at INTEGER NOT NULL
            )""")
            rename_columns = {row[1] for row in db.execute("PRAGMA table_info(rename_operations)")}
            if "identity" not in rename_columns:
                db.execute("ALTER TABLE rename_operations ADD COLUMN identity TEXT")
            columns = {row[1] for row in db.execute("PRAGMA table_info(saves)")}
            for column in ("staged_identity", "destination_identity", "source_path", "source_identity", "quarantine_mtime", "quarantine_size", "quarantine_identity", "replacement_mtime", "replacement_size", "replacement_identity", "recovery_decision", "cleanup_note"):
                if column not in columns:
                    column_type = "INTEGER" if column in {"quarantine_mtime", "quarantine_size", "replacement_mtime", "replacement_size"} else "TEXT"
                    db.execute(f"ALTER TABLE saves ADD COLUMN {column} {column_type}")
            # Older journals did not record which side of the workspace
            # transaction had won.  Do not infer it from diagnostic text.
            # cleanup_pending is resolved against the authoritative receipt on
            # first recovery; every other historical state has one safe side.
            db.execute("""UPDATE saves SET recovery_decision=CASE state
                WHEN 'committed' THEN 'commit' WHEN 'workspace_committed' THEN 'commit'
                WHEN 'cleanup_pending' THEN NULL ELSE 'rollback' END
                WHERE recovery_decision IS NULL OR recovery_decision NOT IN ('rollback','commit')""")

    @contextmanager
    def _connection(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.execute("PRAGMA busy_timeout=5000")
        try:
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def reserve(self, token: str, image_id: str, revision: int, destination: Path | None, staged: Path | None) -> None:
        with self._lock, self._connection() as db:
            existing = db.execute("SELECT image_id,revision FROM saves WHERE token=?", (token,)).fetchone()
            if existing is not None:
                if str(existing[0]) != image_id or int(existing[1]) != revision:
                    raise ValueError("save token belongs to another image")
                return
            db.execute("""INSERT INTO saves(token,image_id,revision,state,destination,staged,recovery_decision,updated_at)
                VALUES(?,?,?,?,?,?,?,?)""",
                (token, image_id, revision, "rendering", str(destination) if destination else None, str(staged) if staged else None, "rollback", time.time_ns()))

    def decide_commit(self, token: str) -> None:
        with self._lock, self._connection() as db:
            db.execute("UPDATE saves SET recovery_decision='commit',updated_at=? WHERE token=?", (time.time_ns(), token))

    def update_stage(self, token: str, staged: Path | None, fingerprint: tuple[int, int] | None) -> None:
        identity = None
        if staged is not None:
            try: identity = self.file_identity(staged)
            except OSError: identity = None
        with self._lock, self._connection() as db:
            db.execute("UPDATE saves SET state='pending',staged=?,staged_mtime=?,staged_size=?,staged_identity=?,updated_at=? WHERE token=?",
                (str(staged) if staged else None, fingerprint[0] if fingerprint else None, fingerprint[1] if fingerprint else None, identity, time.time_ns(), token))

    def destination(self, token: str, destination: Path) -> None:
        with self._lock, self._connection() as db:
            db.execute("UPDATE saves SET destination=?,updated_at=? WHERE token=?", (str(destination), time.time_ns(), token))

    def placeholder(self, token: str, identity: str | None) -> None:
        """Record exclusive ownership before any bytes reach the final name."""
        with self._lock, self._connection() as db:
            db.execute("UPDATE saves SET destination_identity=?,updated_at=? WHERE token=?",
                (identity, time.time_ns(), token))

    def published(self, token: str, fingerprint: tuple[int, int], identity: str | None) -> None:
        with self._lock, self._connection() as db:
            db.execute("UPDATE saves SET state='published',destination_mtime=?,destination_size=?,destination_identity=?,updated_at=? WHERE token=?",
                (fingerprint[0], fingerprint[1], identity, time.time_ns(), token))

    def phase(self, token: str, state: str, quarantine: Path | None = None) -> None:
        with self._lock, self._connection() as db:
            db.execute("UPDATE saves SET state=?,quarantine=COALESCE(?,quarantine),updated_at=? WHERE token=?", (state, str(quarantine) if quarantine else None, time.time_ns(), token))

    def quarantine(self, token: str, source: Path, path: Path, fingerprint: tuple[int, int], identity: str | None) -> None:
        """Persist the source ownership proof before it is renamed away."""
        with self._lock, self._connection() as db:
            db.execute("UPDATE saves SET source_path=?,quarantine=?,quarantine_mtime=?,quarantine_size=?,quarantine_identity=?,updated_at=? WHERE token=?",
                (str(source), str(path), fingerprint[0], fingerprint[1], identity, time.time_ns(), token))

    def replacement_backup(
        self,
        token: str,
        source: Path,
        backup: Path,
        backup_fingerprint: tuple[int, int],
        backup_identity: str | None,
        source_identity: str | None,
        replacement_fingerprint: tuple[int, int],
        replacement_identity: str | None,
    ) -> None:
        """Record both sides before replacing a source with a staged render."""
        with self._lock, self._connection() as db:
            db.execute("""UPDATE saves SET source_path=?,source_identity=?,quarantine=?,quarantine_mtime=?,quarantine_size=?,quarantine_identity=?,
                replacement_mtime=?,replacement_size=?,replacement_identity=?,updated_at=? WHERE token=?""", (
                str(source), source_identity, str(backup), backup_fingerprint[0], backup_fingerprint[1], backup_identity,
                replacement_fingerprint[0], replacement_fingerprint[1], replacement_identity, time.time_ns(), token,
            ))

    def clear_quarantine(self, token: str) -> None:
        """Abandon a pre-rename quarantine intent that never moved its source."""
        with self._lock, self._connection() as db:
            db.execute("""UPDATE saves SET state='published',source_path=NULL,source_identity=NULL,quarantine=NULL,
                quarantine_mtime=NULL,quarantine_size=NULL,quarantine_identity=NULL,updated_at=? WHERE token=?""",
                (time.time_ns(), token))

    def finish(self, token: str, cleared: bool, stale: bool, deleted: bool, catalog_generation: int) -> None:
        with self._lock, self._connection() as db:
            db.execute("UPDATE saves SET state='committed',recovery_decision='commit',cleared=?,stale=?,deleted=?,catalog_generation=?,updated_at=? WHERE token=?",
                (int(cleared), int(stale), int(deleted), catalog_generation, time.time_ns(), token))

    def cleanup(self, token: str) -> bool:
        """Cancel an uncommitted token through the same durable recovery path."""
        with self._lock, self._connection() as db:
            db.execute("UPDATE saves SET state='cleanup_pending',recovery_decision='rollback',updated_at=? WHERE token=?", (time.time_ns(), token))
        return self.recover_token(token)

    def row(self, token: str) -> dict[str, Any] | None:
        with self._lock, self._connection() as db:
            db.row_factory = sqlite3.Row
            row = db.execute("SELECT * FROM saves WHERE token=?", (token,)).fetchone()
            return dict(row) if row is not None else None

    def acknowledge(self, token: str) -> bool:
        with self._lock, self._connection() as db:
            row = db.execute("SELECT state FROM saves WHERE token=?", (token,)).fetchone()
            if row is None: return True
            if str(row[0]) != "committed": return False
            db.execute("DELETE FROM saves WHERE token=?", (token,))
            return True

    def prepare_rename(self, token: str, *, kind: str, image_id: str, old_path: Path, new_path: Path,
                       catalog_id: str | None = None, source_id: str | None = None,
                       old_relative: str | None = None, new_relative: str | None = None, identity: str | None = None) -> None:
        with self._lock, self._connection() as db:
            db.execute("""INSERT OR REPLACE INTO rename_operations
                (token,kind,image_id,catalog_id,source_id,old_path,new_path,old_relative,new_relative,identity,state,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""", (
                    token, kind, image_id, catalog_id, source_id, str(old_path), str(new_path),
                    old_relative, new_relative, identity, "prepared", time.time_ns(),
                ))

    def finish_rename(self, token: str) -> None:
        with self._lock, self._connection() as db:
            db.execute("DELETE FROM rename_operations WHERE token=?", (token,))

    def recover_renames(self, recover: Any) -> None:
        """Reconcile every unfinished rename from the filesystem's current state."""
        with self._lock, self._connection() as db:
            db.row_factory = sqlite3.Row
            rows = [dict(row) for row in db.execute("SELECT * FROM rename_operations")]
        for row in rows:
            try:
                complete = bool(recover(row))
            except Exception as exc:
                LOGGER.warning("名前変更ジャーナルの回復を保留しました: %s", exc)
                continue
            if complete:
                self.finish_rename(str(row["token"]))

    @staticmethod
    def _identity(stat: os.stat_result) -> str | None:
        # Windows exposes the volume serial/file index through st_dev/st_ino
        # where the filesystem supports it.  SMB/FAT may not, so never guess.
        if not stat.st_dev or not stat.st_ino: return None
        return f"{stat.st_dev:x}:{stat.st_ino:x}"

    @staticmethod
    def _windows_handle_identity(handle: int) -> str | None:
        if os.name != "nt": return None
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        class FileIdInfo(ctypes.Structure):
            _fields_ = [("volume", ctypes.c_ulonglong), ("file_id", ctypes.c_ubyte * 16)]
        get_id = kernel32.GetFileInformationByHandleEx
        get_id.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
        get_id.restype = wintypes.BOOL
        file_id = FileIdInfo()
        # FileIdInfo (18) has a 128-bit identifier on ReFS and NTFS.
        if get_id(wintypes.HANDLE(handle), 18, ctypes.byref(file_id), ctypes.sizeof(file_id)):
            raw_id = bytes(file_id.file_id)
            # FILE_ID_INFO documents an all-zero FileId as unsupported.  It is
            # not ownership evidence, even if an older filesystem reports it.
            if raw_id == b"\0" * len(raw_id):
                return None
            return f"{file_id.volume:x}:{raw_id.hex()}"
        # Never downgrade to the legacy 64-bit FileIndex.  A filesystem that
        # cannot provide FILE_ID_INFO has no Windows ownership proof here.
        return None

    @classmethod
    def file_identity(cls, path: Path, stat: os.stat_result | None = None) -> str | None:
        if os.name != "nt": return cls._identity(stat if stat is not None else path.stat())
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        create = kernel32.CreateFileW
        create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        create.restype = wintypes.HANDLE
        close = kernel32.CloseHandle; close.argtypes = [wintypes.HANDLE]; close.restype = wintypes.BOOL
        handle = create(str(path), 0x80, 0x7, None, 3, 0x80, None)
        if handle == wintypes.HANDLE(-1).value: return None
        try: return cls._windows_handle_identity(handle)
        finally: close(handle)

    @classmethod
    def _delete_windows_owned(cls, target: Path, identity: str) -> bool:
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        # Deny FILE_SHARE_DELETE while this handle is open. A rename/delete
        # from another process cannot race between this identity check and the
        # delete disposition applied to this very handle.
        create = kernel32.CreateFileW
        create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        create.restype = wintypes.HANDLE
        close = kernel32.CloseHandle; close.argtypes = [wintypes.HANDLE]; close.restype = wintypes.BOOL
        disposition = kernel32.SetFileInformationByHandle
        disposition.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]; disposition.restype = wintypes.BOOL
        handle = create(str(target), 0x10080, 0x3, None, 3, 0x80, None)
        if handle == wintypes.HANDLE(-1).value:
            error = ctypes.get_last_error()
            return error == 2
        try:
            if cls._windows_handle_identity(handle) != identity: return False
            class FileDispositionInfo(ctypes.Structure): _fields_ = [("delete_file", wintypes.BOOL)]
            info = FileDispositionInfo(True)
            return bool(disposition(wintypes.HANDLE(handle), 4, ctypes.byref(info), ctypes.sizeof(info)))
        finally: close(handle)

    @classmethod
    def _unlink(cls, path: str | None, mtime: int | None = None, size: int | None = None, identity: str | None = None, *, require_identity: bool = False) -> bool:
        if not path: return True
        target = Path(path)
        try: stat = target.stat()
        except FileNotFoundError:
            cls._cleanup_staging_parent(target)
            return True
        except OSError: return False
        if mtime is not None and (stat.st_mtime_ns != mtime or stat.st_size != size): return False
        # Final outputs are deleted only when the exclusive creator's file ID
        # remains present.  A filesystem without a stable ID leaves the file
        # for an explicit recovery decision instead of risking another process.
        if require_identity and identity is None: return False
        current_identity = cls.file_identity(target, stat)
        if identity is not None and current_identity != identity: return False
        if os.name == "nt" and identity is not None:
            deleted = cls._delete_windows_owned(target, identity)
            if deleted: cls._cleanup_staging_parent(target)
            return deleted
        if require_identity:
            # POSIX unlink is path based; without an unlink-by-handle API a
            # replacement can race after fstat. Preserve the final instead of
            # risking deletion of another process's same-name file.
            return False
        try: target.unlink()
        except FileNotFoundError:
            cls._cleanup_staging_parent(target)
            return True
        except OSError: return False
        cls._cleanup_staging_parent(target)
        try: target.stat()
        except FileNotFoundError: return True
        except OSError: return False
        return False

    @staticmethod
    def _cleanup_staging_parent(target: Path) -> None:
        """Remove only this save's now-empty staging directory; never sweep parents."""
        if target.parent.name != ".mozarie-staging":
            return
        try:
            target.parent.rmdir()
        except OSError:
            pass

    @classmethod
    def _rename_windows_handle(cls, handle: int, target: Path, identity: str) -> bool:
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        set_info = kernel32.SetFileInformationByHandle
        set_info.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]; set_info.restype = wintypes.BOOL
        if cls._windows_handle_identity(handle) != identity:
            return False
        name = str(target); encoded = name.encode("utf-16-le")
        class FileRenameInfo(ctypes.Structure):
            _fields_ = [("replace_if_exists", wintypes.BOOL), ("root_directory", wintypes.HANDLE),
                        ("name_length", wintypes.DWORD), ("name", wintypes.WCHAR * 1)]
        size = FileRenameInfo.name.offset + len(encoded) + 2
        buffer = ctypes.create_string_buffer(size)
        info = ctypes.cast(buffer, ctypes.POINTER(FileRenameInfo)).contents
        info.replace_if_exists = False; info.root_directory = None; info.name_length = len(encoded)
        ctypes.memmove(ctypes.addressof(buffer) + FileRenameInfo.name.offset, encoded + b"\0\0", info.name_length + 2)
        return bool(set_info(wintypes.HANDLE(handle), 3, ctypes.byref(buffer), size))

    def publish_staged_windows(self, token: str, staged: Path, destination: Path) -> str | None:
        """Publish a stage through the same verified handle that names it."""
        if os.name != "nt":
            return None
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        create = kernel32.CreateFileW
        create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        create.restype = wintypes.HANDLE
        close = kernel32.CloseHandle; close.argtypes = [wintypes.HANDLE]; close.restype = wintypes.BOOL
        # Share reads only until rename and journal ownership recording finish.
        # A competing writer or replacement must fail rather than mutating the
        # file between its FILE_ID_INFO check and publication.
        handle = create(str(staged), 0x10080, 0x1, None, 3, 0x80, None)
        if handle == wintypes.HANDLE(-1).value:
            return None
        try:
            identity = self._windows_handle_identity(handle)
            if identity is None or not self._rename_windows_handle(handle, destination, identity):
                return None
            self.placeholder(token, identity)
            return identity
        finally:
            close(handle)

    @classmethod
    def _rename_windows_owned(cls, quarantine: Path, source: Path, identity: str) -> bool:
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        create = kernel32.CreateFileW
        create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        create.restype = wintypes.HANDLE
        close = kernel32.CloseHandle; close.argtypes = [wintypes.HANDLE]; close.restype = wintypes.BOOL
        handle = create(str(quarantine), 0x10080, 0x3, None, 3, 0x80, None)
        if handle == wintypes.HANDLE(-1).value:
            return ctypes.get_last_error() == 2
        try: return cls._rename_windows_handle(handle, source, identity)
        finally: close(handle)

    @staticmethod
    def _windows_handle_fingerprint(handle: int) -> tuple[int, int] | None:
        if os.name != "nt":
            return None
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        class ByHandleFileInformation(ctypes.Structure):
            _fields_ = [("attributes", wintypes.DWORD), ("created", wintypes.FILETIME),
                        ("accessed", wintypes.FILETIME), ("written", wintypes.FILETIME),
                        ("volume", wintypes.DWORD), ("size_high", wintypes.DWORD),
                        ("size_low", wintypes.DWORD), ("links", wintypes.DWORD),
                        ("index_high", wintypes.DWORD), ("index_low", wintypes.DWORD)]
        get_info = kernel32.GetFileInformationByHandle
        get_info.argtypes = [wintypes.HANDLE, ctypes.POINTER(ByHandleFileInformation)]
        get_info.restype = wintypes.BOOL
        info = ByHandleFileInformation()
        if not get_info(wintypes.HANDLE(handle), ctypes.byref(info)):
            return None
        ticks = (int(info.written.dwHighDateTime) << 32) | int(info.written.dwLowDateTime)
        return ((ticks - 116444736000000000) * 100, (int(info.size_high) << 32) | int(info.size_low))

    @classmethod
    def rename_windows_verified(cls, source: Path, destination: Path, identity: str,
                                fingerprint: tuple[int, int]) -> bool:
        """Rename only the source held by a handle matching its prepared metadata."""
        if os.name != "nt":
            return False
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        create = kernel32.CreateFileW
        create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        create.restype = wintypes.HANDLE
        close = kernel32.CloseHandle; close.argtypes = [wintypes.HANDLE]; close.restype = wintypes.BOOL
        # Keep the verified source immutable until its no-replace rename.
        handle = create(str(source), 0x10080, 0x1, None, 3, 0x80, None)
        if handle == wintypes.HANDLE(-1).value:
            return False
        try:
            return (cls._windows_handle_identity(handle) == identity
                    and cls._windows_handle_fingerprint(handle) == fingerprint
                    and cls._rename_windows_handle(handle, destination, identity))
        finally:
            close(handle)

    @classmethod
    def delete_windows_verified(cls, target: Path, identity: str) -> bool:
        """Delete only the file currently held by its verified Windows handle."""
        return os.name == "nt" and cls._delete_windows_owned(target, identity)

    def quarantine_source(self, token: str, source: Path, quarantine: Path) -> bool:
        """Atomically move a verified Windows source into its journaled quarantine."""
        if os.name != "nt":
            return False
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        create = kernel32.CreateFileW
        create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        create.restype = wintypes.HANDLE
        close = kernel32.CloseHandle; close.argtypes = [wintypes.HANDLE]; close.restype = wintypes.BOOL
        handle = create(str(source), 0x10080, 0x3, None, 3, 0x80, None)
        if handle == wintypes.HANDLE(-1).value:
            return False
        try:
            identity = self._windows_handle_identity(handle)
            if identity is None:
                return False
            stat = source.stat()
            self.quarantine(token, source, quarantine, (stat.st_mtime_ns, stat.st_size), identity)
            if not self._rename_windows_handle(handle, quarantine, identity):
                return False
            stat = quarantine.stat()
            self.quarantine(token, source, quarantine, (stat.st_mtime_ns, stat.st_size), identity)
            return True
        finally:
            close(handle)

    @classmethod
    def _quarantine_owned(cls, row: dict[str, Any]) -> tuple[bool, bool]:
        value = row["quarantine"]
        if not value:
            return True, False
        target = Path(str(value))
        try:
            stat = target.stat()
        except FileNotFoundError:
            return True, False
        except OSError:
            return False, False
        if (row["quarantine_mtime"] is None or row["quarantine_size"] is None
                or stat.st_mtime_ns != row["quarantine_mtime"] or stat.st_size != row["quarantine_size"]):
            return False, True
        identity = row["quarantine_identity"]
        if os.name == "nt" and identity is None:
            return False, True
        if identity is not None and cls.file_identity(target, stat) != identity:
            return False, True
        return True, True

    @classmethod
    def _replacement_owned(cls, row: dict[str, Any]) -> bool:
        """Check that an overwrite still names the staged file this token owns."""
        source_value = row["source_path"]
        identity = row.get("replacement_identity")
        if (not source_value or row.get("replacement_mtime") is None
                or row.get("replacement_size") is None or identity is None):
            return False
        try:
            stat = Path(str(source_value)).stat()
        except OSError:
            return False
        return ((stat.st_mtime_ns, stat.st_size) == (row["replacement_mtime"], row["replacement_size"])
                and cls.file_identity(Path(str(source_value)), stat) == identity)

    @classmethod
    def _original_source_owned(cls, row: dict[str, Any]) -> bool:
        source_value = row["source_path"]
        identity = row.get("source_identity")
        if not source_value or identity is None:
            return False
        try:
            stat = Path(str(source_value)).stat()
        except OSError:
            return False
        return ((stat.st_mtime_ns, stat.st_size) == (row["quarantine_mtime"], row["quarantine_size"])
                and cls.file_identity(Path(str(source_value)), stat) == identity)

    @classmethod
    def _restore_quarantine(cls, row: dict[str, Any]) -> bool:
        """Put back a quarantined source without ever replacing a new source."""
        value = row["quarantine"]
        if not value:
            return True
        quarantine = Path(value)
        source_value = row["source_path"]
        if not source_value:
            return False
        source = Path(str(source_value))
        owned, quarantine_exists = cls._quarantine_owned(row)
        if not owned:
            return False
        try:
            source.stat()
            source_exists = True
        except FileNotFoundError:
            source_exists = False
        except OSError:
            return False
        if not quarantine_exists:
            return source_exists
        if source_exists:
            # A replacement backup may only restore over the exact staged
            # source.  A new file at the original path belongs to somebody
            # else and leaves both files for an explicit recovery decision.
            if not cls._replacement_owned(row):
                # The crash can precede os.replace.  The old source is still
                # safe only when its original file identity survived.
                return cls._original_source_owned(row) and cls._unlink(
                    str(quarantine), row["quarantine_mtime"], row["quarantine_size"], row["quarantine_identity"],
                )
            identity = row["replacement_identity"]
            if os.name != "nt" or identity is None or not cls._delete_windows_owned(source, str(identity)):
                return False
        identity = row["quarantine_identity"]
        if os.name == "nt":
            return identity is not None and cls._rename_windows_owned(quarantine, source, str(identity))
        try:
            # link() will not overwrite a source created after the check.  The
            # subsequent ownership-checked unlink leaves a retryable duplicate
            # if another process touched the quarantine meanwhile.
            os.link(quarantine, source)
        except OSError:
            return False
        return cls._unlink(str(quarantine), row["quarantine_mtime"], row["quarantine_size"], identity)

    @classmethod
    def _discard_quarantine(cls, row: dict[str, Any]) -> bool:
        """Delete a committed quarantine only while its original name is absent."""
        value = row["quarantine"]
        if not value:
            return True
        owned, exists = cls._quarantine_owned(row)
        if not owned:
            return False
        source_value = row["source_path"]
        if not source_value:
            return False
        source = Path(str(source_value))
        try:
            source.stat()
        except FileNotFoundError:
            pass
        except OSError:
            return False
        else:
            # A source and its replacement backup together is expected only
            # when the source still has this token's staged identity.  A new
            # source is an external conflict and must survive recovery.
            if not row.get("replacement_identity") or not cls._replacement_owned(row):
                return False
        return not exists or cls._unlink(value, row["quarantine_mtime"], row["quarantine_size"], row["quarantine_identity"])

    @staticmethod
    def _decision(row: dict[str, Any], receipt: Any | None) -> str | None:
        if isinstance(receipt, dict):
            return "commit"
        if row["state"] == "workspace_committing":
            return "rollback"
        raw = row.get("recovery_decision")
        if raw in {"rollback", "commit"}:
            return str(raw)
        if row["state"] == "cleanup_pending":
            # A pre-decision legacy cleanup row cannot prove which side of the
            # Workspace transaction won.  Preserve it for manual recovery.
            return None
        if raw is not None:
            LOGGER.warning("invalid save recovery decision for token %s", row["token"])
        return "rollback"

    def _recover_row(self, db: sqlite3.Connection, row: dict[str, Any], receipt: Any | None) -> bool:
        """Run every independent cleanup step for one token and persist its result."""
        if row["quarantine"] and (not row["source_path"] or row["quarantine_mtime"] is None
                or row["quarantine_size"] is None or row["quarantine_identity"] is None):
            db.execute("UPDATE saves SET state='cleanup_pending',cleanup_note=?,updated_at=? WHERE token=?",
                ("legacy quarantine ownership is unknown", time.time_ns(), row["token"]))
            return False
        decision = self._decision(row, receipt)
        if decision is None:
            db.execute("UPDATE saves SET state='cleanup_pending',cleanup_note=?,updated_at=? WHERE token=?",
                ("legacy recovery decision is unknown", time.time_ns(), row["token"]))
            return False
        failures: list[str] = []
        if decision == "rollback":
            if not self._restore_quarantine(row):
                failures.append("source restore is pending")
            owned = row["destination_identity"] or row["staged_identity"]
            if row["destination"] and not self._unlink(row["destination"], row["destination_mtime"], row["destination_size"], owned, require_identity=True):
                failures.append("output cleanup is pending")
        elif not self._discard_quarantine(row):
            failures.append("source quarantine cleanup is pending")

        # A stage is private to this token.  It is cleaned for both rollback
        # and commit even when the final file cannot be safely identified.
        if not self._unlink(row["staged"], row["staged_mtime"], row["staged_size"], row["staged_identity"]):
            failures.append("stage cleanup is pending")

        now = time.time_ns()
        if failures:
            db.execute("UPDATE saves SET state='cleanup_pending',recovery_decision=?,cleanup_note=?,updated_at=? WHERE token=?",
                (decision, "; ".join(failures), now, row["token"]))
            return False

        if decision == "commit":
            cleared = bool(receipt.get("cleared")) if isinstance(receipt, dict) else bool(row["cleared"])
            stale = bool(receipt.get("stale")) if isinstance(receipt, dict) else bool(row["stale"])
            deleted = bool(receipt.get("deleted")) if isinstance(receipt, dict) else bool(row["deleted"])
            generation = int(receipt.get("catalogGeneration") or 0) if isinstance(receipt, dict) else int(row["catalog_generation"] or 0)
            db.execute("UPDATE saves SET state='committed',recovery_decision='commit',cleared=?,stale=?,deleted=?,catalog_generation=?,cleanup_note=NULL,updated_at=? WHERE token=?",
                (int(cleared), int(stale), int(deleted), generation, now, row["token"]))
        else:
            db.execute("UPDATE saves SET state='cancelled',recovery_decision='rollback',cleanup_note=NULL,updated_at=? WHERE token=?",
                (now, row["token"]))
        return True

    def recover_token(self, token: str, workspace_receipt: Any | None = None) -> bool:
        """Recover one token; a receipt callback makes the commit irreversible."""
        with self._lock, self._connection() as db:
            db.row_factory = sqlite3.Row
            raw = db.execute("SELECT * FROM saves WHERE token=?", (token,)).fetchone()
            if raw is None:
                return True
            row = dict(raw)
            receipt = workspace_receipt(token) if workspace_receipt is not None else None
            return self._recover_row(db, row, receipt)

    def recover(self, workspace_receipt: Any | None = None) -> None:
        """Reconcile all tokens; Workspace receipts always decide committed work."""
        with self._lock, self._connection() as db:
            db.row_factory = sqlite3.Row
            rows = [dict(row) for row in db.execute("SELECT * FROM saves")]
            for row in rows:
                receipt = workspace_receipt(str(row["token"])) if workspace_receipt is not None else None
                self._recover_row(db, row, receipt)
            # Only rollback-terminal rows are disposable at startup.  Committed
            # rows remain until the client acknowledges their workspace receipt.
            db.execute("DELETE FROM saves WHERE state='cancelled'")
