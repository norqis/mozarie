"""Small durable catalogue store.

The process cache deliberately remains disposable.  Only the review work that
cannot be reconstructed from the source images is written here.
"""

from __future__ import annotations

import io
import json
import base64
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
    # v7 deliberately replaces the old folder catalogue with a project store.
    # There is no migration path: the user chooses whether to recreate v4 data.
    VERSION = 7

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
                    catalog_id TEXT PRIMARY KEY, identity_hash TEXT NOT NULL,
                    name TEXT COLLATE NOCASE UNIQUE, status TEXT NOT NULL DEFAULT 'working',
                    source_root TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS project_sources (
                    source_id TEXT PRIMARY KEY, catalog_id TEXT NOT NULL REFERENCES catalogs(catalog_id) ON DELETE CASCADE,
                    kind TEXT NOT NULL, display_name TEXT NOT NULL, native_path TEXT, source_identity TEXT NOT NULL,
                    created_at INTEGER NOT NULL, UNIQUE(catalog_id, source_identity)
                );
                CREATE TABLE IF NOT EXISTS images (
                    catalog_id TEXT NOT NULL REFERENCES catalogs(catalog_id) ON DELETE CASCADE,
                    source_id TEXT NOT NULL REFERENCES project_sources(source_id) ON DELETE CASCADE,
                    relative_path TEXT NOT NULL, image_id TEXT NOT NULL UNIQUE,
                    size_bytes INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
                    hidden INTEGER NOT NULL DEFAULT 0, reviewed INTEGER NOT NULL DEFAULT 0,
                    candidate_revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
                    PRIMARY KEY(source_id, relative_path)
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
                    has_effective_mask INTEGER NOT NULL DEFAULT 0, history_json TEXT NOT NULL DEFAULT '{}',
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS history_entries (
                    entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    catalog_id TEXT NOT NULL REFERENCES catalogs(catalog_id) ON DELETE CASCADE,
                    image_id TEXT NOT NULL REFERENCES images(image_id) ON DELETE CASCADE,
                    group_id TEXT,
                    before_json TEXT NOT NULL,
                    after_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS project_sources_identity ON project_sources(source_identity);
                CREATE INDEX IF NOT EXISTS history_entries_image_entry ON history_entries(image_id, entry_id);
                CREATE INDEX IF NOT EXISTS history_entries_group ON history_entries(group_id);
                CREATE TABLE IF NOT EXISTS history_cursors (
                    image_id TEXT PRIMARY KEY REFERENCES images(image_id) ON DELETE CASCADE,
                    entry_id INTEGER REFERENCES history_entries(entry_id) ON DELETE SET NULL
                );
                CREATE TRIGGER IF NOT EXISTS project_image_insert AFTER INSERT ON images BEGIN
                    UPDATE catalogs SET updated_at=CAST(unixepoch('subsec')*1000000000 AS INTEGER) WHERE catalog_id=NEW.catalog_id;
                END;
                CREATE TRIGGER IF NOT EXISTS project_image_update AFTER UPDATE ON images BEGIN
                    UPDATE catalogs SET updated_at=CAST(unixepoch('subsec')*1000000000 AS INTEGER) WHERE catalog_id=NEW.catalog_id;
                END;
            """)
            if not existing:
                db.execute("INSERT INTO meta(key, value) VALUES('schema_version', ?)", (str(self.VERSION),))

    @classmethod
    def recreate(cls, data_dir: Path) -> None:
        """Explicitly discard only the workspace database and its SQLite sidecars."""
        path = data_dir / "workspaces.sqlite3"
        for target in (path, Path(f"{path}-wal"), Path(f"{path}-shm")):
            target.unlink(missing_ok=True)

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
                    raise WorkspaceOpenError("workspace database must be recreated for Mozarie v0.7")
                self._validate_schema(db, tables)
        except WorkspaceOpenError:
            raise
        except (OSError, sqlite3.DatabaseError) as exc:
            raise WorkspaceOpenError("workspace database cannot be opened") from exc

    @staticmethod
    def _validate_schema(db: sqlite3.Connection, tables: set[str]) -> None:
        required = {"meta", "catalogs", "project_sources", "images", "candidates", "manual_edits", "history_entries", "history_cursors"}
        if not required.issubset(tables):
            raise WorkspaceOpenError("workspace database must be recreated for Mozarie v0.7")
        if tuple(row[0] for row in db.execute("PRAGMA quick_check(1)")) != ("ok",):
            raise WorkspaceOpenError("workspace database cannot be opened")
        if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise WorkspaceOpenError("workspace database must be recreated for Mozarie v0.7")
        meta = {str(row["name"]): row for row in db.execute("PRAGMA table_info(meta)")}
        images = {str(row["name"]): row for row in db.execute("PRAGMA table_info(images)")}
        if (set(meta) != {"key", "value"} or str(meta["key"]["type"]).upper() != "TEXT" or not int(meta["key"]["pk"])
                or str(meta["value"]["type"]).upper() != "TEXT" or not int(meta["value"]["notnull"])
                or not {"catalog_id", "source_id", "relative_path", "image_id", "size_bytes", "mtime_ns", "width", "height"}.issubset(images)):
            raise WorkspaceOpenError("workspace database must be recreated for Mozarie v0.7")

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

    def catalog_for_root(self, root: Path) -> str:
        # A root is a project hint only. Several projects may deliberately use
        # the same source folder, so it is never used as a unique identity.
        identity = str(root.resolve())
        now = time.time_ns()
        with self._lock, self._connect() as db:
            catalog_id = uuid.uuid4().hex
            db.execute("INSERT INTO catalogs(catalog_id,identity_hash,source_root,created_at,updated_at) VALUES(?,?,?,?,?)", (catalog_id, identity, identity, now, now))
            self._ensure_project_source_db(db, catalog_id, "native-folder", root.name or str(root), identity)
            return catalog_id

    @staticmethod
    def _ensure_project_source_db(db: sqlite3.Connection, catalog_id: str, kind: str, display_name: str, identity: str) -> str:
        row = db.execute("SELECT source_id FROM project_sources WHERE catalog_id=? AND source_identity=?", (catalog_id, identity)).fetchone()
        if row:
            return str(row["source_id"])
        source_id = uuid.uuid4().hex
        db.execute("""INSERT INTO project_sources(source_id,catalog_id,kind,display_name,native_path,source_identity,created_at)
            VALUES(?,?,?,?,?,?,?)""", (source_id, catalog_id, kind, display_name, identity if kind == "native-folder" else None, identity, time.time_ns()))
        return source_id

    def ensure_project_source(self, catalog_id: str, *, kind: str, display_name: str, identity: str) -> str:
        if kind not in {"native-folder", "browser-directory", "browser-files"} or not identity:
            raise ValueError("invalid project source")
        with self._lock, self._connect() as db:
            if db.execute("SELECT 1 FROM catalogs WHERE catalog_id=?", (catalog_id,)).fetchone() is None:
                raise ValueError("project is missing")
            return self._ensure_project_source_db(db, catalog_id, kind, display_name, identity)

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

    @staticmethod
    def _project_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": str(row["catalog_id"]), "name": row["name"], "status": str(row["status"]),
            "sourceRoot": row["source_root"], "createdAt": int(row["created_at"]),
            "updatedAt": int(row["updated_at"]), "imageCount": int(row["image_count"]),
        }

    def projects(self, sort: str = "updated_desc") -> list[dict[str, Any]]:
        order = {
            "name_asc": "catalogs.name COLLATE NOCASE ASC, catalogs.updated_at DESC",
            "name_desc": "catalogs.name COLLATE NOCASE DESC, catalogs.updated_at DESC",
            "created_asc": "catalogs.created_at ASC", "created_desc": "catalogs.created_at DESC",
            "updated_asc": "catalogs.updated_at ASC", "updated_desc": "catalogs.updated_at DESC",
        }.get(sort, "catalogs.updated_at DESC")
        with self._connect() as db:
            rows = db.execute(f"""SELECT catalogs.*,COUNT(images.image_id) AS image_count FROM catalogs
                LEFT JOIN images ON images.catalog_id=catalogs.catalog_id
                GROUP BY catalogs.catalog_id ORDER BY {order}""").fetchall()
        return [self._project_row(row) for row in rows]

    def project(self, catalog_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("""SELECT catalogs.*,COUNT(images.image_id) AS image_count FROM catalogs
                LEFT JOIN images ON images.catalog_id=catalogs.catalog_id WHERE catalogs.catalog_id=?
                GROUP BY catalogs.catalog_id""", (catalog_id,)).fetchone()
        return self._project_row(row) if row else None

    def project_images(self, catalog_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute("""SELECT image_id,relative_path,width,height FROM images
                WHERE catalog_id=? ORDER BY relative_path COLLATE NOCASE, image_id""", (catalog_id,)).fetchall()
        return [{"id": str(row["image_id"]), "relativePath": str(row["relative_path"]), "width": int(row["width"]), "height": int(row["height"])} for row in rows]

    def project_image(self, image_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("SELECT image_id,relative_path,width,height FROM images WHERE image_id=?", (image_id,)).fetchone()
        return {"id": str(row["image_id"]), "relativePath": str(row["relative_path"]), "width": int(row["width"]), "height": int(row["height"])} if row else None

    def create_project(self, name: str | None = None, source_root: str | None = None) -> dict[str, Any]:
        clean_name = name.strip() if isinstance(name, str) else ""
        if name is not None and not clean_name:
            raise ValueError("project name is required")
        now = time.time_ns(); catalog_id = uuid.uuid4().hex
        with self._lock, self._connect() as db:
            try:
                db.execute("INSERT INTO catalogs(catalog_id,identity_hash,name,status,source_root,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                           (catalog_id, f"project:{catalog_id}", clean_name or None, "working", source_root, now, now))
            except sqlite3.IntegrityError as exc:
                raise ValueError("project name already exists") from exc
        return self.project(catalog_id) or {}

    def name_project(self, catalog_id: str, name: str) -> dict[str, Any]:
        clean_name = name.strip()
        if not clean_name: raise ValueError("project name is required")
        with self._lock, self._connect() as db:
            try:
                cursor = db.execute("UPDATE catalogs SET name=?,updated_at=? WHERE catalog_id=?", (clean_name, time.time_ns(), catalog_id))
            except sqlite3.IntegrityError as exc:
                raise ValueError("project name already exists") from exc
            if not cursor.rowcount: raise ValueError("project is missing")
        return self.project(catalog_id) or {}

    def set_project_status(self, catalog_id: str, status: str) -> dict[str, Any]:
        if status not in {"working", "completed"}: raise ValueError("invalid project status")
        with self._lock, self._connect() as db:
            cursor = db.execute("UPDATE catalogs SET status=?,updated_at=? WHERE catalog_id=?", (status, time.time_ns(), catalog_id))
            if not cursor.rowcount: raise ValueError("project is missing")
        return self.project(catalog_id) or {}

    def projects_for_source_root(self, source_root: str, exclude_catalog: str | None = None) -> list[dict[str, Any]]:
        with self._connect() as db:
            sql = """SELECT catalogs.*,COUNT(images.image_id) AS image_count FROM catalogs
                JOIN project_sources ON project_sources.catalog_id=catalogs.catalog_id
                LEFT JOIN images ON images.catalog_id=catalogs.catalog_id WHERE project_sources.source_identity=?"""
            values: list[Any] = [source_root]
            if exclude_catalog:
                sql += " AND catalogs.catalog_id<>?"; values.append(exclude_catalog)
            sql += " GROUP BY catalogs.catalog_id ORDER BY catalogs.updated_at DESC"
            rows = db.execute(sql, values).fetchall()
        return [self._project_row(row) for row in rows]

    def set_project_source_root(self, catalog_id: str, source_root: str | None) -> None:
        with self._lock, self._connect() as db:
            db.execute("UPDATE catalogs SET source_root=?,updated_at=? WHERE catalog_id=?", (source_root, time.time_ns(), catalog_id))

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
        # Projects are explicit.  Never infer a project from file content or
        # silently merge browser imports into a similarly shaped project.
        return None

    def reconcile_images(self, catalog_id: str, records: list[Any], source_hashes: dict[str, str] | None = None, source_id: str | None = None) -> dict[str, dict[str, Any]]:
        """Return durable state by path without silently discarding edits."""
        now = time.time_ns()
        result: dict[str, dict[str, Any]] = {}
        if not records:
            return result
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                if source_id is None:
                    # Browser imports have one deterministic source per
                    # project.  Avoid an extra read in large folder imports.
                    source_id = f"browser-{catalog_id}"
                    db.execute("""INSERT OR IGNORE INTO project_sources(source_id,catalog_id,kind,display_name,native_path,source_identity,created_at)
                        VALUES(?,?,?,?,?,?,?)""", (source_id, catalog_id, "browser-files", "ブラウザから追加", None, f"browser:{catalog_id}", now))
                elif db.execute("SELECT 1 FROM project_sources WHERE source_id=? AND catalog_id=?", (source_id, catalog_id)).fetchone() is None:
                    raise ValueError("project source is missing")
                db.execute("""CREATE TEMP TABLE IF NOT EXISTS workspace_reconcile_records(
                    relative_path TEXT PRIMARY KEY,size_bytes INTEGER NOT NULL,mtime_ns INTEGER NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL)""")
                db.execute("DELETE FROM workspace_reconcile_records")
                db.executemany("INSERT INTO workspace_reconcile_records(relative_path,size_bytes,mtime_ns,width,height) VALUES(?,?,?,?,?)", (
                    (record.relative_path, record.size_bytes, record.mtime_ns, int(getattr(record, "width", 0)), int(getattr(record, "height", 0)))
                    for record in records
                ))
                existing = {
                    str(row["relative_path"]): row for row in db.execute("""SELECT images.* FROM images
                        JOIN workspace_reconcile_records AS incoming ON incoming.relative_path=images.relative_path
                        WHERE images.source_id=?""", (source_id,))
                }
                for record in records:
                    row = existing.get(record.relative_path)
                    if row is None:
                        image_id = uuid.uuid4().hex
                        db.execute("INSERT INTO images(catalog_id,source_id,relative_path,image_id,size_bytes,mtime_ns,width,height,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                                   (catalog_id, source_id, record.relative_path, image_id, record.size_bytes, record.mtime_ns, int(getattr(record, "width", 0)), int(getattr(record, "height", 0)), now))
                        result[record.relative_path] = {"image_id": image_id, "hidden": False, "reviewed": False, "revision": 0, "changed": False}
                        continue
                    width, height = int(getattr(record, "width", 0)), int(getattr(record, "height", 0))
                    changed = int(row["size_bytes"]) != record.size_bytes or int(row["mtime_ns"]) != record.mtime_ns or int(row["width"]) != width or int(row["height"]) != height
                    dimensions_changed = int(row["width"]) != width or int(row["height"]) != height
                    # Keep the old baseline until the user accepts the source
                    # change in the warning dialog. This makes a reopened
                    # project warn again instead of silently normalising it.
                    result[record.relative_path] = {"image_id": row["image_id"], "hidden": bool(row["hidden"]), "reviewed": False if changed else bool(row["reviewed"]), "revision": int(row["candidate_revision"]), "changed": changed, "dimensions_changed": dimensions_changed}
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        return result

    def accept_source_metadata(self, records: list[Any], *, preserve_mask_dimensions: bool = False) -> None:
        if not records: return
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                for record in records:
                    if preserve_mask_dimensions:
                        db.execute("UPDATE images SET size_bytes=?,mtime_ns=?,reviewed=0,updated_at=? WHERE image_id=?",
                                   (record.size_bytes, record.mtime_ns, time.time_ns(), record.image_id))
                    else:
                        db.execute("""UPDATE images SET size_bytes=?,mtime_ns=?,width=?,height=?,reviewed=0,updated_at=?
                            WHERE image_id=?""", (record.size_bytes, record.mtime_ns, record.width, record.height, time.time_ns(), record.image_id))
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

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
                    db.execute("UPDATE images SET mtime_ns=?,size_bytes=?,updated_at=? WHERE image_id=?", (mtime_ns, size_bytes, time.time_ns(), image_id))
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
                        db.execute("UPDATE candidates SET enabled=?,color=?,role=?,forced=? WHERE image_id=? AND candidate_id=?", (int(candidate.enabled), candidate.color, candidate.role.value, int(candidate.forced), image_id, candidate.candidate_id))
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
        history = payload.get("history", {})
        if not isinstance(history, dict):
            raise ValueError("invalid workspace history")
        history_json = json.dumps(history, ensure_ascii=False, separators=(",", ":"))
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
                has_effective_mask,history_json,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(image_id) DO UPDATE SET
                add_png=excluded.add_png,exclusion_png=excluded.exclusion_png,exclusion_erase_png=excluded.exclusion_erase_png,
                manual_enabled=excluded.manual_enabled,exclusion_enabled=excluded.exclusion_enabled,exclusion_erase_enabled=excluded.exclusion_erase_enabled,
                exclusion_forced=excluded.exclusion_forced,removed_candidate_ids=excluded.removed_candidate_ids,candidate_revision=excluded.candidate_revision,has_effective_mask=excluded.has_effective_mask,history_json=excluded.history_json,updated_at=excluded.updated_at""",
                    (image_id,add,exclusion,erase,int(payload.get("manualEnabled", True)),int(payload.get("manualExclusionEnabled", True)),int(payload.get("manualExclusionEraseEnabled", True)),int(payload.get("manualExclusionForced", True)),json.dumps(removed),revision,int(has_effective_mask),history_json,time.time_ns()))
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

    @staticmethod
    def _pack_blob(value: bytes | None) -> str | None:
        return None if value is None else base64.b64encode(value).decode("ascii")

    @staticmethod
    def _unpack_blob(value: Any) -> bytes | None:
        if value is None:
            return None
        if not isinstance(value, str):
            raise ValueError("workspace history is invalid")
        try:
            return base64.b64decode(value, validate=True)
        except (ValueError, TypeError) as exc:
            raise ValueError("workspace history is invalid") from exc

    def history_state(self, image_id: str) -> dict[str, Any]:
        """Capture every durable edit field needed to restore one image exactly."""
        with self._connect() as db:
            image = db.execute("SELECT catalog_id,candidate_revision FROM images WHERE image_id=?", (image_id,)).fetchone()
            if image is None:
                raise ValueError("workspace image is missing")
            candidates = db.execute("""SELECT candidate_id,label_token,confidence,mask_png,enabled,color,source,origin,
                refinement,role,forced,deleted FROM candidates WHERE image_id=? ORDER BY candidate_id""", (image_id,)).fetchall()
            manual = db.execute("SELECT * FROM manual_edits WHERE image_id=?", (image_id,)).fetchone()
        packed_candidates = []
        for row in candidates:
            raw = row["mask_png"]
            self._require_png_mask(raw)
            packed_candidates.append({
                "id": str(row["candidate_id"]), "label": str(row["label_token"]), "confidence": row["confidence"],
                "mask": self._pack_blob(raw), "enabled": bool(row["enabled"]), "color": str(row["color"]),
                "source": str(row["source"]), "origin": str(row["origin"]), "refinement": row["refinement"],
                "role": str(row["role"]), "forced": bool(row["forced"]), "deleted": bool(row["deleted"]),
            })
        packed_manual = None
        if manual is not None:
            packed_manual = {
                "add": self._pack_blob(manual["add_png"]), "exclusion": self._pack_blob(manual["exclusion_png"]),
                "erase": self._pack_blob(manual["exclusion_erase_png"]), "manualEnabled": bool(manual["manual_enabled"]),
                "exclusionEnabled": bool(manual["exclusion_enabled"]), "eraseEnabled": bool(manual["exclusion_erase_enabled"]),
                "exclusionForced": bool(manual["exclusion_forced"]), "removed": str(manual["removed_candidate_ids"]),
                "revision": int(manual["candidate_revision"]), "effective": bool(manual["has_effective_mask"]),
                "history": str(manual["history_json"]),
            }
        return {"catalog": str(image["catalog_id"]), "revision": int(image["candidate_revision"]), "candidates": packed_candidates, "manual": packed_manual}

    @staticmethod
    def _history_json(state: dict[str, Any]) -> str:
        return json.dumps(state, ensure_ascii=False, separators=(",", ":"), sort_keys=True)

    def record_history(self, image_id: str, before: dict[str, Any], after: dict[str, Any], *, group_id: str | None = None) -> None:
        """Append one completed operation, dropping only this image's abandoned redo path."""
        before_json = self._history_json(before); after_json = self._history_json(after)
        if before_json == after_json:
            return
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                image = db.execute("SELECT catalog_id FROM images WHERE image_id=?", (image_id,)).fetchone()
                if image is None:
                    raise ValueError("workspace image is missing")
                cursor = db.execute("SELECT entry_id FROM history_cursors WHERE image_id=?", (image_id,)).fetchone()
                last = int(cursor["entry_id"]) if cursor and cursor["entry_id"] is not None else 0
                redo_groups = [str(row["group_id"]) for row in db.execute(
                    "SELECT DISTINCT group_id FROM history_entries WHERE image_id=? AND entry_id>? AND group_id IS NOT NULL", (image_id, last)
                )]
                db.execute("DELETE FROM history_entries WHERE image_id=? AND entry_id>? AND group_id IS NULL", (image_id, last))
                for stale_group in redo_groups:
                    db.execute("DELETE FROM history_entries WHERE group_id=?", (stale_group,))
                cursor = db.execute("""INSERT INTO history_entries(catalog_id,image_id,group_id,before_json,after_json,created_at)
                    VALUES(?,?,?,?,?,?)""", (image["catalog_id"], image_id, group_id, before_json, after_json, time.time_ns()))
                db.execute("""INSERT INTO history_cursors(image_id,entry_id) VALUES(?,?)
                    ON CONFLICT(image_id) DO UPDATE SET entry_id=excluded.entry_id""", (image_id, cursor.lastrowid))
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    @staticmethod
    def _restore_history_state(db: sqlite3.Connection, image_id: str, state: dict[str, Any]) -> None:
        if not isinstance(state, dict) or not isinstance(state.get("candidates"), list):
            raise ValueError("workspace history is invalid")
        revision = state.get("revision")
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
            raise ValueError("workspace history is invalid")
        manual = state.get("manual")
        db.execute("DELETE FROM candidates WHERE image_id=?", (image_id,))
        for candidate in state["candidates"]:
            if not isinstance(candidate, dict):
                raise ValueError("workspace history is invalid")
            mask = WorkspaceStore._unpack_blob(candidate.get("mask")); WorkspaceStore._require_png_mask(mask)
            required = ("id", "label", "color", "source", "origin", "role")
            if any(not isinstance(candidate.get(key), str) for key in required):
                raise ValueError("workspace history is invalid")
            db.execute("""INSERT INTO candidates(image_id,candidate_id,label_token,confidence,mask_png,enabled,color,source,origin,refinement,role,forced,deleted)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""", (image_id, candidate["id"], candidate["label"], candidate.get("confidence"), mask,
                int(bool(candidate.get("enabled"))), candidate["color"], candidate["source"], candidate["origin"], candidate.get("refinement"),
                candidate["role"], int(bool(candidate.get("forced"))), int(bool(candidate.get("deleted")))))
        db.execute("DELETE FROM manual_edits WHERE image_id=?", (image_id,))
        if manual is not None:
            if not isinstance(manual, dict):
                raise ValueError("workspace history is invalid")
            blobs = tuple(WorkspaceStore._unpack_blob(manual.get(key)) for key in ("add", "exclusion", "erase"))
            for blob in blobs: WorkspaceStore._require_png_mask(blob)
            for key in ("removed", "history"):
                if not isinstance(manual.get(key), str): raise ValueError("workspace history is invalid")
            db.execute("""INSERT INTO manual_edits(image_id,add_png,exclusion_png,exclusion_erase_png,manual_enabled,exclusion_enabled,
                exclusion_erase_enabled,exclusion_forced,removed_candidate_ids,candidate_revision,has_effective_mask,history_json,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""", (image_id, *blobs, int(bool(manual.get("manualEnabled"))),
                int(bool(manual.get("exclusionEnabled"))), int(bool(manual.get("eraseEnabled"))), int(bool(manual.get("exclusionForced"))),
                manual["removed"], int(manual.get("revision", revision)), int(bool(manual.get("effective"))), manual["history"], time.time_ns()))
        db.execute("UPDATE images SET candidate_revision=?,reviewed=0,updated_at=? WHERE image_id=?", (revision, time.time_ns(), image_id))

    def history_status(self, image_id: str) -> dict[str, bool]:
        with self._connect() as db:
            cursor = db.execute("SELECT entry_id FROM history_cursors WHERE image_id=?", (image_id,)).fetchone()
            current = int(cursor["entry_id"]) if cursor and cursor["entry_id"] is not None else 0
            can_undo = current > 0
            can_redo = db.execute("SELECT 1 FROM history_entries WHERE image_id=? AND entry_id>?", (image_id, current)).fetchone() is not None
        return {"canUndo": can_undo, "canRedo": can_redo}

    def restore_history(self, image_id: str, direction: str) -> list[str]:
        if direction not in {"undo", "redo"}: raise ValueError("invalid history direction")
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                cursor = db.execute("SELECT entry_id FROM history_cursors WHERE image_id=?", (image_id,)).fetchone()
                current = int(cursor["entry_id"]) if cursor and cursor["entry_id"] is not None else 0
                if direction == "undo":
                    entry = db.execute("SELECT * FROM history_entries WHERE entry_id=? AND image_id=?", (current, image_id)).fetchone() if current else None
                else:
                    entry = db.execute("SELECT * FROM history_entries WHERE image_id=? AND entry_id>? ORDER BY entry_id LIMIT 1", (image_id, current)).fetchone()
                if entry is None:
                    db.execute("COMMIT"); return []
                entries = db.execute("SELECT * FROM history_entries WHERE group_id=? ORDER BY entry_id", (entry["group_id"],)).fetchall() if entry["group_id"] else [entry]
                changed: list[str] = []
                for member in entries:
                    state = json.loads(str(member["before_json"] if direction == "undo" else member["after_json"]))
                    self._restore_history_state(db, str(member["image_id"]), state)
                    if direction == "undo":
                        previous = db.execute("SELECT entry_id FROM history_entries WHERE image_id=? AND entry_id<? ORDER BY entry_id DESC LIMIT 1", (member["image_id"], member["entry_id"])).fetchone()
                        db.execute("""INSERT INTO history_cursors(image_id,entry_id) VALUES(?,?)
                            ON CONFLICT(image_id) DO UPDATE SET entry_id=excluded.entry_id""", (member["image_id"], previous["entry_id"] if previous else None))
                    else:
                        db.execute("""INSERT INTO history_cursors(image_id,entry_id) VALUES(?,?)
                            ON CONFLICT(image_id) DO UPDATE SET entry_id=excluded.entry_id""", (member["image_id"], member["entry_id"]))
                    changed.append(str(member["image_id"]))
                db.execute("COMMIT")
                return changed
            except Exception:
                db.execute("ROLLBACK")
                raise

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
        try:
            history = json.loads(str(row["history_json"]))
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise ValueError("workspace history is invalid") from exc
        if not isinstance(history, dict): raise ValueError("workspace history is invalid")
        return {"add": encoder(masks[0]), "exclusion": encoder(masks[1]), "exclusionErase": encoder(masks[2]), "manualEnabled": bool(row["manual_enabled"]), "manualExclusionEnabled": bool(row["exclusion_enabled"]), "manualExclusionEraseEnabled": bool(row["exclusion_erase_enabled"]), "manualExclusionForced": bool(row["exclusion_forced"]), "removedCandidateIds": removed, "candidateRevision": current_revision, "hasEffectiveMask": bool(row["has_effective_mask"]), "history": history}
