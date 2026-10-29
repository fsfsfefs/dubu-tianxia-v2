import sqlite3
from concurrent.futures import ThreadPoolExecutor
import pytest
from reader_next_api.repository import Repository
from reader_next_api.migrations import migrate, MIGRATIONS


def test_legacy_database_upgrade_preserves_records_and_is_idempotent(tmp_path):
    root = tmp_path / 'legacy'; root.mkdir()
    with sqlite3.connect(root / 'reader.db') as db:
        db.executescript("""CREATE TABLE documents(id TEXT PRIMARY KEY,title TEXT,filename TEXT,sha256 TEXT,byte_size INTEGER,created_at TEXT);
        CREATE TABLE notes(id TEXT PRIMARY KEY,document_id TEXT,page_number INTEGER,excerpt TEXT,content TEXT,created_at TEXT);
        INSERT INTO documents VALUES('old','title','old.pdf','hash',10,'yesterday');
        INSERT INTO notes VALUES('note','old',2,'source','kept','yesterday');""")
    first = Repository(root)
    assert first.list_notes('old')[0]['content'] == 'kept'
    with first.connect() as db:
        before = list(map(tuple, db.execute('SELECT * FROM schema_migrations ORDER BY version')))
    second = Repository(root)
    with second.connect() as db:
        assert list(map(tuple, db.execute('SELECT * FROM schema_migrations ORDER BY version'))) == before
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert {r[0] for r in before} == {1, 2}


def test_failed_migration_rolls_back_ddl_and_version(tmp_path):
    db = sqlite3.connect(tmp_path / 'fail.db')
    def broken(connection):
        connection.execute('CREATE TABLE should_rollback(value TEXT)')
        raise ValueError('fail')
    with pytest.raises(ValueError), db:
        migrate(db, (*MIGRATIONS, (3, 'broken', broken)))
    assert db.execute("SELECT name FROM sqlite_master WHERE name IN ('should_rollback','schema_migrations')").fetchall() == []
    db.close()


def test_future_and_gapped_schema_versions_are_rejected(tmp_path):
    repo = Repository(tmp_path)
    for bad in (9, 2):
        with repo.connect() as db:
            db.execute('DELETE FROM schema_migrations')
            db.execute("INSERT INTO schema_migrations(version,name) VALUES (?, 'invalid')", (bad,))
        with pytest.raises(RuntimeError), repo.connect() as db:
            migrate(db)


def test_concurrent_starts_apply_each_migration_once(tmp_path):
    # Test the migration runner independently of optional model config initialization.
    def start(_):
        with sqlite3.connect(tmp_path / 'shared.db', timeout=15) as db:
            db.row_factory = sqlite3.Row
            migrate(db)
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(start, range(24)))
    with sqlite3.connect(tmp_path / 'shared.db') as db:
        assert db.execute('SELECT count(*) FROM schema_migrations').fetchone()[0] == 2
