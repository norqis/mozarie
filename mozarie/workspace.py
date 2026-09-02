"""Small durable catalogue store.

The process cache deliberately remains disposable.  Only the review work that
cannot be reconstructed from the source images is written here.
"""

from __future__ import annotations

import hashlib
import io
import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from PIL import Image, UnidentifiedImageError


# Keep every IN clause comfortably below SQLite's smallest common bind limit.
_BULK_CHUNK_SIZE = 900


def _chunks(values: list[str]) -> list[list[str]]:
    return [values[index:index + _BULK_CHUNK_SIZE] for index in range(0, len(values), _BULK_CHUNK_SIZE)]


class WorkspaceOpenError(RuntimeError):
    """The durable workspace cannot be safely opened as the current schema."""


class _ClosingConnection(sqlite3.Connection):
    """sqlite's context manager commits but does not close on Windows."""
    def __exit__(self, *args: Any) -> None:
        try:
            super().__exit__(*args)
        finally:
            self.close()


class WorkspaceStore:
    VERSION = 4

    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "workspaces.sqlite3"
        self._lock = threading.RLock()
        data_dir.mkdir(parents=True, exist_ok=True)
        # Inspect an existing database before issuing any write-capable pragma,
        # DDL, or cleanup statement. v0.4 intentionally has no migrations.
        existing = self.path.exists()
        if existing:
            self._inspect_existing()
        with self._connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=NORMAL")
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("PRAGMA busy_timeout=5000")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS catalogs (
                    catalog_id TEXT PRIMARY KEY, identity_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS images (
                    catalog_id TEXT NOT NULL REFERENCES catalogs(catalog_id) ON DELETE CASCADE,
                    relative_path TEXT NOT NULL, image_id TEXT NOT NULL UNIQUE,
                    size_bytes INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, source_hash TEXT NOT NULL DEFAULT '',
                    hidden INTEGER NOT NULL DEFAULT 0, reviewed INTEGER NOT NULL DEFAULT 0,
                    candidate_revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
                    PRIMARY KEY(catalog_id, relative_path)
                );
                CREATE TABLE IF NOT EXISTS candidates (
                    image_id TEXT NOT NULL REFERENCES images(image_id) ON DELETE CASCADE,
                    candidate_id TEXT NOT NULL, label_token TEXT NOT NULL, confidence REAL,
                    mask_png BLOB NOT NULL, enabled INTEGER NOT NULL, color TEXT NOT NULL,
                    source TEXT NOT NULL, origin TEXT NOT NULL, refinement TEXT,
                    role TEXT NOT NULL, forced INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(image_id, candidate_id)
                );
                CREATE TABLE IF NOT EXISTS manual_edits (
                    image_id TEXT PRIMARY KEY REFERENCES images(image_id) ON DELETE CASCADE,
                    add_png BLOB, exclusion_png BLOB, exclusion_erase_png BLOB,
                    manual_enabled INTEGER NOT NULL DEFAULT 1,
                    exclusion_enabled INTEGER NOT NULL DEFAULT 1,
                    exclusion_erase_enabled INTEGER NOT NULL DEFAULT 1,
                    exclusion_forced INTEGER NOT NULL DEFAULT 1,
                    removed_candidate_ids TEXT NOT NULL DEFAULT '[]', candidate_revision INTEGER NOT NULL DEFAULT 0,
                    has_effective_mask INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL
                );
            """)
            if not existing:
                db.execute("INSERT INTO meta(key, value) VALUES('schema_version', ?)", (str(self.VERSION),))

    def _inspect_existing(self) -> None:
        """Read existing workspaces through SQLite's read-only URI mode."""
        try:
            uri = f"{self.path.resolve().as_uri()}?mode=ro"
            with sqlite3.connect(uri, uri=True, factory=_ClosingConnection) as db:
                db.row_factory = sqlite3.Row
                tables = {row["name"] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if "meta" not in tables:
                    raise WorkspaceOpenError("workspace database is not a Mozarie v0.4 database")
                version_row = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
                if version_row is None:
                    raise WorkspaceOpenError("workspace database is not a Mozarie v0.4 database")
                try:
                    version = int(version_row["value"])
                except (TypeError, ValueError) as exc:
                    raise WorkspaceOpenError("workspace database must be recreated for Mozarie v0.4") from exc
                if version > self.VERSION:
                    raise WorkspaceOpenError("workspace database is newer than this Mozarie version")
                if version != self.VERSION:
                    raise WorkspaceOpenError("workspace database must be recreated for Mozarie v0.4")
                self._validate_schema(db, tables)
        except WorkspaceOpenError:
            raise
        except (OSError, sqlite3.DatabaseError) as exc:
            raise WorkspaceOpenError("workspace database cannot be opened") from exc

    @staticmethod
    def _validate_schema(db: sqlite3.Connection, tables: set[str]) -> None:
        # This is intentionally a strict current-schema contract.  Do not
        # "repair" old or hand-edited databases: opening them must be read-only.
        expected_columns = {
            "meta": (("key", "TEXT", 0, None, 1), ("value", "TEXT", 1, None, 0)),
            "catalogs": (("catalog_id", "TEXT", 0, None, 1), ("identity_hash", "TEXT", 1, None, 0), ("created_at", "INTEGER", 1, None, 0), ("updated_at", "INTEGER", 1, None, 0)),
            "images": (("catalog_id", "TEXT", 1, None, 1), ("relative_path", "TEXT", 1, None, 2), ("image_id", "TEXT", 1, None, 0), ("size_bytes", "INTEGER", 1, None, 0), ("mtime_ns", "INTEGER", 1, None, 0), ("source_hash", "TEXT", 1, "''", 0), ("hidden", "INTEGER", 1, "0", 0), ("reviewed", "INTEGER", 1, "0", 0), ("candidate_revision", "INTEGER", 1, "0", 0), ("updated_at", "INTEGER", 1, None, 0)),
            "candidates": (("image_id", "TEXT", 1, None, 1), ("candidate_id", "TEXT", 1, None, 2), ("label_token", "TEXT", 1, None, 0), ("confidence", "REAL", 0, None, 0), ("mask_png", "BLOB", 1, None, 0), ("enabled", "INTEGER", 1, None, 0), ("color", "TEXT", 1, None, 0), ("source", "TEXT", 1, None, 0), ("origin", "TEXT", 1, None, 0), ("refinement", "TEXT", 0, None, 0), ("role", "TEXT", 1, None, 0), ("forced", "INTEGER", 1, None, 0), ("deleted", "INTEGER", 1, "0", 0)),
            "manual_edits": (("image_id", "TEXT", 0, None, 1), ("add_png", "BLOB", 0, None, 0), ("exclusion_png", "BLOB", 0, None, 0), ("exclusion_erase_png", "BLOB", 0, None, 0), ("manual_enabled", "INTEGER", 1, "1", 0), ("exclusion_enabled", "INTEGER", 1, "1", 0), ("exclusion_erase_enabled", "INTEGER", 1, "1", 0), ("exclusion_forced", "INTEGER", 1, "1", 0), ("removed_candidate_ids", "TEXT", 1, "'[]'", 0), ("candidate_revision", "INTEGER", 1, "0", 0), ("has_effective_mask", "INTEGER", 1, "0", 0), ("updated_at", "INTEGER", 1, None, 0)),
        }
        if tables != set(expected_columns):
            raise WorkspaceOpenError("workspace database must be recreated for Mozarie v0.4")
        for table, expected in expected_columns.items():
            actual = tuple((str(row["name"]), str(row["type"]).upper(), int(row["notnull"]), row["dflt_value"], int(row["pk"])) for row in db.execute(f"PRAGMA table_info({table})"))
            if actual != expected:
                raise WorkspaceOpenError("workspace database must be recreated for Mozarie v0.4")
        if tuple(row[0] for row in db.execute("PRAGMA quick_check(1)")) != ("ok",):
            raise WorkspaceOpenError("workspace database cannot be opened")
        if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise WorkspaceOpenError("workspace database must be recreated for Mozarie v0.4")
        primary_keys = {
            "meta": ("key",),
            "catalogs": ("catalog_id",),
            "images": ("catalog_id", "relative_path"),
            "candidates": ("image_id", "candidate_id"),
            "manual_edits": ("image_id",),
        }
        unique_columns = {
            "catalogs": ("identity_hash",),
            "images": ("image_id",),
        }
        foreign_keys = {
            "images": ("catalog_id", "catalogs", "catalog_id"),
            "candidates": ("image_id", "images", "image_id"),
            "manual_edits": ("image_id", "images", "image_id"),
        }
        for table, expected in primary_keys.items():
            key_columns = tuple(row["name"] for row in sorted(
                db.execute(f"PRAGMA table_info({table})"), key=lambda row: int(row["pk"])
            ) if row["pk"])
            if key_columns != expected:
                raise WorkspaceOpenError("workspace database must be recreated for Mozarie v0.4")
        for table, expected in unique_columns.items():
            unique_indexes = [row["name"] for row in db.execute(f"PRAGMA index_list({table})") if row["unique"]]
            if not any(tuple(row["name"] for row in db.execute(f"PRAGMA index_info({index})")) == expected for index in unique_indexes):
                raise WorkspaceOpenError("workspace database must be recreated for Mozarie v0.4")
        for table, expected in foreign_keys.items():
            if not any((row["from"], row["table"], row["to"]) == expected and row["on_delete"].upper() == "CASCADE"
                       for row in db.execute(f"PRAGMA foreign_key_list({table})")):
                raise WorkspaceOpenError("workspace database must be recreated for Mozarie v0.4")

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=5, isolation_level=None, factory=_ClosingConnection)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=5000")
        return db

    @staticmethod
    def _decode_png_mask(raw: bytes | None) -> Image.Image | None:
        """Read the same alpha/grayscale mask representation used at render time."""
        if raw is None:
            return None
        if not isinstance(raw, bytes) or not raw.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("workspace mask is not a PNG")
        try:
            with Image.open(io.BytesIO(raw)) as image:
                if image.format != "PNG":
                    raise ValueError("workspace mask is not a PNG")
                image.load()
                if image.mode in {"RGBA", "LA"}:
                    return image.getchannel("A").point(lambda value: 255 if value else 0)
                if image.mode in {"L", "1"}:
                    return image.convert("L").point(lambda value: 255 if value else 0)
        except (OSError, UnidentifiedImageError) as exc:
            raise ValueError("workspace mask is not a PNG") from exc
        raise ValueError("workspace mask has no alpha or grayscale channel")

    @classmethod
    def _require_png_mask(cls, raw: bytes | None) -> None:
        if raw is not None:
            cls._decode_png_mask(raw)

    @staticmethod
    def _candidate_row(row: sqlite3.Row) -> dict[str, Any]:
        """Attach the candidate's PNG-only padding metadata to its hydrated row."""
        raw = row["mask_png"]
        if not isinstance(raw, bytes):
            raise ValueError("workspace candidate mask is not a PNG")
        with Image.open(io.BytesIO(raw)) as image:
            value = image.text.get("mozarie_expand_px", "0")
        try:
            expand_px = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError("workspace candidate expand pixels are invalid") from exc
        if expand_px < 0 or str(expand_px) != value:
            raise ValueError("workspace candidate expand pixels are invalid")
        hydrated = dict(row)
        hydrated["expand_px"] = expand_px
        return hydrated

    @staticmethod
    def identity_for_root(root: Path) -> str:
        return hashlib.sha256(str(root.resolve()).casefold().encode("utf-8")).hexdigest()

    def catalog_for_root(self, root: Path) -> str:
        identity = self.identity_for_root(root)
        now = time.time_ns()
        with self._lock, self._connect() as db:
            row = db.execute("SELECT catalog_id FROM catalogs WHERE identity_hash=?", (identity,)).fetchone()
            if row:
                db.execute("UPDATE catalogs SET updated_at=? WHERE catalog_id=?", (now, row["catalog_id"]))
                return str(row["catalog_id"])
            catalog_id = uuid.uuid4().hex
            db.execute("INSERT INTO catalogs VALUES(?,?,?,?)", (catalog_id, identity, now, now))
            return catalog_id

    def ensure_catalog(self, catalog_id: str | None = None) -> str:
        """Create (or validate) an opaque browser catalogue identity."""
        if catalog_id is not None and (len(catalog_id) != 32 or any(char not in "0123456789abcdef" for char in catalog_id)):
            raise ValueError("invalid catalog id")
        catalog_id = catalog_id or uuid.uuid4().hex
        identity = f"browser:{catalog_id}"
        now = time.time_ns()
        with self._lock, self._connect() as db:
            db.execute("INSERT OR IGNORE INTO catalogs(catalog_id,identity_hash,created_at,updated_at) VALUES(?,?,?,?)", (catalog_id, identity, now, now))
            return catalog_id

    def ensure_provisional_catalog(self) -> str:
        catalog_id = uuid.uuid4().hex
        now = time.time_ns()
        with self._lock, self._connect() as db:
            db.execute("INSERT INTO catalogs(catalog_id,identity_hash,created_at,updated_at) VALUES(?,?,?,?)", (catalog_id, f"browser-provisional:{catalog_id}", now, now))
        return catalog_id

    def finalize_catalog(self, catalog_id: str) -> None:
        with self._lock, self._connect() as db:
            db.execute("UPDATE catalogs SET identity_hash=?,updated_at=? WHERE catalog_id=? AND identity_hash LIKE 'browser-provisional:%'", (f"browser:{catalog_id}", time.time_ns(), catalog_id))

    def catalog_exists(self, catalog_id: str) -> bool:
        with self._connect() as db:
            return db.execute("SELECT 1 FROM catalogs WHERE catalog_id=?", (catalog_id,)).fetchone() is not None

    def delete_catalog(self, catalog_id: str) -> None:
        """Remove an unused provisional browser catalogue and its cascaded rows."""
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                db.execute("DELETE FROM catalogs WHERE catalog_id=?", (catalog_id,))
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    def best_catalog_for_manifest(self, entries: list[tuple[str, str]], exclude_catalog: str) -> str | None:
        """Return a browser catalogue only for a unique strict-majority match."""
        scores: dict[str, int] = {}
        counts: dict[str, int] = {}
        if not entries:
            return None
        with self._connect() as db:
            db.execute("CREATE TEMP TABLE IF NOT EXISTS workspace_manifest_entries(relative_path TEXT, source_hash TEXT, PRIMARY KEY(relative_path,source_hash))")
            db.execute("DELETE FROM workspace_manifest_entries")
            db.executemany("INSERT OR IGNORE INTO workspace_manifest_entries(relative_path,source_hash) VALUES(?,?)", entries)
            for row in db.execute("""SELECT images.catalog_id,COUNT(*) AS score
                FROM images JOIN catalogs ON catalogs.catalog_id=images.catalog_id
                JOIN workspace_manifest_entries AS manifest ON manifest.relative_path=images.relative_path AND manifest.source_hash=images.source_hash
                WHERE images.catalog_id<>? AND catalogs.identity_hash LIKE 'browser:%'
                GROUP BY images.catalog_id""", (exclude_catalog,)):
                scores[str(row["catalog_id"])] = int(row["score"])
            for row in db.execute("""SELECT catalogs.catalog_id, COUNT(images.image_id) AS image_count
                FROM catalogs JOIN images ON images.catalog_id=catalogs.catalog_id
                WHERE catalogs.identity_hash LIKE 'browser:%' AND catalogs.catalog_id<>?
                GROUP BY catalogs.catalog_id""", (exclude_catalog,)):
                counts[str(row["catalog_id"])] = int(row["image_count"])
        if not scores: return None
        best = max(scores.values())
        winners = [catalog_id for catalog_id, score in scores.items() if score == best]
        if len(winners) != 1:
            return None
        target = winners[0]
        # A one-image folder is safe only when both complete manifests are
        # exactly that one image. Larger folders require strict majority on
        # both sides, preventing two common files from joining a 100-image set.
        if best == len(entries) == counts.get(target, 0) == 1:
            return target
        return target if best * 2 > max(len(entries), counts.get(target, 0)) else None

    def reconcile_images(self, catalog_id: str, records: list[Any], source_hashes: dict[str, str] | None = None) -> dict[str, dict[str, Any]]:
        """Return durable state by relative path, clearing pixels on source change."""
        now = time.time_ns()
        result: dict[str, dict[str, Any]] = {}
        if not records:
            return result
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                db.execute("""CREATE TEMP TABLE IF NOT EXISTS workspace_reconcile_records(
                    relative_path TEXT PRIMARY KEY,size_bytes INTEGER NOT NULL,mtime_ns INTEGER NOT NULL,source_hash TEXT NOT NULL)""")
                db.execute("DELETE FROM workspace_reconcile_records")
                db.executemany("INSERT INTO workspace_reconcile_records(relative_path,size_bytes,mtime_ns,source_hash) VALUES(?,?,?,?)", (
                    (record.relative_path, record.size_bytes, record.mtime_ns, (source_hashes or {}).get(record.relative_path, ""))
                    for record in records
                ))
                existing = {
                    str(row["relative_path"]): row for row in db.execute("""SELECT images.* FROM images
                        JOIN workspace_reconcile_records AS incoming ON incoming.relative_path=images.relative_path
                        WHERE images.catalog_id=?""", (catalog_id,))
                }
                for record in records:
                    row = existing.get(record.relative_path)
                    source_hash = (source_hashes or {}).get(record.relative_path, "")
                    if row is None:
                        image_id = uuid.uuid4().hex
                        db.execute("INSERT INTO images(catalog_id,relative_path,image_id,size_bytes,mtime_ns,source_hash,updated_at) VALUES(?,?,?,?,?,?,?)",
                                   (catalog_id, record.relative_path, image_id, record.size_bytes, record.mtime_ns, source_hash, now))
                        result[record.relative_path] = {"image_id": image_id, "hidden": False, "reviewed": False, "revision": 0, "changed": False}
                        continue
                    changed = (bool(source_hash) and row["source_hash"] != source_hash) or (not source_hash and (int(row["size_bytes"]) != record.size_bytes or int(row["mtime_ns"]) != record.mtime_ns))
                    if changed:
                        db.execute("UPDATE images SET size_bytes=?,mtime_ns=?,source_hash=?,reviewed=0,candidate_revision=0,updated_at=? WHERE image_id=?",
                                   (record.size_bytes, record.mtime_ns, source_hash, now, row["image_id"]))
                        db.execute("DELETE FROM candidates WHERE image_id=?", (row["image_id"],))
                        db.execute("DELETE FROM manual_edits WHERE image_id=?", (row["image_id"],))
                    result[record.relative_path] = {"image_id": row["image_id"], "hidden": bool(row["hidden"]), "reviewed": False if changed else bool(row["reviewed"]), "revision": 0 if changed else int(row["candidate_revision"]), "changed": changed}
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        return result

    def delete_images(self, image_ids: list[str]) -> None:
        """Permanently remove explicitly discarded image workspaces."""
        if not image_ids:
            return
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                for chunk in _chunks(image_ids):
                    db.execute(f"DELETE FROM images WHERE image_id IN ({','.join('?' for _ in chunk)})", chunk)
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    def clear_image_workspaces(self, revisions: dict[str, int]) -> None:
        """Clear candidate and manual state for a batch before publishing it."""
        if not revisions:
            return
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                for image_id, revision in revisions.items():
                    db.execute("DELETE FROM candidates WHERE image_id=?", (image_id,))
                    db.execute("DELETE FROM manual_edits WHERE image_id=?", (image_id,))
                    db.execute("UPDATE images SET candidate_revision=?,reviewed=0,updated_at=? WHERE image_id=?", (revision, time.time_ns(), image_id))
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    def prune_catalog_images(self, catalog_id: str, relative_paths: set[str]) -> None:
        """Drop rows for files absent from a complete folder scan only."""
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                if relative_paths:
                    db.execute("CREATE TEMP TABLE IF NOT EXISTS workspace_paths(relative_path TEXT PRIMARY KEY)")
                    db.execute("DELETE FROM workspace_paths")
                    db.executemany("INSERT INTO workspace_paths(relative_path) VALUES(?)", ((path,) for path in relative_paths))
                    db.execute("""DELETE FROM images WHERE catalog_id=? AND NOT EXISTS
                        (SELECT 1 FROM workspace_paths WHERE workspace_paths.relative_path=images.relative_path)""", (catalog_id,))
                else:
                    db.execute("DELETE FROM images WHERE catalog_id=?", (catalog_id,))
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    def image_state(self, image_id: str) -> tuple[bool, bool]:
        with self._connect() as db:
            row = db.execute("SELECT hidden,reviewed FROM images WHERE image_id=?", (image_id,)).fetchone()
            return (bool(row["hidden"]), bool(row["reviewed"])) if row else (False, False)

    def has_image(self, image_id: str) -> bool:
        with self._connect() as db:
            return db.execute("SELECT 1 FROM images WHERE image_id=?", (image_id,)).fetchone() is not None

    def set_image_flags(self, image_id: str, *, hidden: bool | None = None, reviewed: bool | None = None) -> None:
        updates: list[str] = []; values: list[Any] = []
        if hidden is not None: updates.append("hidden=?"); values.append(int(hidden))
        if reviewed is not None: updates.append("reviewed=?"); values.append(int(reviewed))
        if not updates: return
        values.extend([time.time_ns(), image_id])
        with self._lock, self._connect() as db:
            db.execute(f"UPDATE images SET {','.join(updates)},updated_at=? WHERE image_id=?", values)

    def commit_save(self, image_id: str, *, mtime_ns: int | None = None, size_bytes: int | None = None,
                    source_hash: str | None = None, candidate_revision: int | None = None,
                    clear_workspace: bool, delete_image: bool = False) -> None:
        """Commit one completed save before its in-memory review state is published."""
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                if delete_image:
                    db.execute("DELETE FROM images WHERE image_id=?", (image_id,))
                elif mtime_ns is not None and size_bytes is not None:
                    if source_hash is None:
                        db.execute("UPDATE images SET mtime_ns=?,size_bytes=?,updated_at=? WHERE image_id=?", (mtime_ns, size_bytes, time.time_ns(), image_id))
                    else:
                        db.execute("UPDATE images SET mtime_ns=?,size_bytes=?,source_hash=?,updated_at=? WHERE image_id=?", (mtime_ns, size_bytes, source_hash, time.time_ns(), image_id))
                if candidate_revision is not None and not delete_image:
                    db.execute("UPDATE images SET candidate_revision=?,reviewed=0,updated_at=? WHERE image_id=?", (candidate_revision, time.time_ns(), image_id))
                if clear_workspace and not delete_image:
                    db.execute("DELETE FROM candidates WHERE image_id=?", (image_id,))
                    db.execute("DELETE FROM manual_edits WHERE image_id=?", (image_id,))
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    @staticmethod
    def _update_manual_candidate_state(db: sqlite3.Connection, image_id: str, revision: int, candidate_ids: set[str], effective: bool) -> None:
        row = db.execute("SELECT removed_candidate_ids FROM manual_edits WHERE image_id=?", (image_id,)).fetchone()
        if row is None:
            db.execute("""INSERT INTO manual_edits(image_id,removed_candidate_ids,candidate_revision,has_effective_mask,updated_at)
                VALUES(?,?,?,?,?)""", (image_id, "[]", revision, int(effective), time.time_ns()))
            return
        removed = json.loads(row["removed_candidate_ids"])
        if not isinstance(removed, list) or any(not isinstance(item, str) for item in removed):
            raise ValueError("workspace removed candidates are invalid")
        db.execute("""UPDATE manual_edits SET removed_candidate_ids=?,candidate_revision=?,has_effective_mask=?,updated_at=?
            WHERE image_id=?""", (json.dumps(sorted(set(removed) & candidate_ids)), revision, int(effective), time.time_ns(), image_id))

    def commit_candidate_state(self, image_id: str, revision: int, candidates: list[Any], effective: bool, *, replace: bool) -> None:
        """Atomically store one complete candidate/manual revision before publication."""
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                db.execute("UPDATE images SET candidate_revision=?, reviewed=0, updated_at=? WHERE image_id=?", (revision, time.time_ns(), image_id))
                if replace:
                    db.execute("UPDATE candidates SET deleted=1 WHERE image_id=?", (image_id,))
                    for candidate in candidates:
                        try:
                            with candidate.mask_path.open("rb") as handle:
                                mask = handle.read()
                        except OSError:
                            # Restored candidates intentionally do not materialise
                            # every PNG. Keep their existing durable mask while
                            # updating just the requested metadata.
                            row = db.execute(
                                "SELECT mask_png FROM candidates WHERE image_id=? AND candidate_id=?",
                                (image_id, candidate.candidate_id),
                            ).fetchone()
                            mask = row["mask_png"] if row else None
                            if not isinstance(mask, bytes):
                                continue
                        self._require_png_mask(mask)
                        db.execute("""INSERT INTO candidates(image_id,candidate_id,label_token,confidence,mask_png,enabled,color,source,origin,refinement,role,forced,deleted)
                            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)
                            ON CONFLICT(image_id,candidate_id) DO UPDATE SET label_token=excluded.label_token,confidence=excluded.confidence,mask_png=excluded.mask_png,enabled=excluded.enabled,color=excluded.color,source=excluded.source,origin=excluded.origin,refinement=excluded.refinement,role=excluded.role,forced=excluded.forced,deleted=0""",
                            (image_id,candidate.candidate_id,candidate.label_token,candidate.confidence,mask,int(candidate.enabled),candidate.color,candidate.source,candidate.origin,candidate.refinement,candidate.role.value,int(candidate.forced)))
                    db.execute("DELETE FROM candidates WHERE image_id=? AND deleted=1", (image_id,))
                else:
                    for candidate in candidates:
                        # Normal candidate controls only alter metadata. Keep
                        # the durable PNG BLOB untouched instead of rereading
                        # a potentially lazy cache file.
                        db.execute("UPDATE candidates SET enabled=?,color=?,forced=? WHERE image_id=? AND candidate_id=?", (int(candidate.enabled), candidate.color, int(candidate.forced), image_id, candidate.candidate_id))
                self._update_manual_candidate_state(db, image_id, revision, {candidate.candidate_id for candidate in candidates}, effective)
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    def hydrate_candidates(self, image_id: str, directory: Path, candidate_factory: Any) -> tuple[int, list[Any]]:
        with self._connect() as db:
            image = db.execute("SELECT candidate_revision FROM images WHERE image_id=?", (image_id,)).fetchone()
            rows = db.execute("""SELECT candidate_id,label_token,confidence,mask_png,enabled,color,source,origin,refinement,role,forced
                FROM candidates WHERE image_id=? AND deleted=0""", (image_id,)).fetchall()
        if not image: return 0, []
        if not rows: return int(image["candidate_revision"]), []
        for row in rows:
            mask = row["mask_png"]
            if not isinstance(mask, bytes):
                raise ValueError("workspace candidate mask is not a PNG")
            self._require_png_mask(mask)
        candidates = [candidate_factory(self._candidate_row(row), directory / f"{row['candidate_id']}.png") for row in rows]
        return int(image["candidate_revision"]), candidates

    def hydrate_candidates_bulk(self, image_ids: list[str], cache_dir: Path, candidate_factory: Any) -> dict[str, tuple[int, list[Any]]]:
        """Load a catalogue in a few queries instead of one query per image."""
        if not image_ids:
            return {}
        images: dict[str, int] = {}
        candidates: dict[str, list[Any]] = {}
        with self._connect() as db:
            for chunk in _chunks(image_ids):
                placeholders = ",".join("?" for _ in chunk)
                for row in db.execute(f"SELECT image_id,candidate_revision FROM images WHERE image_id IN ({placeholders})", chunk):
                    images[str(row["image_id"])] = int(row["candidate_revision"])
                for row in db.execute(f"""SELECT image_id,candidate_id,label_token,confidence,mask_png,enabled,color,source,origin,refinement,role,forced
                    FROM candidates WHERE image_id IN ({placeholders}) AND deleted=0""", chunk):
                    mask = row["mask_png"]
                    if not isinstance(mask, bytes):
                        raise ValueError("workspace candidate mask is not a PNG")
                    self._require_png_mask(mask)
                    image_id = str(row["image_id"])
                    candidates.setdefault(image_id, []).append(candidate_factory(self._candidate_row(row), cache_dir / image_id / f"{row['candidate_id']}.png"))
        return {image_id: (revision, candidates.get(image_id, [])) for image_id, revision in images.items()}

    def valid_candidate_ids(self, image_id: str) -> set[str]:
        with self._connect() as db:
            rows = db.execute("""SELECT candidate_id FROM candidates
                WHERE image_id=? AND deleted=0 AND length(mask_png)>=8
                  AND substr(mask_png,1,8)=?""", (image_id, b"\x89PNG\r\n\x1a\n")).fetchall()
        return {str(row["candidate_id"]) for row in rows}

    def candidate_png(self, image_id: str, candidate_id: str) -> bytes | None:
        with self._connect() as db:
            row = db.execute("SELECT mask_png FROM candidates WHERE image_id=? AND candidate_id=? AND deleted=0", (image_id, candidate_id)).fetchone()
        raw = row["mask_png"] if row else None
        return raw if isinstance(raw, bytes) and raw.startswith(b"\x89PNG\r\n\x1a\n") else None

    def save_manual(self, image_id: str, payload: dict[str, Any], decoder: Any) -> None:
        removed = payload.get("removedCandidateIds", [])
        if not isinstance(removed, list) or any(not isinstance(item, str) for item in removed):
            raise ValueError("invalid removed candidates")
        has_effective_mask = payload.get("hasEffectiveMask")
        if not isinstance(has_effective_mask, bool):
            raise ValueError("invalid effective mask")
        add, exclusion, erase = (decoder(payload.get(key)) for key in ("add", "exclusion", "exclusionErase"))
        for mask in (add, exclusion, erase):
            self._require_png_mask(mask)
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                image = db.execute("SELECT candidate_revision FROM images WHERE image_id=?", (image_id,)).fetchone()
                if image is None:
                    raise ValueError("workspace image is missing")
                revision = int(image["candidate_revision"])
                valid_ids = {str(row["candidate_id"]) for row in db.execute(
                    "SELECT candidate_id FROM candidates WHERE image_id=? AND deleted=0", (image_id,)
                )}
                # Candidate IDs are revision-local.  Persisting only current IDs
                # prevents an old editor tab from suppressing a newly detected mask.
                removed = sorted(set(removed) & valid_ids)
                db.execute("""INSERT INTO manual_edits(
                image_id,add_png,exclusion_png,exclusion_erase_png,manual_enabled,exclusion_enabled,
                exclusion_erase_enabled,exclusion_forced,removed_candidate_ids,candidate_revision,
                has_effective_mask,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(image_id) DO UPDATE SET
                add_png=excluded.add_png,exclusion_png=excluded.exclusion_png,exclusion_erase_png=excluded.exclusion_erase_png,
                manual_enabled=excluded.manual_enabled,exclusion_enabled=excluded.exclusion_enabled,exclusion_erase_enabled=excluded.exclusion_erase_enabled,
                exclusion_forced=excluded.exclusion_forced,removed_candidate_ids=excluded.removed_candidate_ids,candidate_revision=excluded.candidate_revision,has_effective_mask=excluded.has_effective_mask,updated_at=excluded.updated_at""",
                    (image_id,add,exclusion,erase,int(payload.get("manualEnabled", True)),int(payload.get("manualExclusionEnabled", True)),int(payload.get("manualExclusionEraseEnabled", True)),int(payload.get("manualExclusionForced", True)),json.dumps(removed),revision,int(has_effective_mask),time.time_ns()))
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    def manual_mask_statuses(self, image_ids: list[str]) -> dict[str, tuple[bool, int]]:
        if not image_ids:
            return {}
        with self._connect() as db:
            result: dict[str, tuple[bool, int]] = {}
            for chunk in _chunks(image_ids):
                rows = db.execute(
                    f"SELECT image_id,has_effective_mask,candidate_revision FROM manual_edits WHERE image_id IN ({','.join('?' for _ in chunk)})",
                    chunk,
                ).fetchall()
                result.update({str(row["image_id"]): (bool(row["has_effective_mask"]), int(row["candidate_revision"])) for row in rows})
        return result

    def delete_manual(self, image_ids: list[str]) -> None:
        if not image_ids:
            return
        with self._lock, self._connect() as db:
            for chunk in _chunks(image_ids):
                db.execute(f"DELETE FROM manual_edits WHERE image_id IN ({','.join('?' for _ in chunk)})", chunk)

    def manual(self, image_id: str, encoder: Any) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM manual_edits WHERE image_id=?", (image_id,)).fetchone()
            image = db.execute("SELECT candidate_revision FROM images WHERE image_id=?", (image_id,)).fetchone()
            valid_ids = {str(item["candidate_id"]) for item in db.execute(
                "SELECT candidate_id FROM candidates WHERE image_id=? AND deleted=0", (image_id,)
            )}
        if not row: return None
        masks = (row["add_png"], row["exclusion_png"], row["exclusion_erase_png"])
        for mask in masks:
            self._require_png_mask(mask)
        removed = json.loads(row["removed_candidate_ids"])
        if not isinstance(removed, list) or any(not isinstance(item, str) for item in removed):
            raise ValueError("workspace removed candidates are invalid")
        current_revision = int(image["candidate_revision"]) if image else int(row["candidate_revision"])
        # Old rows from interrupted/browser tabs are read safely too.  The next
        # save writes this normalized representation back in one transaction.
        removed = sorted(set(removed) & valid_ids)
        return {"add": encoder(masks[0]), "exclusion": encoder(masks[1]), "exclusionErase": encoder(masks[2]), "manualEnabled": bool(row["manual_enabled"]), "manualExclusionEnabled": bool(row["exclusion_enabled"]), "manualExclusionEraseEnabled": bool(row["exclusion_erase_enabled"]), "manualExclusionForced": bool(row["exclusion_forced"]), "removedCandidateIds": removed, "candidateRevision": current_revision, "hasEffectiveMask": bool(row["has_effective_mask"])}
