from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


FORMAT = "reader-next-full-backup"
VERSION = 1
MAX_ARCHIVE_BYTES = 12 * 1024 * 1024 * 1024
MAX_EXPANDED_BYTES = 24 * 1024 * 1024 * 1024
MAX_FILES = 100_000


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _snapshot_database(database_path: Path, target: Path) -> None:
    source = sqlite3.connect(database_path)
    destination = sqlite3.connect(target)
    try:
        source.backup(destination)
    finally:
        destination.close()
        source.close()


def _collect_files(root: Path, relative_root: str) -> list[tuple[Path, str]]:
    if not root.exists():
        return []
    return [
        (path, f"{relative_root}/{path.relative_to(root).as_posix()}")
        for path in root.rglob("*")
        if path.is_file()
    ]


def create_full_backup(data_root: Path, destination: Path) -> dict:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=data_root) as temporary:
        snapshot = Path(temporary) / "reader.db"
        _snapshot_database(data_root / "reader.db", snapshot)
        files: list[tuple[Path, str]] = [(snapshot, "database/reader.db")]
        files.extend(_collect_files(data_root / "documents", "documents"))
        files.extend(_collect_files(data_root / "embedding-models", "embedding-models"))
        embedding_config = data_root / "embedding-models.json"
        if embedding_config.exists():
            files.append((embedding_config, "embedding-models.json"))

        manifest_files = [
            {"path": archive_name, "size": source.stat().st_size, "sha256": _sha256(source)}
            for source, archive_name in files
        ]
        manifest = {
            "format": FORMAT,
            "version": VERSION,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "credentials_included": False,
            "files": manifest_files,
        }
        temporary_archive = destination.with_suffix(destination.suffix + ".tmp")
        with zipfile.ZipFile(temporary_archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
            for source, archive_name in files:
                archive.write(source, archive_name)
        temporary_archive.replace(destination)
    return {
        "path": destination,
        "file_count": len(files),
        "byte_size": destination.stat().st_size,
        "created_at": manifest["created_at"],
    }


def inspect_backup(archive_path: Path, staging_root: Path) -> dict:
    if archive_path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("备份文件超过 12GB 安全限制。")
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_FILES:
            raise ValueError("备份内文件数量异常。")
        total_size = sum(entry.file_size for entry in entries)
        if total_size > MAX_EXPANDED_BYTES:
            raise ValueError("备份解压后超过 24GB 安全限制。")
        names = {entry.filename for entry in entries}
        if "manifest.json" not in names or "database/reader.db" not in names:
            raise ValueError("不是有效的 Reader Next 完整备份。")
        for entry in entries:
            path = Path(entry.filename)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError("备份包含不安全路径。")
        try:
            manifest = json.loads(archive.read("manifest.json"))
        except (KeyError, ValueError, UnicodeDecodeError) as error:
            raise ValueError("备份清单损坏。") from error
        if manifest.get("format") != FORMAT or manifest.get("version") != VERSION:
            raise ValueError("备份格式或版本不受支持。")

        staging_root.mkdir(parents=True, exist_ok=False)
        archive.extractall(staging_root)

    listed = manifest.get("files")
    if not isinstance(listed, list):
        raise ValueError("备份清单缺少文件校验信息。")
    for item in listed:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise ValueError("备份文件清单无效。")
        target = staging_root / item["path"]
        if not target.is_file() or target.stat().st_size != item.get("size") or _sha256(target) != item.get("sha256"):
            raise ValueError(f"备份文件校验失败：{item.get('path', '未知文件')}")
    return manifest


def install_full_backup(data_root: Path, staging_root: Path) -> dict:
    staged_database = staging_root / "database" / "reader.db"
    staged_documents = staging_root / "documents"
    staged_models = staging_root / "embedding-models"
    staged_model_config = staging_root / "embedding-models.json"
    token = uuid4().hex
    rollback_root = data_root / f".restore-rollback-{token}"
    rollback_root.mkdir(parents=True)
    database_path = data_root / "reader.db"
    rollback_database = rollback_root / "reader.db"
    if database_path.exists():
        _snapshot_database(database_path, rollback_database)

    targets = {
        "documents": data_root / "documents",
        "embedding-models": data_root / "embedding-models",
        "embedding-models.json": data_root / "embedding-models.json",
    }
    moved: list[str] = []
    try:
        for name, target in targets.items():
            if target.exists():
                os.replace(target, rollback_root / name)
                moved.append(name)

        shutil.copytree(staged_documents, targets["documents"]) if staged_documents.exists() else targets["documents"].mkdir()
        shutil.copytree(staged_models, targets["embedding-models"]) if staged_models.exists() else targets["embedding-models"].mkdir()
        if staged_model_config.exists():
            shutil.copy2(staged_model_config, targets["embedding-models.json"])
        else:
            targets["embedding-models.json"].write_text(
                '{"active_id":"builtin-local-hash","models":[]}', encoding="utf-8"
            )

        source = sqlite3.connect(staged_database)
        destination = sqlite3.connect(database_path)
        try:
            source.backup(destination)
        finally:
            destination.close()
            source.close()
    except Exception:
        if rollback_database.exists():
            rollback = sqlite3.connect(rollback_database)
            destination = sqlite3.connect(database_path)
            try:
                rollback.backup(destination)
            finally:
                destination.close()
                rollback.close()
        for name, target in targets.items():
            if target.is_dir():
                shutil.rmtree(target, ignore_errors=True)
            elif target.exists():
                target.unlink(missing_ok=True)
            rollback = rollback_root / name
            if name in moved and rollback.exists():
                os.replace(rollback, target)
        raise
    shutil.rmtree(rollback_root, ignore_errors=True)

    connection = sqlite3.connect(database_path)
    try:
        counts = {
            table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("documents", "notes", "highlights", "flashcards", "ocr_pages", "rag_chunks")
        }
    finally:
        connection.close()
    return counts

