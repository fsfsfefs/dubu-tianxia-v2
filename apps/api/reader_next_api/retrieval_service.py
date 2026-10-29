"""Embedding selection/backfill workflows outside persistence implementations."""
import sqlite3
from threading import RLock



class RetrievalService:
    def __init__(self, repository, models):
        self.repository = repository
        self.models = models
        self.lock = RLock()

    def initialize(self):
        with self.lock, self.repository.connect() as connection:
            self._backfill_rag_index(connection)
            self._backfill_rag_vectors(connection)

    def _backfill_rag_index(self, connection: sqlite3.Connection) -> None:
        pages = self.repository.rag_pages_without_chunks(connection)
        for page in pages:
            self.repository._replace_rag_page(
                connection, page["document_id"], page["page_number"], page["text"]
            )


    def _backfill_rag_vectors(self, connection: sqlite3.Connection) -> None:
        active_model = self.models.active_key
        rows = self.repository.rag_vector_rows(connection, stale_model=active_model)
        vectors = self.models.embed_passages([row["content"] for row in rows])
        self.repository.write_rag_vectors(connection, rows, vectors, active_model)


    def list_embedding_models(self) -> dict:
        with self.lock:
            return self.models.list_models()


    def download_embedding_model(self, model_name: str) -> dict:
        return self.models.install_download(model_name)


    def import_embedding_model(self, name: str, model_name: str, payload: bytes) -> dict:
        return self.models.install_archive(name, model_name, payload)


    def select_embedding_model(self, model_id: str) -> dict:
        with self.lock:
            return self._select_embedding_model(model_id)

    def _select_embedding_model(self, model_id: str) -> dict:
        previous_id = self.models.active()["id"]
        model = self.models.select(model_id)
        try:
            count = self.rebuild_rag_vectors()
        except Exception:
            self.models.select(previous_id)
            raise
        return {"model": model, "reindexed_chunks": count}


    def rebuild_rag_vectors(self) -> int:
        with self.lock:
            return self._rebuild_rag_vectors()

    def _rebuild_rag_vectors(self) -> int:
        with self.repository.connect() as connection:
            rows = self.repository.rag_vector_rows(connection)
            vectors = self.models.embed_passages([row["content"] for row in rows])
            active_model = self.models.active_key
            self.repository.write_rag_vectors(connection, rows, vectors, active_model)
        return len(rows)
