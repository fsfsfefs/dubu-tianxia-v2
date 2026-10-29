import threading
from concurrent.futures import ThreadPoolExecutor
import pytest
from reader_next_api.repository import Repository


def seeded(tmp_path):
    repo = Repository(tmp_path)
    doc = repo.add_document('sample.pdf', b'%PDF-1.7\nfixture')['id']
    repo.save_ocr_page(doc, 1, 'CPU executes instructions')
    return repo, doc


def test_failed_rebuild_rolls_back_vectors_and_model_selection(tmp_path, monkeypatch):
    repo, doc = seeded(tmp_path)
    with repo.connect() as db:
        original = tuple(db.execute('SELECT embedding,embedding_model FROM rag_chunks').fetchone())
    repo.embedding_models._write({'active_id':'builtin-local-hash','models':[{'id':'test-other','engine':'fastembed','model_name':'offline-test'}]})
    monkeypatch.setattr(repo.embedding_models, '_instance', lambda model: object())
    def broken(texts):
        raise RuntimeError('embedding unavailable')
    monkeypatch.setattr(repo.embedding_models, 'embed_passages', broken)
    with pytest.raises(RuntimeError):
        repo.select_embedding_model('test-other')
    assert repo.embedding_models.active()['id'] == 'builtin-local-hash'
    with repo.connect() as db:
        assert tuple(db.execute('SELECT embedding,embedding_model FROM rag_chunks').fetchone()) == original


def test_rebuild_does_not_silently_accept_missing_vectors(tmp_path, monkeypatch):
    repo, _ = seeded(tmp_path)
    monkeypatch.setattr(repo.embedding_models, 'embed_passages', lambda texts: [])
    with pytest.raises(RuntimeError, match='条数'):
        repo.rebuild_rag_vectors()


def test_page_writes_wait_for_rebuild_and_remain_searchable(tmp_path, monkeypatch):
    repo, doc = seeded(tmp_path)
    entered, release, writer_started = threading.Event(), threading.Event(), threading.Event()
    original = repo.embedding_models.embed_passages
    def slow(texts):
        if threading.current_thread().name.startswith('rebuild'):
            entered.set(); assert release.wait(5)
        return original(texts)
    monkeypatch.setattr(repo.embedding_models, 'embed_passages', slow)
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix='rebuild') as builders, ThreadPoolExecutor(max_workers=1) as writers:
        rebuild = builders.submit(repo.rebuild_rag_vectors)
        assert entered.wait(5)
        def write():
            writer_started.set(); repo.save_ocr_page(doc, 2, 'CPU scheduling uses time slices')
        write_future = writers.submit(write)
        assert writer_started.wait(5)
        assert not write_future.done()
        release.set(); assert rebuild.result(5) == 1; write_future.result(5)
    assert any(s['page_number'] == 2 for s in repo.search_rag(doc, 'scheduling'))
