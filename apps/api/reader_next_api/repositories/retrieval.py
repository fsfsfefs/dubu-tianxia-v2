from __future__ import annotations

import sqlite3

from ..rag import chunk_page_text, cosine_similarity, fts_query, lexical_score, pack_embedding, semantic_features, unpack_embedding


class RetrievalRepository:
    def _initialize_rag_index(self, connection: sqlite3.Connection) -> None:
        try:
            connection.execute(
                """CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5(
                     chunk_id UNINDEXED, document_id UNINDEXED, page_number UNINDEXED,
                     content, tokenize='trigram'
                   )"""
            )
            self.rag_fts_available = True
        except sqlite3.OperationalError:
            self.rag_fts_available = False


    def _backfill_rag_index(self, connection: sqlite3.Connection) -> None:
        pages = connection.execute(
            """SELECT page.document_id, page.page_number, page.text
               FROM ocr_pages page
               WHERE NOT EXISTS (
                 SELECT 1 FROM rag_chunks chunk
                 WHERE chunk.document_id = page.document_id
                   AND chunk.page_number = page.page_number
               )"""
        ).fetchall()
        for page in pages:
            self._replace_rag_page(
                connection, page["document_id"], page["page_number"], page["text"]
            )


    def _backfill_rag_vectors(self, connection: sqlite3.Connection) -> None:
        active_model = self.embedding_models.active_key
        rows = connection.execute(
            """SELECT id, content FROM rag_chunks
               WHERE embedding IS NULL OR embedding_model IS NULL OR embedding_model != ?""",
            (active_model,),
        ).fetchall()
        vectors = self.embedding_models.embed_passages([row["content"] for row in rows])
        for row, vector in zip(rows, vectors):
            connection.execute(
                "UPDATE rag_chunks SET embedding = ?, embedding_model = ? WHERE id = ?",
                (pack_embedding(vector), active_model, row["id"]),
            )


    def _replace_rag_page(
        self, connection: sqlite3.Connection, document_id: str, page_number: int, text: str
    ) -> None:
        connection.execute(
            "DELETE FROM rag_chunks WHERE document_id = ? AND page_number = ?",
            (document_id, page_number),
        )
        if self.rag_fts_available:
            connection.execute(
                "DELETE FROM rag_chunks_fts WHERE document_id = ? AND page_number = ?",
                (document_id, page_number),
            )
        contents = chunk_page_text(text)
        vectors = self.embedding_models.embed_passages(contents)
        for chunk_index, (content, vector) in enumerate(zip(contents, vectors)):
            chunk_id = f"{document_id}:{page_number}:{chunk_index}"
            embedding = pack_embedding(vector)
            connection.execute(
                """INSERT INTO rag_chunks(
                     id,document_id,page_number,chunk_index,content,embedding,embedding_model
                   ) VALUES (?,?,?,?,?,?,?)""",
                (chunk_id, document_id, page_number, chunk_index, content, embedding, self.embedding_models.active_key),
            )
            if self.rag_fts_available:
                connection.execute(
                    """INSERT INTO rag_chunks_fts(chunk_id,document_id,page_number,content)
                       VALUES (?,?,?,?)""",
                    (chunk_id, document_id, page_number, content),
                )


    def rag_status(self, document_id: str) -> dict:
        self.document_path(document_id)
        with self.connect() as connection:
            indexed_pages = connection.execute(
                "SELECT COUNT(*) FROM ocr_pages WHERE document_id = ?",
                (document_id,),
            ).fetchone()[0]
            chunk_count = connection.execute(
                "SELECT COUNT(*) FROM rag_chunks WHERE document_id = ?",
                (document_id,),
            ).fetchone()[0]
        return {
            "indexed_pages": int(indexed_pages),
            "chunk_count": int(chunk_count),
            "engine": f"sqlite-fts5+{self.embedding_models.active_key}" if self.rag_fts_available else self.embedding_models.active_key,
        }


    def list_embedding_models(self) -> dict:
        return self.embedding_models.list_models()


    def download_embedding_model(self, model_name: str) -> dict:
        return self.embedding_models.install_download(model_name)


    def import_embedding_model(self, name: str, model_name: str, payload: bytes) -> dict:
        return self.embedding_models.install_archive(name, model_name, payload)


    def select_embedding_model(self, model_id: str) -> dict:
        previous_id = self.embedding_models.active()["id"]
        model = self.embedding_models.select(model_id)
        try:
            count = self.rebuild_rag_vectors()
        except Exception:
            self.embedding_models.select(previous_id)
            raise
        return {"model": model, "reindexed_chunks": count}


    def rebuild_rag_vectors(self) -> int:
        with self.connect() as connection:
            rows = connection.execute("SELECT id, content FROM rag_chunks ORDER BY document_id,page_number,chunk_index").fetchall()
            vectors = self.embedding_models.embed_passages([row["content"] for row in rows])
            active_model = self.embedding_models.active_key
            for row, vector in zip(rows, vectors):
                connection.execute(
                    "UPDATE rag_chunks SET embedding = ?, embedding_model = ? WHERE id = ?",
                    (pack_embedding(vector), active_model, row["id"]),
                )
        return len(rows)


    def search_rag(self, document_id: str, question: str, limit: int = 8) -> list[dict]:
        self.document_path(document_id)
        query = fts_query(question)
        lexical_candidates: dict[str, dict] = {}
        all_candidates: dict[str, dict] = {}
        with self.connect() as connection:
            if self.rag_fts_available and query:
                try:
                    rows = connection.execute(
                        """SELECT chunk_id AS id, CAST(page_number AS INTEGER) AS page_number,
                                  content, bm25(rag_chunks_fts) AS fts_rank
                           FROM rag_chunks_fts
                           WHERE rag_chunks_fts MATCH ? AND document_id = ?
                           ORDER BY fts_rank LIMIT ?""",
                        (query, document_id, max(limit * 6, 24)),
                    ).fetchall()
                    lexical_candidates.update({row["id"]: dict(row) for row in rows})
                except sqlite3.OperationalError:
                    pass
            rows = connection.execute(
                """SELECT id, page_number, content, embedding
                   FROM rag_chunks WHERE document_id = ?""",
                (document_id,),
            ).fetchall()
            all_candidates = {row["id"]: dict(row) for row in rows}

        # Rank both channels independently, then fuse their ranks. This avoids
        # mixing incomparable BM25 and cosine score scales.
        lexical_ranked: list[tuple[str, float]] = []
        lexical_pool = lexical_candidates or all_candidates
        for chunk_id, candidate in lexical_pool.items():
            score = lexical_score(question, candidate["content"])
            if score > 0:
                fts_rank = float(candidate.get("fts_rank") or 0.0)
                lexical_ranked.append((chunk_id, score + max(0.0, -fts_rank)))
        lexical_ranked.sort(key=lambda item: -item[1])

        query_vector = self.embedding_models.embed_query(question)
        query_features = set(semantic_features(question)) if self.embedding_models.uses_builtin else set()
        semantic_ranked = []
        for chunk_id, candidate in all_candidates.items():
            # Feature overlap removes accidental hash collisions; normalized
            # aliases allow genuine synonym matches without exact words.
            if query_features and not query_features.intersection(semantic_features(candidate["content"])):
                continue
            score = cosine_similarity(query_vector, unpack_embedding(candidate.get("embedding")))
            if score > 0:
                semantic_ranked.append((chunk_id, score))
        semantic_ranked.sort(key=lambda item: -item[1])
        semantic_ranked = semantic_ranked[:max(limit * 8, 32)]

        fused: dict[str, float] = {}
        details: dict[str, dict[str, float]] = {}
        for rank, (chunk_id, score) in enumerate(lexical_ranked[:max(limit * 8, 32)], 1):
            fused[chunk_id] = fused.get(chunk_id, 0.0) + 1.0 / (60 + rank)
            details.setdefault(chunk_id, {})["lexical"] = score
        for rank, (chunk_id, score) in enumerate(semantic_ranked, 1):
            fused[chunk_id] = fused.get(chunk_id, 0.0) + 1.15 / (60 + rank)
            details.setdefault(chunk_id, {})["semantic"] = score

        ranked = []
        for chunk_id, fusion_score in fused.items():
            candidate = all_candidates.get(chunk_id) or lexical_candidates.get(chunk_id)
            if not candidate:
                continue
            channel = details.get(chunk_id, {})
            ranked.append({
                "page_number": int(candidate["page_number"]),
                "content": candidate["content"],
                "score": round(fusion_score * 1000, 4),
                "lexical_score": round(channel.get("lexical", 0.0), 4),
                "semantic_score": round(channel.get("semantic", 0.0), 4),
                "retrieval": "hybrid" if len(channel) > 1 else ("semantic" if "semantic" in channel else "lexical"),
            })
        ranked.sort(key=lambda item: (-item["score"], -item["semantic_score"], item["page_number"]))

        selected: list[dict] = []
        per_page: dict[int, int] = {}
        for item in ranked:
            page = item["page_number"]
            if per_page.get(page, 0) >= 2:
                continue
            selected.append(item)
            per_page[page] = per_page.get(page, 0) + 1
            if len(selected) >= limit:
                break
        return selected


    def search_rag_many(self, document_ids: list[str], question: str, limit: int = 16) -> list[dict]:
        """Search several books while retaining book identity for every citation."""
        unique_ids = list(dict.fromkeys(document_ids))[:12]
        if not unique_ids:
            return []
        documents = {item["id"]: item for item in self.list_documents()}
        missing = [document_id for document_id in unique_ids if document_id not in documents]
        if missing:
            raise LookupError("教材不存在。")

        per_book_limit = max(2, min(6, (limit + len(unique_ids) - 1) // len(unique_ids) + 1))
        candidates: list[dict] = []
        for document_id in unique_ids:
            for source in self.search_rag(document_id, question, per_book_limit):
                candidates.append({
                    **source,
                    "document_id": document_id,
                    "document_title": documents[document_id]["title"],
                })

        candidates.sort(key=lambda item: (-item["score"], item["document_title"], item["page_number"]))
        selected: list[dict] = []
        for document_id in unique_ids:
            first = next((item for item in candidates if item["document_id"] == document_id), None)
            if first and first not in selected:
                selected.append(first)
        for item in candidates:
            if item not in selected:
                selected.append(item)
            if len(selected) >= limit:
                break
        return selected[:limit]


    def rag_status_many(self, document_ids: list[str]) -> dict:
        unique_ids = list(dict.fromkeys(document_ids))[:12]
        documents = {item["id"]: item for item in self.list_documents()}
        statuses = []
        for document_id in unique_ids:
            if document_id not in documents:
                raise LookupError("教材不存在。")
            statuses.append({
                "document_id": document_id,
                "document_title": documents[document_id]["title"],
                **self.rag_status(document_id),
            })
        return {
            "indexed_pages": sum(item["indexed_pages"] for item in statuses),
            "chunk_count": sum(item["chunk_count"] for item in statuses),
            "engine": statuses[0]["engine"] if statuses else "local-lexical",
            "document_count": len(statuses),
            "documents": statuses,
        }
