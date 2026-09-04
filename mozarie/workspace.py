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
import numpy as np


# Keep every IN clause comfortably below SQLite's smallest common bind limit.
_BULK_CHUNK_SIZE = 900


def _chunks(values: list[str]) -> list[list[str]]:
    return [values[index:index + _BULK_CHUNK_SIZE] for index in range(0, len(values), _BULK_CHUNK_SIZE)]


class WorkspaceOpenError(RuntimeError):
    """The durable workspace cannot be safely opened as the current schema."""


class ProjectNameAlreadyExistsError(ValueError):
    """A project name conflicts with the database uniqueness constraint."""


class _ClosingConnection(sqlite3.Connection):
    """sqlite's context manager commits but does not close on Windows."""
    def __exit__(self, *args: Any) -> None:
        try:
            super().__exit__(*args)
        finally:
            self.close()


class _PendingWorkspaceCommit:
    """One already-prepared SQLite transaction, finished by the state publisher."""
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def commit(self) -> None:
        try:
            self._db.execute("COMMIT")
        finally:
            self._db.close()

    def rollback(self) -> None:
        try:
            self._db.execute("ROLLBACK")
        finally:
            self._db.close()


class WorkspaceStore:
    # This is one current project-store schema.  Existing data is either this
    # schema or it must be explicitly recreated; migrations are intentionally
    # not supported.
    VERSION = 11

    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "workspaces.sqlite3"
        self._lock = threading.RLock()
        data_dir.mkdir(parents=True, exist_ok=True)
        # Inspect an existing database before issuing any write-capable pragma,
        # DDL, or cleanup statement. This schema has no migrations.
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
                    catalog_id TEXT PRIMARY KEY,
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
                    source_blocked INTEGER NOT NULL DEFAULT 0,
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
                CREATE TABLE IF NOT EXISTS candidate_metadata (
                    image_id TEXT NOT NULL REFERENCES images(image_id) ON DELETE CASCADE,
                    candidate_id TEXT NOT NULL, expand_px INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(image_id, candidate_id)
                );
                CREATE TABLE IF NOT EXISTS history_entries (
                    entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    catalog_id TEXT NOT NULL REFERENCES catalogs(catalog_id) ON DELETE CASCADE,
                    image_id TEXT NOT NULL REFERENCES images(image_id) ON DELETE CASCADE,
                    group_id TEXT,
                    before_json TEXT NOT NULL,
                    after_json TEXT NOT NULL,
                    delta_json TEXT NOT NULL DEFAULT '{}',
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS history_groups (
                    group_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('building','committed','failed')),
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS project_sources_identity ON project_sources(source_identity);
                CREATE INDEX IF NOT EXISTS images_catalog_source ON images(catalog_id,source_id,relative_path);
                CREATE INDEX IF NOT EXISTS candidates_image_active ON candidates(image_id,deleted,candidate_id);
                CREATE INDEX IF NOT EXISTS history_entries_image_entry ON history_entries(image_id, entry_id);
                CREATE INDEX IF NOT EXISTS history_entries_group ON history_entries(group_id);
                CREATE TABLE IF NOT EXISTS history_candidate_refs (
                    entry_id INTEGER NOT NULL REFERENCES history_entries(entry_id) ON DELETE CASCADE,
                    image_id TEXT NOT NULL REFERENCES images(image_id) ON DELETE CASCADE,
                    candidate_id TEXT NOT NULL,
                    PRIMARY KEY(entry_id, candidate_id)
                );
                CREATE INDEX IF NOT EXISTS history_candidate_refs_image_candidate ON history_candidate_refs(image_id, candidate_id);
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
                CREATE TRIGGER IF NOT EXISTS project_manual_insert AFTER INSERT ON manual_edits BEGIN
                    UPDATE catalogs SET updated_at=CAST(unixepoch('subsec')*1000000000 AS INTEGER)
                    WHERE catalog_id=(SELECT catalog_id FROM images WHERE image_id=NEW.image_id);
                END;
                CREATE TRIGGER IF NOT EXISTS project_manual_update AFTER UPDATE ON manual_edits BEGIN
                    UPDATE catalogs SET updated_at=CAST(unixepoch('subsec')*1000000000 AS INTEGER)
                    WHERE catalog_id=(SELECT catalog_id FROM images WHERE image_id=NEW.image_id);
                END;
                CREATE TRIGGER IF NOT EXISTS project_manual_delete AFTER DELETE ON manual_edits BEGIN
                    UPDATE catalogs SET updated_at=CAST(unixepoch('subsec')*1000000000 AS INTEGER)
                    WHERE catalog_id=(SELECT catalog_id FROM images WHERE image_id=OLD.image_id);
                END;
                CREATE TRIGGER IF NOT EXISTS history_entry_delete AFTER DELETE ON history_entries BEGIN
                    DELETE FROM history_groups WHERE group_id=OLD.group_id
                      AND NOT EXISTS (SELECT 1 FROM history_entries WHERE group_id=OLD.group_id);
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
                    raise WorkspaceOpenError(f"workspace database is not schema {self.VERSION}")
                version_row = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
                if version_row is None:
                    raise WorkspaceOpenError(f"workspace database is not schema {self.VERSION}")
                try:
                    version = int(version_row["value"])
                except (TypeError, ValueError) as exc:
                    raise WorkspaceOpenError(f"workspace database must be recreated for schema {self.VERSION}") from exc
                if version > self.VERSION:
                    raise WorkspaceOpenError(f"workspace database is newer than schema {self.VERSION}")
                if version != self.VERSION:
                    raise WorkspaceOpenError(f"workspace database must be recreated for schema {self.VERSION}")
                self._validate_schema(db, tables)
        except WorkspaceOpenError:
            raise
        except (OSError, sqlite3.DatabaseError) as exc:
            raise WorkspaceOpenError("workspace database cannot be opened") from exc

    @staticmethod
    def _validate_schema(db: sqlite3.Connection, tables: set[str]) -> None:
        required = {"meta", "catalogs", "project_sources", "images", "candidates", "candidate_metadata", "manual_edits", "history_entries", "history_groups", "history_candidate_refs", "history_cursors"}
        if not required.issubset(tables):
            raise WorkspaceOpenError(f"workspace database must be recreated for schema {WorkspaceStore.VERSION}")
        if tuple(row[0] for row in db.execute("PRAGMA quick_check(1)")) != ("ok",):
            raise WorkspaceOpenError("workspace database cannot be opened")
        if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise WorkspaceOpenError(f"workspace database must be recreated for schema {WorkspaceStore.VERSION}")
        meta = {str(row["name"]): row for row in db.execute("PRAGMA table_info(meta)")}
        catalogs = {str(row["name"]): row for row in db.execute("PRAGMA table_info(catalogs)")}
        images = {str(row["name"]): row for row in db.execute("PRAGMA table_info(images)")}
        history = {str(row["name"]): row for row in db.execute("PRAGMA table_info(history_entries)")}
        foreign = list(db.execute("PRAGMA foreign_key_list(images)"))
        indexes = list(db.execute("PRAGMA index_list(catalogs)"))
        name_unique_nocase = False
        for index in indexes:
            if not int(index["unique"]):
                continue
            index_name = str(index["name"]).replace('"', '""')
            columns = [
                (str(row["name"]), str(row["coll"]).upper())
                for row in db.execute(f'PRAGMA index_xinfo("{index_name}")')
                if int(row["key"])
            ]
            if columns == [("name", "NOCASE")]:
                name_unique_nocase = True
                break
        if (set(meta) != {"key", "value"} or str(meta["key"]["type"]).upper() != "TEXT" or not int(meta["key"]["pk"])
                or str(meta["value"]["type"]).upper() != "TEXT" or not int(meta["value"]["notnull"])
                or "catalog_id" not in catalogs or not int(catalogs["catalog_id"]["pk"])
                or not {"catalog_id", "source_id", "relative_path", "image_id", "size_bytes", "mtime_ns", "width", "height", "source_blocked"}.issubset(images)
                or not {"entry_id", "catalog_id", "image_id", "before_json", "after_json", "delta_json", "created_at"}.issubset(history)
                or not foreign
                or not name_unique_nocase):
            raise WorkspaceOpenError(f"workspace database must be recreated for schema {WorkspaceStore.VERSION}")

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=5, isolation_level=None, factory=_ClosingConnection)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA synchronous=NORMAL")
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
        """Hydrate candidate metadata without reading the mask BLOB."""
        value = row["expand_px"]
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError("workspace candidate expand pixels are invalid")
        hydrated = dict(row); hydrated["expand_px"] = value
        return hydrated

    @staticmethod
    def _ensure_project_source_db(db: sqlite3.Connection, catalog_id: str, kind: str, display_name: str, identity: str) -> str:
        row = db.execute("SELECT source_id,kind FROM project_sources WHERE catalog_id=? AND source_identity=?", (catalog_id, identity)).fetchone()
        if row:
            if str(row["kind"]) != kind:
                raise ValueError("project source kind does not match")
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

    def resolve_browser_source(
        self,
        catalog_id: str,
        *,
        kind: str,
        display_name: str,
        source_identity: str,
        create: bool,
    ) -> tuple[str, bool]:
        """Resolve one browser selection to its durable source.

        A browser can send back a source ID it already received for this
        project.  That ID is authoritative and must never be rebound to a
        different project or source kind.  New browser handles are stored
        under their explicit ``browser:`` identity.
        """
        if kind not in {"browser-files", "browser-directory"} or not source_identity:
            raise ValueError("invalid browser source")
        identity = f"browser:{source_identity}"
        with self._lock, self._connect() as db:
            direct = db.execute(
                "SELECT source_id,catalog_id,kind FROM project_sources WHERE source_id=?",
                (source_identity,),
            ).fetchone()
            if direct is not None:
                if str(direct["catalog_id"]) != catalog_id or str(direct["kind"]) != kind:
                    raise ValueError("browser source does not belong to this project")
                return str(direct["source_id"]), False
            matched = db.execute(
                "SELECT source_id,kind FROM project_sources WHERE catalog_id=? AND source_identity=?",
                (catalog_id, identity),
            ).fetchone()
            if matched is not None:
                if str(matched["kind"]) != kind:
                    raise ValueError("project source kind does not match")
                return str(matched["source_id"]), False
            if not create:
                raise ValueError("browser source is missing")
            if db.execute("SELECT 1 FROM catalogs WHERE catalog_id=?", (catalog_id,)).fetchone() is None:
                raise ValueError("project is missing")
            return self._ensure_project_source_db(db, catalog_id, kind, display_name, identity), True

    def rollback_import(self, catalog_id: str, source_id: str, created_ids: list[str], *, delete_source: bool) -> None:
        """Undo only database rows created by one failed browser import."""
        unique_ids = list(dict.fromkeys(created_ids))
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                if unique_ids:
                    placeholders = ",".join("?" for _ in unique_ids)
                    db.execute(
                        f"DELETE FROM images WHERE catalog_id=? AND source_id=? AND image_id IN ({placeholders})",
                        [catalog_id, source_id, *unique_ids],
                    )
                if delete_source:
                    db.execute("""DELETE FROM project_sources
                        WHERE source_id=? AND catalog_id=?
                          AND NOT EXISTS (SELECT 1 FROM images WHERE source_id=?)""",
                               (source_id, catalog_id, source_id))
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

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

    def project_sources(self, catalog_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute("""SELECT source_id,kind,display_name,native_path,source_identity
                FROM project_sources WHERE catalog_id=? ORDER BY created_at,source_id""", (catalog_id,)).fetchall()
        return [{"id": str(row["source_id"]), "kind": str(row["kind"]), "displayName": str(row["display_name"]),
                 "nativePath": row["native_path"], "identity": str(row["source_identity"])} for row in rows]

    def project_images(self, catalog_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute("""SELECT images.image_id,images.relative_path,images.width,images.height,
                project_sources.display_name,images.source_id FROM images JOIN project_sources ON project_sources.source_id=images.source_id
                WHERE images.catalog_id=? ORDER BY project_sources.display_name COLLATE NOCASE,images.relative_path COLLATE NOCASE,images.image_id""", (catalog_id,)).fetchall()
        return [{"id": str(row["image_id"]), "relativePath": str(row["relative_path"]), "width": int(row["width"]), "height": int(row["height"]),
                 "sourceId": str(row["source_id"]), "sourceDisplay": str(row["display_name"])} for row in rows]

    def project_image(self, image_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute("""SELECT images.image_id,images.relative_path,images.width,images.height,images.source_id,project_sources.display_name
                FROM images JOIN project_sources ON project_sources.source_id=images.source_id WHERE images.image_id=?""", (image_id,)).fetchone()
        return {"id": str(row["image_id"]), "relativePath": str(row["relative_path"]), "width": int(row["width"]), "height": int(row["height"]),
                "sourceId": str(row["source_id"]), "sourceDisplay": str(row["display_name"])} if row else None

    def create_project(self, name: str | None = None, source_root: str | None = None) -> dict[str, Any]:
        clean_name = name.strip() if isinstance(name, str) else ""
        if name is not None and not clean_name:
            raise ValueError("project name is required")
        now = time.time_ns(); catalog_id = uuid.uuid4().hex
        with self._lock, self._connect() as db:
            try:
                db.execute("INSERT INTO catalogs(catalog_id,name,status,source_root,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                           (catalog_id, clean_name or None, "working", source_root, now, now))
            except sqlite3.IntegrityError as exc:
                raise ProjectNameAlreadyExistsError("project name already exists") from exc
        return self.project(catalog_id) or {}

    def promote_projectless(
        self,
        name: str,
        sources: list[tuple[str, str, str, list[Any]]],
        candidates: dict[str, list[Any]],
        revisions: dict[str, int],
        effective_masks: dict[str, bool],
        manual_drafts: dict[str, dict[str, Any]],
        decoder: Any,
    ) -> tuple[dict[str, Any], dict[str, str]]:
        """Persist a projectless catalogue in one SQLite transaction."""
        clean_name = name.strip()
        if not clean_name:
            raise ValueError("project name is required")
        catalog_id = uuid.uuid4().hex
        now = time.time_ns()
        source_ids: dict[str, str] = {}
        records: list[Any] = []
        project: dict[str, Any] | None = None
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                try:
                    db.execute(
                        "INSERT INTO catalogs(catalog_id,name,status,source_root,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                        (catalog_id, clean_name, "working", None, now, now),
                    )
                except sqlite3.IntegrityError as exc:
                    raise ProjectNameAlreadyExistsError("project name already exists") from exc
                for kind, identity, display_name, members in sources:
                    source_id = self._ensure_project_source_db(db, catalog_id, kind, display_name, identity)
                    for record in members:
                        db.execute(
                            "INSERT INTO images(catalog_id,source_id,relative_path,image_id,size_bytes,mtime_ns,width,height,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                            (catalog_id, source_id, record.relative_path, record.image_id, record.size_bytes,
                             record.mtime_ns, record.width, record.height, now),
                        )
                        source_ids[record.image_id] = source_id
                        records.append(record)
                for record in records:
                    image_id = record.image_id
                    snapshot = candidates.get(image_id, [])
                    revision = revisions.get(image_id, 0)
                    if snapshot or revision:
                        before = self._history_state_db(db, image_id)
                        db.execute("UPDATE images SET candidate_revision=?,reviewed=0,updated_at=? WHERE image_id=?", (revision, time.time_ns(), image_id))
                        for candidate in snapshot:
                            try:
                                with candidate.mask_path.open("rb") as handle:
                                    mask = handle.read()
                            except OSError:
                                continue
                            self._require_png_mask(mask)
                            db.execute(
                                """INSERT INTO candidates(image_id,candidate_id,label_token,confidence,mask_png,enabled,color,source,origin,refinement,role,forced,deleted)
                                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)""",
                                (image_id, candidate.candidate_id, candidate.label_token, candidate.confidence, mask,
                                 int(candidate.enabled), candidate.color, candidate.source, candidate.origin,
                                 candidate.refinement, candidate.role.value, int(candidate.forced)),
                            )
                            db.execute(
                                "INSERT INTO candidate_metadata(image_id,candidate_id,expand_px) VALUES(?,?,?)",
                                (image_id, candidate.candidate_id, int(candidate.expand_px)),
                            )
                        self._update_manual_candidate_state(
                            db, image_id, revision,
                            {candidate.candidate_id for candidate in snapshot},
                            bool(effective_masks.get(image_id, False)),
                        )
                        self._record_history_db(db, image_id, before, self._history_state_db(db, image_id))
                    if record.hidden or record.reviewed:
                        before = self._history_state_db(db, image_id)
                        db.execute(
                            "UPDATE images SET hidden=?,reviewed=?,updated_at=? WHERE image_id=?",
                            (int(record.hidden), int(record.reviewed), time.time_ns(), image_id),
                        )
                        self._record_history_db(db, image_id, before, self._history_state_db(db, image_id))
                    draft = manual_drafts.get(image_id)
                    if draft is not None:
                        self._save_manual_db(db, image_id, draft, decoder)
                row = db.execute("""SELECT catalogs.*,COUNT(images.image_id) AS image_count FROM catalogs
                    LEFT JOIN images ON images.catalog_id=catalogs.catalog_id WHERE catalogs.catalog_id=?
                    GROUP BY catalogs.catalog_id""", (catalog_id,)).fetchone()
                project = self._project_row(row)
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        if project is None:
            raise RuntimeError("project promotion failed")
        return project, source_ids

    def name_project(self, catalog_id: str, name: str) -> dict[str, Any]:
        clean_name = name.strip()
        if not clean_name:
            raise ValueError("project name is required")
        with self._lock, self._connect() as db:
            try:
                cursor = db.execute("UPDATE catalogs SET name=?,updated_at=? WHERE catalog_id=?", (clean_name, time.time_ns(), catalog_id))
            except sqlite3.IntegrityError as exc:
                raise ProjectNameAlreadyExistsError("project name already exists") from exc
            if not cursor.rowcount:
                raise ValueError("project is missing")
        return self.project(catalog_id) or {}

    def set_project_status(self, catalog_id: str, status: str) -> dict[str, Any]:
        if status not in {"working", "completed"}:
            raise ValueError("invalid project status")
        with self._lock, self._connect() as db:
            cursor = db.execute("UPDATE catalogs SET status=?,updated_at=? WHERE catalog_id=?", (status, time.time_ns(), catalog_id))
            if not cursor.rowcount:
                raise ValueError("project is missing")
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

    def delete_project(self, catalog_id: str) -> None:
        """Permanently remove one explicit project and all of its workspace rows."""
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                cursor = db.execute("DELETE FROM catalogs WHERE catalog_id=?", (catalog_id,))
                if not cursor.rowcount:
                    raise ValueError("project is missing")
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    def reconcile_images(
        self,
        catalog_id: str,
        records: list[Any],
        source_id: str | None = None,
        *,
        allow_new: bool = True,
    ) -> dict[str, dict[str, Any]]:
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
                requested_ids = {
                    str(getattr(record, "image_id", ""))
                    for record in records
                    if str(getattr(record, "image_id", ""))
                }
                used_ids = {}
                if requested_ids:
                    placeholders = ",".join("?" for _ in requested_ids)
                    used_ids = {
                        str(row["image_id"]): row
                        for row in db.execute(
                            f"SELECT image_id,catalog_id,source_id,relative_path FROM images WHERE image_id IN ({placeholders})",
                            list(requested_ids),
                        )
                    }
                for record in records:
                    row = existing.get(record.relative_path)
                    if row is None:
                        if not allow_new:
                            raise ValueError("project source cannot add images")
                        # A projectless session owns a real, opaque image ID
                        # already.  Promoting it to a project must preserve
                        # that identity so its current editor state can be
                        # written without a client-side remap.
                        image_id = str(getattr(record, "image_id", "")) or uuid.uuid4().hex
                        owner = used_ids.get(image_id)
                        if owner is not None:
                            raise ValueError("image identity already belongs to another source")
                        db.execute("INSERT INTO images(catalog_id,source_id,relative_path,image_id,size_bytes,mtime_ns,width,height,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                                   (catalog_id, source_id, record.relative_path, image_id, record.size_bytes, record.mtime_ns, int(getattr(record, "width", 0)), int(getattr(record, "height", 0)), now))
                        result[record.relative_path] = {
                            "image_id": image_id, "hidden": False, "reviewed": False,
                            "revision": 0, "changed": False, "created": True,
                        }
                        continue
                    width, height = int(getattr(record, "width", 0)), int(getattr(record, "height", 0))
                    changed = int(row["size_bytes"]) != record.size_bytes or int(row["mtime_ns"]) != record.mtime_ns or int(row["width"]) != width or int(row["height"]) != height
                    dimensions_changed = int(row["width"]) != width or int(row["height"]) != height
                    # Keep the old baseline until the user accepts the source
                    # change in the warning dialog. This makes a reopened
                    # project warn again instead of silently normalising it.
                    result[record.relative_path] = {
                        "image_id": row["image_id"], "hidden": bool(row["hidden"]),
                        "reviewed": False if changed else bool(row["reviewed"]),
                        "revision": int(row["candidate_revision"]),
                        "changed": changed or bool(row["source_blocked"]),
                        "dimensions_changed": dimensions_changed or bool(row["source_blocked"]),
                        "created": False,
                    }
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        return result

    def source_image_metadata(self, source_id: str) -> dict[str, tuple[int, int, int, int]]:
        """Return the fingerprint needed to skip image decoding during a reopen."""
        with self._connect() as db:
            rows = db.execute("SELECT relative_path,size_bytes,mtime_ns,width,height FROM images WHERE source_id=?", (source_id,)).fetchall()
        return {
            str(row["relative_path"]): (int(row["size_bytes"]), int(row["mtime_ns"]), int(row["width"]), int(row["height"]))
            for row in rows
        }

    def acknowledge_source_mismatches(self, records: list[Any], revisions: dict[str, int] | None = None) -> None:
        """Accept selected source metadata, optionally clearing their masks atomically."""
        selected = {str(record.image_id): record for record in records}
        if not selected:
            return
        clear_revisions = revisions or {}
        if set(clear_revisions) - set(selected):
            raise ValueError("workspace clear selection does not match source acknowledgement")
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                if clear_revisions:
                    self._clear_image_workspaces_db(db, clear_revisions)
                now = time.time_ns()
                for image_id, record in selected.items():
                    db.execute("""UPDATE images SET size_bytes=?,mtime_ns=?,width=?,height=?,source_blocked=0,reviewed=0,updated_at=?
                        WHERE image_id=?""", (record.size_bytes, record.mtime_ns, record.width, record.height, now, image_id))
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

    def clear_image_workspaces(self, revisions: dict[str, int], *, history_group: str | None = None) -> None:
        """Clear a selection in one durable transaction and one undo group."""
        if not revisions:
            return
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                self._clear_image_workspaces_db(db, revisions, history_group=history_group)
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    def _clear_image_workspaces_db(self, db: sqlite3.Connection, revisions: dict[str, int], *, history_group: str | None = None) -> None:
        """Clear active masks using the caller's open transaction."""
        group_id = history_group
        if group_id is None and len(revisions) > 1:
            group_id = uuid.uuid4().hex
            db.execute("INSERT INTO history_groups(group_id,status,created_at) VALUES(?,?,?)", (group_id, "committed", time.time_ns()))
        for image_id, revision in revisions.items():
            before = self._history_state_db(db, image_id)
            # Keep immutable candidate PNGs for the undo journal. A clear
            # only makes the generation inactive; explicit image deletion
            # still cascades all of it.
            db.execute("UPDATE candidates SET deleted=1 WHERE image_id=?", (image_id,))
            db.execute("DELETE FROM manual_edits WHERE image_id=?", (image_id,))
            db.execute("UPDATE images SET candidate_revision=?,reviewed=0,updated_at=? WHERE image_id=?", (revision, time.time_ns(), image_id))
            self._record_history_db(db, image_id, before, self._history_state_db(db, image_id), group_id=group_id)

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
            db.execute("BEGIN IMMEDIATE")
            try:
                before = self._history_state_db(db, image_id)
                db.execute(f"UPDATE images SET {','.join(updates)},updated_at=? WHERE image_id=?", values)
                self._record_history_db(db, image_id, before, self._history_state_db(db, image_id))
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    def set_image_flags_bulk(self, image_ids: list[str], *, hidden: bool | None = None, reviewed: bool | None = None) -> None:
        """Apply one catalogue flag change as one durable undo operation."""
        updates: list[str] = []
        values: list[Any] = []
        if hidden is not None:
            updates.append("hidden=?"); values.append(int(hidden))
        if reviewed is not None:
            updates.append("reviewed=?"); values.append(int(reviewed))
        if not updates or not image_ids:
            return
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                changed_ids: list[str] = []
                for image_id in image_ids:
                    row = db.execute("SELECT hidden,reviewed FROM images WHERE image_id=?", (image_id,)).fetchone()
                    if row is None:
                        continue
                    if ((hidden is not None and bool(row["hidden"]) != hidden)
                            or (reviewed is not None and bool(row["reviewed"]) != reviewed)):
                        changed_ids.append(image_id)
                if not changed_ids:
                    db.execute("COMMIT")
                    return
                group_id = uuid.uuid4().hex
                db.execute("INSERT INTO history_groups(group_id,status,created_at) VALUES(?,?,?)", (group_id, "committed", time.time_ns()))
                for image_id in changed_ids:
                    before = self._history_state_db(db, image_id)
                    db.execute(f"UPDATE images SET {','.join(updates)},updated_at=? WHERE image_id=?", [*values, time.time_ns(), image_id])
                    self._record_history_db(db, image_id, before, self._history_state_db(db, image_id), group_id=group_id)
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    def commit_save(self, image_id: str, *, mtime_ns: int | None = None, size_bytes: int | None = None,
                    candidate_revision: int | None = None,
                    clear_workspace: bool, delete_image: bool = False) -> None:
        """Commit one completed save before its in-memory review state is published."""
        if not delete_image and mtime_ns is None and size_bytes is None and candidate_revision is None and not clear_workspace:
            return
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
        try:
            removed = json.loads(row["removed_candidate_ids"])
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise ValueError("workspace removed candidates are invalid") from exc
        if not isinstance(removed, list) or any(not isinstance(item, str) for item in removed):
            raise ValueError("workspace removed candidates are invalid")
        db.execute("""UPDATE manual_edits SET removed_candidate_ids=?,candidate_revision=?,has_effective_mask=?,updated_at=?
            WHERE image_id=?""", (json.dumps(sorted(set(removed) & candidate_ids)), revision, int(effective), time.time_ns(), image_id))

    def commit_candidate_state(self, image_id: str, revision: int, candidates: list[Any], effective: bool, *, replace: bool,
                               history_group: str | None = None, expected_revision: int | None = None) -> None:
        """Atomically store one complete candidate/manual revision before publication."""
        self.prepare_candidate_state(
            image_id, revision, candidates, effective, replace=replace, history_group=history_group,
            expected_revision=expected_revision,
        ).commit()

    def prepare_candidate_state(self, image_id: str, revision: int, candidates: list[Any], effective: bool, *, replace: bool,
                                history_group: str | None = None, expected_revision: int | None = None,
                                preserve_reviewed: bool = False) -> _PendingWorkspaceCommit:
        """Write a candidate revision but leave COMMIT to the state publisher."""
        with self._lock:
            db = self._connect()
            db.execute("BEGIN IMMEDIATE")
            try:
                if expected_revision is not None:
                    current = db.execute("SELECT candidate_revision FROM images WHERE image_id=?", (image_id,)).fetchone()
                    if current is None or int(current["candidate_revision"]) != expected_revision:
                        raise ValueError("workspace candidate revision changed")
                before = self._history_state_db(db, image_id)
                if preserve_reviewed:
                    db.execute("UPDATE images SET candidate_revision=?, updated_at=? WHERE image_id=?", (revision, time.time_ns(), image_id))
                else:
                    db.execute("UPDATE images SET candidate_revision=?, reviewed=0, updated_at=? WHERE image_id=?", (revision, time.time_ns(), image_id))
                if replace:
                    db.execute("UPDATE candidates SET deleted=1 WHERE image_id=?", (image_id,))
                    for candidate in candidates:
                        row = db.execute("SELECT mask_png FROM candidates WHERE image_id=? AND candidate_id=?", (image_id, candidate.candidate_id)).fetchone()
                        if row is None:
                            try:
                                with candidate.mask_path.open("rb") as handle: mask = handle.read()
                            except OSError:
                                continue
                            self._require_png_mask(mask)
                            db.execute("""INSERT INTO candidates(image_id,candidate_id,label_token,confidence,mask_png,enabled,color,source,origin,refinement,role,forced,deleted)
                                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)""", (image_id,candidate.candidate_id,candidate.label_token,candidate.confidence,mask,int(candidate.enabled),candidate.color,candidate.source,candidate.origin,candidate.refinement,candidate.role.value,int(candidate.forced)))
                        else:
                            # Existing IDs retain the one detector PNG.
                            # Structural edits only reactivate/update metadata.
                            db.execute("""UPDATE candidates SET label_token=?,confidence=?,enabled=?,color=?,source=?,origin=?,refinement=?,role=?,forced=?,deleted=0
                                WHERE image_id=? AND candidate_id=?""", (candidate.label_token,candidate.confidence,int(candidate.enabled),candidate.color,candidate.source,candidate.origin,candidate.refinement,candidate.role.value,int(candidate.forced),image_id,candidate.candidate_id))
                        db.execute("""INSERT INTO candidate_metadata(image_id,candidate_id,expand_px) VALUES(?,?,?)
                            ON CONFLICT(image_id,candidate_id) DO UPDATE SET expand_px=excluded.expand_px""",
                                   (image_id, candidate.candidate_id, int(candidate.expand_px)))
                    # Deleted rows are referenced by durable undo entries.
                    # They are collected only when the image/project is
                    # explicitly deleted, never at every metadata operation.
                else:
                    for candidate in candidates:
                        # Normal candidate controls only alter metadata. Keep
                        # the durable PNG BLOB untouched instead of rereading
                        # a potentially lazy cache file.
                        db.execute("UPDATE candidates SET enabled=?,color=?,role=?,forced=? WHERE image_id=? AND candidate_id=?", (int(candidate.enabled), candidate.color, candidate.role.value, int(candidate.forced), image_id, candidate.candidate_id))
                        db.execute("""INSERT INTO candidate_metadata(image_id,candidate_id,expand_px) VALUES(?,?,?)
                            ON CONFLICT(image_id,candidate_id) DO UPDATE SET expand_px=excluded.expand_px""",
                                   (image_id, candidate.candidate_id, int(candidate.expand_px)))
                self._update_manual_candidate_state(db, image_id, revision, {candidate.candidate_id for candidate in candidates}, effective)
                self._record_history_db(db, image_id, before, self._history_state_db(db, image_id), group_id=history_group)
                return _PendingWorkspaceCommit(db)
            except Exception:
                db.execute("ROLLBACK")
                db.close()
                raise

    def hydrate_candidates(self, image_id: str, directory: Path, candidate_factory: Any) -> tuple[int, list[Any]]:
        with self._connect() as db:
            image = db.execute("SELECT candidate_revision FROM images WHERE image_id=?", (image_id,)).fetchone()
            rows = db.execute("""SELECT candidates.candidate_id,label_token,confidence,enabled,color,source,origin,refinement,role,forced,
                COALESCE(candidate_metadata.expand_px,0) AS expand_px,length(mask_png) AS mask_size,substr(mask_png,1,24) AS mask_header
                FROM candidates LEFT JOIN candidate_metadata USING(image_id,candidate_id)
                WHERE candidates.image_id=? AND deleted=0""", (image_id,)).fetchall()
        if not image: return 0, []
        if not rows: return int(image["candidate_revision"]), []
        for row in rows: self._require_candidate_png_header(row["mask_size"], row["mask_header"])
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
                for row in db.execute(f"""SELECT candidates.image_id,candidates.candidate_id,label_token,confidence,enabled,color,source,origin,refinement,role,forced,
                    COALESCE(candidate_metadata.expand_px,0) AS expand_px,length(mask_png) AS mask_size,substr(mask_png,1,24) AS mask_header
                    FROM candidates LEFT JOIN candidate_metadata USING(image_id,candidate_id)
                    WHERE candidates.image_id IN ({placeholders}) AND deleted=0""", chunk):
                    self._require_candidate_png_header(row["mask_size"], row["mask_header"])
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

    @staticmethod
    def _require_candidate_png_header(mask_size: Any, header: Any) -> None:
        """Reject broken durable candidate rows without fetching their BLOBs."""
        if (isinstance(mask_size, bool) or not isinstance(mask_size, int) or mask_size < 24
                or not isinstance(header, bytes) or len(header) != 24
                or header[:8] != b"\x89PNG\r\n\x1a\n" or header[8:12] != b"\x00\x00\x00\r"
                or header[12:16] != b"IHDR" or int.from_bytes(header[16:20], "big") <= 0
                or int.from_bytes(header[20:24], "big") <= 0):
            raise ValueError("workspace candidate PNG is invalid")

    def _save_manual_db(self, db: sqlite3.Connection, image_id: str, payload: dict[str, Any], decoder: Any) -> None:
        removed = payload.get("removedCandidateIds", [])
        if not isinstance(removed, list) or any(not isinstance(item, str) for item in removed):
            raise ValueError("invalid removed candidates")
        has_effective_mask = payload.get("hasEffectiveMask")
        if not isinstance(has_effective_mask, bool):
            raise ValueError("invalid effective mask")
        # Browser stroke history is an interaction cache, not a second durable
        # journal.  The SQLite operation delta below is the single source of
        # truth for undo/redo after reopening a project.
        history_json = "{}"
        request_keys = {"add": "add", "exclusion": "exclusion", "exclusionErase": "exclusionErase"}
        dirty_layers = payload.get("dirtyLayers")
        if dirty_layers is None:
            dirty = set(request_keys)
        elif not isinstance(dirty_layers, list) or any(layer not in request_keys for layer in dirty_layers):
            raise ValueError("invalid manual dirty layers")
        else:
            dirty = set(dirty_layers)
        decoded = {layer: decoder(payload.get(request_keys[layer])) for layer in dirty}
        raw_rois = payload.get("dirtyRois", {})
        if not isinstance(raw_rois, dict):
            raise ValueError("invalid manual dirty regions")
        rois: dict[str, tuple[int, int, int, int]] = {}
        for layer, raw in raw_rois.items():
            if layer not in dirty or not isinstance(raw, dict):
                raise ValueError("invalid manual dirty regions")
            values = tuple(raw.get(key) for key in ("left", "top", "right", "bottom"))
            if any(isinstance(value, bool) or not isinstance(value, int) for value in values) or values[0] < 0 or values[1] < 0 or values[2] <= values[0] or values[3] <= values[1]:
                raise ValueError("invalid manual dirty regions")
            rois[layer] = values
        before = self._history_state_db(db, image_id)
        previous_layers = before.get("_manual_raw") or {}
        layers = {
            "add": decoded["add"] if "add" in dirty else previous_layers.get("add"),
            "exclusion": decoded["exclusion"] if "exclusion" in dirty else previous_layers.get("exclusion"),
            "erase": decoded["exclusionErase"] if "exclusionErase" in dirty else previous_layers.get("erase"),
        }
        # Browser saves include all three layers, but a normal stroke changes
        # one. Validate only newly inserted bytes.
        for key, mask in layers.items():
            if mask != previous_layers.get(key):
                self._require_png_mask(mask)
        image = db.execute("SELECT candidate_revision FROM images WHERE image_id=?", (image_id,)).fetchone()
        revision = int(image["candidate_revision"])
        valid_ids = {str(row["candidate_id"]) for row in db.execute(
            "SELECT candidate_id FROM candidates WHERE image_id=? AND deleted=0", (image_id,)
        )}
        # Candidate IDs are revision-local. Persisting only current IDs keeps
        # an old editor tab from suppressing a newly detected mask.
        removed = sorted(set(removed) & valid_ids)
        db.execute("""INSERT INTO manual_edits(
                image_id,add_png,exclusion_png,exclusion_erase_png,manual_enabled,exclusion_enabled,
                exclusion_erase_enabled,exclusion_forced,removed_candidate_ids,candidate_revision,
                has_effective_mask,history_json,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(image_id) DO UPDATE SET
                add_png=excluded.add_png,exclusion_png=excluded.exclusion_png,exclusion_erase_png=excluded.exclusion_erase_png,
                manual_enabled=excluded.manual_enabled,exclusion_enabled=excluded.exclusion_enabled,exclusion_erase_enabled=excluded.exclusion_erase_enabled,
                exclusion_forced=excluded.exclusion_forced,removed_candidate_ids=excluded.removed_candidate_ids,candidate_revision=excluded.candidate_revision,has_effective_mask=excluded.has_effective_mask,history_json=excluded.history_json,updated_at=excluded.updated_at""",
            (image_id,layers["add"],layers["exclusion"],layers["erase"],int(payload.get("manualEnabled", True)),int(payload.get("manualExclusionEnabled", True)),int(payload.get("manualExclusionEraseEnabled", True)),int(payload.get("manualExclusionForced", True)),json.dumps(removed),revision,int(has_effective_mask),history_json,time.time_ns()))
        self._record_history_db(db, image_id, before, self._history_state_db(db, image_id), manual_rois={
            "add": rois.get("add"), "exclusion": rois.get("exclusion"), "erase": rois.get("exclusionErase"),
        })

    def save_manual(self, image_id: str, payload: dict[str, Any], decoder: Any) -> None:
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                self._save_manual_db(db, image_id, payload, decoder)
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
        """Capture durable edit metadata without copying mask PNGs into history.

        The private raw layer values are used only while one operation is being
        committed to derive a compact XOR delta.  They are never serialized.
        Candidate PNGs remain in ``candidates`` and are referenced by ID.
        """
        with self._connect() as db:
            return self._history_state_db(db, image_id)

    def _history_state_db(self, db: sqlite3.Connection, image_id: str) -> dict[str, Any]:
        """Capture a history state on the caller's transaction connection."""
        image = db.execute("SELECT catalog_id,candidate_revision,hidden,reviewed FROM images WHERE image_id=?", (image_id,)).fetchone()
        if image is None:
            raise ValueError("workspace image is missing")
        candidates = db.execute("""SELECT candidates.candidate_id,label_token,confidence,enabled,color,source,origin,
            refinement,role,forced,deleted,candidate_metadata.expand_px FROM candidates
            LEFT JOIN candidate_metadata USING(image_id,candidate_id) WHERE candidates.image_id=? AND candidates.deleted=0
            ORDER BY candidates.candidate_id""", (image_id,)).fetchall()
        manual = db.execute("SELECT * FROM manual_edits WHERE image_id=?", (image_id,)).fetchone()
        packed_candidates = []
        for row in candidates:
            packed_candidates.append({
                "id": str(row["candidate_id"]), "label": str(row["label_token"]), "confidence": row["confidence"],
                "enabled": bool(row["enabled"]), "color": str(row["color"]),
                "source": str(row["source"]), "origin": str(row["origin"]), "refinement": row["refinement"],
                "role": str(row["role"]), "forced": bool(row["forced"]), "deleted": bool(row["deleted"]),
                "expandPx": int(row["expand_px"] or 0),
            })
        packed_manual = None
        manual_raw: dict[str, bytes | None] | None = None
        if manual is not None:
            manual_raw = {"add": manual["add_png"], "exclusion": manual["exclusion_png"], "erase": manual["exclusion_erase_png"]}
            packed_manual = {
                "manualEnabled": bool(manual["manual_enabled"]),
                "exclusionEnabled": bool(manual["exclusion_enabled"]), "eraseEnabled": bool(manual["exclusion_erase_enabled"]),
                "exclusionForced": bool(manual["exclusion_forced"]), "removed": str(manual["removed_candidate_ids"]),
                "revision": int(manual["candidate_revision"]), "effective": bool(manual["has_effective_mask"]),
            }
        return {"catalog": str(image["catalog_id"]), "revision": int(image["candidate_revision"]),
                "flags": {"hidden": bool(image["hidden"]), "reviewed": bool(image["reviewed"])},
                "candidates": packed_candidates, "manual": packed_manual, "_manual_raw": manual_raw}

    def export_state(self, image_id: str) -> dict[str, Any]:
        """Return current masks for an explicit mask download, never history."""
        state = self.history_state(image_id)
        with self._connect() as db:
            rows = db.execute("SELECT candidate_id,mask_png FROM candidates WHERE image_id=?", (image_id,)).fetchall()
        masks = {str(row["candidate_id"]): row["mask_png"] for row in rows}
        for candidate in state["candidates"]:
            raw = masks.get(candidate["id"])
            self._require_png_mask(raw)
            candidate["mask"] = self._pack_blob(raw)
        manual = state.get("manual")
        if manual is not None:
            raw = state.get("_manual_raw") or {}
            manual.update({key: self._pack_blob(raw.get(key)) for key in ("add", "exclusion", "erase")})
        return self._history_public_state(state)

    def iter_project_export_states(self, catalog_id: str):
        """Yield project masks from one read transaction without text encoding them."""
        with self._connect() as db:
            db.execute("BEGIN")
            try:
                images = db.execute("""SELECT images.image_id,images.relative_path,images.width,images.height,images.source_id,
                    project_sources.display_name FROM images JOIN project_sources ON project_sources.source_id=images.source_id
                    WHERE images.catalog_id=? ORDER BY images.image_id""", (catalog_id,))
                candidate_rows = iter(db.execute("""SELECT candidates.image_id,candidates.candidate_id,candidates.mask_png,candidates.enabled,
                    candidates.role,candidates.forced,candidate_metadata.expand_px FROM candidates JOIN images USING(image_id)
                    LEFT JOIN candidate_metadata USING(image_id,candidate_id)
                    WHERE images.catalog_id=? AND candidates.deleted=0 ORDER BY candidates.image_id,candidates.candidate_id""", (catalog_id,)))
                manual_rows = iter(db.execute("""SELECT manual_edits.* FROM manual_edits JOIN images USING(image_id)
                    WHERE images.catalog_id=? ORDER BY manual_edits.image_id""", (catalog_id,)))
                candidate = next(candidate_rows, None)
                manual = next(manual_rows, None)
                for image in images:
                    image_id = str(image["image_id"])
                    candidates: list[dict[str, Any]] = []
                    while candidate is not None and str(candidate["image_id"]) == image_id:
                        candidates.append({
                            "id": str(candidate["candidate_id"]), "mask": candidate["mask_png"], "enabled": bool(candidate["enabled"]),
                            "role": str(candidate["role"]), "forced": bool(candidate["forced"]), "expandPx": int(candidate["expand_px"] or 0),
                        })
                        candidate = next(candidate_rows, None)
                    current_manual = manual if manual is not None and str(manual["image_id"]) == image_id else None
                    if current_manual is not None:
                        manual = next(manual_rows, None)
                    yield {
                        "image": {"id": image_id, "relativePath": str(image["relative_path"]),
                                  "width": int(image["width"]), "height": int(image["height"]),
                                  "sourceId": str(image["source_id"]), "sourceDisplay": str(image["display_name"])},
                        "candidates": candidates,
                        "manual": None if current_manual is None else {
                            "add": current_manual["add_png"], "exclusion": current_manual["exclusion_png"], "erase": current_manual["exclusion_erase_png"],
                            "manualEnabled": bool(current_manual["manual_enabled"]), "exclusionEnabled": bool(current_manual["exclusion_enabled"]),
                            "eraseEnabled": bool(current_manual["exclusion_erase_enabled"]), "exclusionForced": bool(current_manual["exclusion_forced"]),
                            "removed": str(current_manual["removed_candidate_ids"]),
                        },
                    }
            finally:
                db.execute("ROLLBACK")

    @staticmethod
    def _history_public_state(state: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in state.items() if key != "_manual_raw"}

    @staticmethod
    def _history_json(state: dict[str, Any]) -> str:
        return json.dumps(WorkspaceStore._history_public_state(state), ensure_ascii=False, separators=(",", ":"), sort_keys=True)

    @staticmethod
    def _manual_xor(before: bytes | None, after: bytes | None, roi: tuple[int, int, int, int] | None = None) -> dict[str, Any] | None:
        """Encode only the changed rectangle of a binary manual layer."""
        if before is None and after is None: return None
        if before == after: return None
        source = before if before is not None else after
        assert source is not None
        with Image.open(io.BytesIO(source)) as image: width, height = image.size
        if roi is None:
            left, top, right, bottom = 0, 0, width, height
        else:
            left, top, right, bottom = roi
            if right > width or bottom > height:
                raise ValueError("workspace manual dirty region is invalid")
        def pixels(raw: bytes | None) -> np.ndarray:
            if raw is None: return np.zeros((bottom - top, right - left), dtype=np.uint8)
            with Image.open(io.BytesIO(raw)) as image:
                if image.size != (width, height):
                    raise ValueError("workspace manual mask dimensions are invalid")
                return np.asarray(image.crop((left, top, right, bottom)).convert("L"), dtype=np.uint8) > 0
        changed = np.logical_xor(pixels(before), pixels(after))
        ys, xs = np.where(changed)
        if not len(xs): return {"existsBefore": before is not None, "existsAfter": after is not None, "box": None}
        changed_left, changed_right = left + int(xs.min()), left + int(xs.max()) + 1
        changed_top, changed_bottom = top + int(ys.min()), top + int(ys.max()) + 1
        output = io.BytesIO(); Image.fromarray(changed[ys.min():ys.max() + 1, xs.min():xs.max() + 1].astype(np.uint8) * 255).save(output, format="PNG")
        return {"existsBefore": before is not None, "existsAfter": after is not None,
                "box": [changed_left, changed_top, changed_right - changed_left, changed_bottom - changed_top], "png": base64.b64encode(output.getvalue()).decode("ascii"), "size": [width, height]}

    @classmethod
    def _manual_delta(cls, before: dict[str, Any], after: dict[str, Any], rois: dict[str, tuple[int, int, int, int]] | None = None) -> dict[str, Any]:
        old = before.get("_manual_raw") or {}; new = after.get("_manual_raw") or {}
        return {key: value for key in ("add", "exclusion", "erase") if (value := cls._manual_xor(old.get(key), new.get(key), (rois or {}).get(key))) is not None}

    @staticmethod
    def _apply_manual_xor(raw: bytes | None, change: dict[str, Any], *, forward: bool) -> bytes | None:
        target_exists = bool(change["existsAfter"] if forward else change["existsBefore"])
        box = change.get("box")
        if box is None: return raw if target_exists else None
        size = change.get("size"); encoded = change.get("png")
        if not (isinstance(size, list) and len(size) == 2 and all(isinstance(value, int) and value > 0 for value in size)
                and isinstance(box, list) and len(box) == 4 and all(isinstance(value, int) and value >= 0 for value in box)
                and isinstance(encoded, str)):
            raise ValueError("workspace history is invalid")
        width, height = size; left, top, box_width, box_height = box
        if left + box_width > width or top + box_height > height:
            raise ValueError("workspace history is invalid")
        if raw is None: canvas = np.zeros((height, width), dtype=np.uint8)
        else:
            with Image.open(io.BytesIO(raw)) as image:
                if image.size != (width, height):
                    raise ValueError("workspace history is invalid")
                canvas = (np.asarray(image.convert("L"), dtype=np.uint8) > 0).astype(np.uint8) * 255
        delta = WorkspaceStore._unpack_blob(encoded)
        WorkspaceStore._require_png_mask(delta)
        assert delta is not None
        with Image.open(io.BytesIO(delta)) as image: region = (np.asarray(image.convert("L"), dtype=np.uint8) > 0)
        if region.shape != (box_height, box_width):
            raise ValueError("workspace history is invalid")
        canvas[top:top + box_height, left:left + box_width] ^= region.astype(np.uint8) * 255
        if not target_exists: return None
        output = io.BytesIO(); Image.fromarray(canvas).save(output, format="PNG"); return output.getvalue()

    @staticmethod
    def _history_candidate_ids(state: dict[str, Any]) -> set[str]:
        candidates = state.get("candidates", [])
        if not isinstance(candidates, list):
            raise ValueError("workspace history is invalid")
        values = {item.get("id") for item in candidates if isinstance(item, dict)}
        if not all(isinstance(value, str) and value for value in values):
            raise ValueError("workspace history is invalid")
        return values

    @staticmethod
    def _prune_unreferenced_candidates(db: sqlite3.Connection, image_id: str) -> None:
        """Collect discarded redo-only PNGs with indexed reference checks."""
        db.execute("""DELETE FROM candidate_metadata WHERE image_id=? AND candidate_id IN (
            SELECT candidate_id FROM candidates WHERE image_id=? AND deleted=1
            AND NOT EXISTS (SELECT 1 FROM history_candidate_refs WHERE history_candidate_refs.image_id=candidates.image_id
                            AND history_candidate_refs.candidate_id=candidates.candidate_id))""", (image_id, image_id))
        db.execute("""DELETE FROM candidates WHERE image_id=? AND deleted=1
            AND NOT EXISTS (SELECT 1 FROM history_candidate_refs WHERE history_candidate_refs.image_id=candidates.image_id
                            AND history_candidate_refs.candidate_id=candidates.candidate_id)""", (image_id,))

    def begin_history_group(self) -> str:
        """Create a visible multi-image operation before its first image commits."""
        group_id = uuid.uuid4().hex
        with self._lock, self._connect() as db:
            db.execute("INSERT INTO history_groups(group_id,status,created_at) VALUES(?,?,?)", (group_id, "building", time.time_ns()))
        return group_id

    def finish_history_group(self, group_id: str, *, failed: bool = False) -> None:
        """Publish a completed batch, or leave its committed subset explicitly failed."""
        with self._lock, self._connect() as db:
            db.execute("UPDATE history_groups SET status=? WHERE group_id=? AND status='building'", ("failed" if failed else "committed", group_id))
            db.execute("DELETE FROM history_groups WHERE group_id=? AND NOT EXISTS (SELECT 1 FROM history_entries WHERE group_id=?)", (group_id, group_id))

    def _record_history_db(self, db: sqlite3.Connection, image_id: str, before: dict[str, Any], after: dict[str, Any], *, group_id: str | None = None,
                           manual_rois: dict[str, tuple[int, int, int, int]] | None = None) -> None:
        """Append history in the same transaction as the state mutation."""
        before_json = self._history_json(before); after_json = self._history_json(after)
        manual_delta = self._manual_delta(before, after, manual_rois)
        # Manual PNGs deliberately stay out of the public JSON snapshot.  A
        # brush can therefore have identical metadata while still changing a
        # layer; preserve that one durable operation via its compact delta.
        if before_json == after_json and not manual_delta:
            return
        delta_json = json.dumps({"manual": manual_delta}, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        image = db.execute("SELECT catalog_id FROM images WHERE image_id=?", (image_id,)).fetchone()
        if image is None:
            raise ValueError("workspace image is missing")
        if group_id:
            # Direct callers historically supplied a group id themselves.  Such
            # groups are complete immediately; begin_history_group is used for
            # a genuine multi-image batch.
            db.execute("INSERT OR IGNORE INTO history_groups(group_id,status,created_at) VALUES(?,?,?)", (group_id, "committed", time.time_ns()))
        cursor = db.execute("SELECT entry_id FROM history_cursors WHERE image_id=?", (image_id,)).fetchone()
        last = int(cursor["entry_id"]) if cursor and cursor["entry_id"] is not None else 0
        redo_groups = [str(row["group_id"]) for row in db.execute(
            "SELECT DISTINCT group_id FROM history_entries WHERE image_id=? AND entry_id>? AND group_id IS NOT NULL", (image_id, last)
        )]
        db.execute("DELETE FROM history_entries WHERE image_id=? AND entry_id>? AND group_id IS NULL", (image_id, last))
        prune_ids = {image_id}
        for stale_group in redo_groups:
            prune_ids.update(str(row["image_id"]) for row in db.execute("SELECT image_id FROM history_entries WHERE group_id=?", (stale_group,)))
            db.execute("DELETE FROM history_entries WHERE group_id=?", (stale_group,))
            db.execute("DELETE FROM history_groups WHERE group_id=?", (stale_group,))
        entry = db.execute("""INSERT INTO history_entries(catalog_id,image_id,group_id,before_json,after_json,delta_json,created_at)
            VALUES(?,?,?,?,?,?,?)""", (image["catalog_id"], image_id, group_id, before_json, after_json, delta_json, time.time_ns()))
        candidate_ids = self._history_candidate_ids(before) | self._history_candidate_ids(after)
        db.executemany("INSERT INTO history_candidate_refs(entry_id,image_id,candidate_id) VALUES(?,?,?)",
                       ((entry.lastrowid, image_id, candidate_id) for candidate_id in candidate_ids))
        for stale_image_id in prune_ids:
            self._prune_unreferenced_candidates(db, stale_image_id)
        db.execute("""INSERT INTO history_cursors(image_id,entry_id) VALUES(?,?)
            ON CONFLICT(image_id) DO UPDATE SET entry_id=excluded.entry_id""", (image_id, entry.lastrowid))

    def record_history(self, image_id: str, before: dict[str, Any], after: dict[str, Any], *, group_id: str | None = None) -> None:
        """Append one completed operation, dropping only this image's abandoned redo path."""
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                self._record_history_db(db, image_id, before, after, group_id=group_id)
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    @staticmethod
    def _restore_history_state(db: sqlite3.Connection, image_id: str, state: dict[str, Any], manual_delta: dict[str, Any], *, forward: bool) -> None:
        if not isinstance(state, dict) or not isinstance(state.get("candidates"), list):
            raise ValueError("workspace history is invalid")
        revision = state.get("revision")
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
            raise ValueError("workspace history is invalid")
        manual = state.get("manual")
        # Candidate PNG BLOBs are immutable operation resources.  Retain rows
        # from later detection generations and switch their metadata/deleted
        # state instead of copying every PNG into history JSON.
        db.execute("UPDATE candidates SET deleted=1 WHERE image_id=?", (image_id,))
        for candidate in state["candidates"]:
            if not isinstance(candidate, dict):
                raise ValueError("workspace history is invalid")
            required = ("id", "label", "color", "source", "origin", "role")
            if any(not isinstance(candidate.get(key), str) for key in required):
                raise ValueError("workspace history is invalid")
            existing = db.execute("SELECT 1 FROM candidates WHERE image_id=? AND candidate_id=?", (image_id, candidate["id"])).fetchone()
            if existing is None:
                raise ValueError("workspace history candidate mask is missing")
            db.execute("""UPDATE candidates SET label_token=?,confidence=?,enabled=?,color=?,source=?,origin=?,refinement=?,role=?,forced=?,deleted=?
                WHERE image_id=? AND candidate_id=?""", (candidate["label"], candidate.get("confidence"), int(bool(candidate.get("enabled"))),
                candidate["color"], candidate["source"], candidate["origin"], candidate.get("refinement"), candidate["role"],
                int(bool(candidate.get("forced"))), int(bool(candidate.get("deleted"))), image_id, candidate["id"]))
            expand_px = candidate.get("expandPx", 0)
            if isinstance(expand_px, bool) or not isinstance(expand_px, int) or expand_px < 0:
                raise ValueError("workspace history is invalid")
            db.execute("""INSERT INTO candidate_metadata(image_id,candidate_id,expand_px) VALUES(?,?,?)
                ON CONFLICT(image_id,candidate_id) DO UPDATE SET expand_px=excluded.expand_px""", (image_id, candidate["id"], expand_px))
        current = db.execute("SELECT * FROM manual_edits WHERE image_id=?", (image_id,)).fetchone()
        current_blobs = {"add": current["add_png"] if current else None, "exclusion": current["exclusion_png"] if current else None,
                         "erase": current["exclusion_erase_png"] if current else None}
        blobs = tuple(WorkspaceStore._apply_manual_xor(current_blobs[key], manual_delta[key], forward=forward)
                      if key in manual_delta else current_blobs[key] for key in ("add", "exclusion", "erase"))
        db.execute("DELETE FROM manual_edits WHERE image_id=?", (image_id,))
        if manual is not None:
            if not isinstance(manual, dict):
                raise ValueError("workspace history is invalid")
            for blob in blobs: WorkspaceStore._require_png_mask(blob)
            for key in ("removed",):
                if not isinstance(manual.get(key), str):
                    raise ValueError("workspace history is invalid")
            db.execute("""INSERT INTO manual_edits(image_id,add_png,exclusion_png,exclusion_erase_png,manual_enabled,exclusion_enabled,
                exclusion_erase_enabled,exclusion_forced,removed_candidate_ids,candidate_revision,has_effective_mask,history_json,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""", (image_id, *blobs, int(bool(manual.get("manualEnabled"))),
                int(bool(manual.get("exclusionEnabled"))), int(bool(manual.get("eraseEnabled"))), int(bool(manual.get("exclusionForced"))),
                manual["removed"], int(manual.get("revision", revision)), int(bool(manual.get("effective"))), "{}", time.time_ns()))
        flags = state.get("flags", {})
        if not isinstance(flags, dict) or not isinstance(flags.get("hidden", False), bool) or not isinstance(flags.get("reviewed", False), bool):
            raise ValueError("workspace history is invalid")
        db.execute("UPDATE images SET candidate_revision=?,hidden=?,reviewed=?,updated_at=? WHERE image_id=?", (revision, int(flags.get("hidden", False)), int(flags.get("reviewed", False)), time.time_ns(), image_id))

    def history_status(self, image_id: str) -> dict[str, bool]:
        with self._connect() as db:
            cursor = db.execute("SELECT entry_id FROM history_cursors WHERE image_id=?", (image_id,)).fetchone()
            current = int(cursor["entry_id"]) if cursor and cursor["entry_id"] is not None else 0
            undo_entry = db.execute("SELECT * FROM history_entries WHERE entry_id=? AND image_id=?", (current, image_id)).fetchone() if current else None
            redo_entry = db.execute("SELECT * FROM history_entries WHERE image_id=? AND entry_id>? ORDER BY entry_id LIMIT 1", (image_id, current)).fetchone()
            def group_ready(entry: sqlite3.Row | None, direction: str) -> bool:
                if entry is None or not entry["group_id"]: return entry is not None
                group = db.execute("SELECT status FROM history_groups WHERE group_id=?", (entry["group_id"],)).fetchone()
                if group is None or str(group["status"]) == "building":
                    return False
                members = db.execute("SELECT image_id,entry_id FROM history_entries WHERE group_id=?", (entry["group_id"],)).fetchall()
                for member in members:
                    cursor_row = db.execute("SELECT entry_id FROM history_cursors WHERE image_id=?", (member["image_id"],)).fetchone()
                    cursor_id = int(cursor_row["entry_id"]) if cursor_row and cursor_row["entry_id"] is not None else 0
                    if direction == "undo" and cursor_id != int(member["entry_id"]): return False
                    if direction == "redo":
                        previous = db.execute("SELECT entry_id FROM history_entries WHERE image_id=? AND entry_id<? ORDER BY entry_id DESC LIMIT 1", (member["image_id"], member["entry_id"])).fetchone()
                        if cursor_id != (int(previous["entry_id"]) if previous else 0):
                            return False
                return True
            can_undo = group_ready(undo_entry, "undo")
            can_redo = group_ready(redo_entry, "redo")
        return {"canUndo": can_undo, "canRedo": can_redo}

    def restore_history(self, image_id: str, direction: str) -> list[str]:
        if direction not in {"undo", "redo"}:
            raise ValueError("invalid history direction")
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
                if entry["group_id"]:
                    group = db.execute("SELECT status FROM history_groups WHERE group_id=?", (entry["group_id"],)).fetchone()
                    if group is None or str(group["status"]) == "building":
                        db.execute("COMMIT"); return []
                    for member in entries:
                        cursor_row = db.execute("SELECT entry_id FROM history_cursors WHERE image_id=?", (member["image_id"],)).fetchone()
                        cursor_id = int(cursor_row["entry_id"]) if cursor_row and cursor_row["entry_id"] is not None else 0
                        if direction == "undo":
                            expected = int(member["entry_id"])
                        else:
                            previous = db.execute("SELECT entry_id FROM history_entries WHERE image_id=? AND entry_id<? ORDER BY entry_id DESC LIMIT 1", (member["image_id"], member["entry_id"])).fetchone()
                            expected = int(previous["entry_id"]) if previous else 0
                        if cursor_id != expected:
                            db.execute("COMMIT"); return []
                changed: list[str] = []
                for member in entries:
                    state = json.loads(str(member["before_json"] if direction == "undo" else member["after_json"]))
                    try:
                        delta = json.loads(str(member["delta_json"]))
                    except (TypeError, ValueError, json.JSONDecodeError) as exc:
                        raise ValueError("workspace history is invalid") from exc
                    if not isinstance(delta, dict) or not isinstance(delta.get("manual", {}), dict):
                        raise ValueError("workspace history is invalid")
                    self._restore_history_state(db, str(member["image_id"]), state, delta.get("manual", {}), forward=direction == "redo")
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
        if set(removed) - valid_ids:
            raise ValueError("workspace removed candidates are invalid")
        try:
            history = json.loads(str(row["history_json"]))
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise ValueError("workspace history is invalid") from exc
        if not isinstance(history, dict):
            raise ValueError("workspace history is invalid")
        return {"add": encoder(masks[0]), "exclusion": encoder(masks[1]), "exclusionErase": encoder(masks[2]), "manualEnabled": bool(row["manual_enabled"]), "manualExclusionEnabled": bool(row["exclusion_enabled"]), "manualExclusionEraseEnabled": bool(row["exclusion_erase_enabled"]), "manualExclusionForced": bool(row["exclusion_forced"]), "removedCandidateIds": removed, "candidateRevision": current_revision, "hasEffectiveMask": bool(row["has_effective_mask"]), "history": history}
