import importlib
import sqlite3
import pytest
from reader_next_api.application import create_app
from reader_next_api.chapters import chapter_key
from reader_next_api.repository import Repository
from reader_next_api.runtime import Runtime, MaintenanceBusy


def test_transaction_closes_and_rolls_back(tmp_path):
    repo = Repository(tmp_path)
    with repo.connect() as connection:
        connection.execute('CREATE TABLE tx_test(value TEXT)')
    with pytest.raises(sqlite3.ProgrammingError):
        connection.execute('SELECT 1')
    with pytest.raises(ValueError):
        with repo.connect() as connection:
            connection.execute("INSERT INTO tx_test VALUES ('not committed')")
            raise ValueError('rollback')
    with repo.connect() as connection:
        assert connection.execute('SELECT COUNT(*) FROM tx_test').fetchone()[0] == 0


def test_import_and_factory_do_not_initialize_data(tmp_path, monkeypatch):
    target = tmp_path / 'not-created'
    monkeypatch.setenv('READER_NEXT_DATA', str(target))
    import reader_next_api.main as main
    importlib.reload(main)
    first, second = create_app(target), create_app(tmp_path / 'other')
    assert not target.exists()
    assert first.state.runtime is not second.state.runtime
    assert '/api/chat/stream' in first.openapi()['paths']
    assert '/api/documents/{document_id}/outline/reconcile' in first.openapi()['paths']


def test_identity_survives_insertions_and_invalidates_changed_subtree():
    old = [{'title': 'A', 'page': 2, 'depth': 0}, {'title': 'B', 'page': 5, 'depth': 0}]
    new = [{'title': 'New', 'page': 1, 'depth': 0}, *old]
    assert chapter_key('doc', old, 0) == chapter_key('doc', new, 1)
    changed = [old[0], {'title': 'Child', 'page': 3, 'depth': 1}, old[1]]
    assert chapter_key('doc', old, 0) != chapter_key('doc', changed, 0)


def test_reordered_outline_never_reuses_other_chapter_summary(tmp_path):
    repo = Repository(tmp_path)
    doc = repo.add_document('test.pdf', b'%PDF-1.7\nfixture')['id']
    old = [{'title': 'A', 'page': 2, 'depth': 0}, {'title': 'B', 'page': 5, 'depth': 0}]
    repo.import_learning_structure(doc, old, [])
    repo.save_chapter_summary(doc, f'{doc}:0', 'A', 2, 4, 0, 'Summary A')
    repo.save_summary_gap(doc, f'{doc}:0', 'A', 2, 4, 'blocked')
    new = [{'title': 'New', 'page': 1, 'depth': 0}, *old]
    repo.import_learning_structure(doc, new, [])
    records = {r['chapter_key']: r for r in repo.list_chapter_summaries(doc)}
    assert records[chapter_key(doc, new, 1)]['content'] == 'Summary A'
    assert chapter_key(doc, new, 0) not in records
    assert repo.list_summary_gaps(doc)[0]['chapter_key'] == chapter_key(doc, new, 1)


def test_incompatible_legacy_data_is_preserved_but_not_reassociated(tmp_path):
    repo = Repository(tmp_path)
    doc = repo.add_document('test.pdf', b'%PDF-1.7\nfixture')['id']
    repo.save_chapter_summary(doc, f'{doc}:0', 'A', 2, 4, 0, 'old')
    new = [{'title': 'New', 'page': 2, 'depth': 0}]
    repo.import_learning_structure(doc, new, [])
    repo.reconcile_chapter_keys(doc, new)
    records = repo.list_chapter_summaries(doc)
    assert any(r['content'] == 'old' for r in records)
    assert not any(r['chapter_key'] == chapter_key(doc, new, 0) for r in records)


def test_restore_lease_excludes_requests_and_releases_after_failure(tmp_path):
    runtime = Runtime(tmp_path, tmp_path)
    with runtime.lease():
        with pytest.raises(MaintenanceBusy):
            with runtime.lease(exclusive=True):
                pass
    with pytest.raises(ValueError):
        with runtime.lease(exclusive=True):
            with pytest.raises(MaintenanceBusy):
                with runtime.lease():
                    pass
            raise ValueError('restore failed')
    with runtime.lease():
        pass


def test_shared_chapter_identity_fixtures():
    import json
    from pathlib import Path
    fixtures = json.loads((Path(__file__).resolve().parents[3] / "tests/fixtures/chapters.json").read_text(encoding="utf-8"))
    for item in fixtures:
        assert chapter_key(item["document_id"], item["outline"], item["index"]) == item["expected"]


def test_all_first_edition_http_routes_are_preserved(tmp_path):
    import json
    from pathlib import Path
    contract = json.loads((Path(__file__).resolve().parents[3] / "tests/fixtures/api-v1-contract.json").read_text())
    paths = create_app(tmp_path / "unstarted").openapi()["paths"]
    for item in contract:
        assert item["method"] in paths[item["path"]], item
