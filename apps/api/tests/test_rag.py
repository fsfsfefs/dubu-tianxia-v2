import json

import numpy as np

from reader_next_api.rag import (
    SEMANTIC_MODEL,
    chunk_page_text,
    cosine_similarity,
    format_rag_context,
    pack_embedding,
    query_terms,
    semantic_embedding,
    unpack_embedding,
)
from reader_next_api.repository import Repository


def test_page_text_is_split_with_overlap():
    text = "第一节介绍进程调度。" * 160
    chunks = chunk_page_text(text, chunk_size=180, overlap=30)

    assert len(chunks) > 2
    assert all(len(chunk) <= 180 for chunk in chunks)
    assert chunks[0][-20:] in chunks[1]


def test_query_terms_support_chinese_and_english():
    terms = query_terms("虚拟内存中的 page replacement algorithm 是什么？")

    assert any("虚拟" in term or "内存" in term for term in terms)
    assert "page" in terms
    assert "replacement" in terms


def test_local_semantic_embedding_is_stable_and_serializable():
    vector = semantic_embedding("中央处理器负责执行指令")
    restored = unpack_embedding(pack_embedding(vector))

    assert len(vector) == 384
    assert cosine_similarity(vector, restored) > 0.999


def test_similarity_from_float32_embeddings_is_json_serializable():
    score = cosine_similarity(
        [np.float32(1.0), np.float32(0.0)],
        [np.float32(1.0), np.float32(0.0)],
    )

    assert type(score) is float
    assert json.loads(json.dumps({"score": score})) == {"score": 1.0}


def test_repository_retrieves_relevant_pdf_pages(tmp_path):
    repository = Repository(tmp_path)
    document = repository.add_document("os.pdf", b"%PDF-1.7\nfixture")
    repository.save_ocr_page(document["id"], 12, "进程调度使用时间片轮转算法提高系统响应速度。")
    repository.save_ocr_page(document["id"], 27, "虚拟内存通过页面置换算法管理有限的物理内存。")
    repository.save_ocr_page(document["id"], 40, "文件系统负责目录和磁盘空间管理。")

    sources = repository.search_rag(document["id"], "虚拟内存的页面置换是什么", 3)
    status = repository.rag_status(document["id"])

    assert sources
    assert sources[0]["page_number"] == 27
    assert "页面置换" in sources[0]["content"]
    assert status["indexed_pages"] == 3
    assert status["chunk_count"] == 3
    assert SEMANTIC_MODEL in status["engine"]
    assert "PDF 第 27 页" in format_rag_context(sources)


def test_repository_semantically_matches_local_aliases(tmp_path):
    repository = Repository(tmp_path)
    document = repository.add_document("architecture.pdf", b"%PDF-1.7\nfixture")
    repository.save_ocr_page(document["id"], 4, "中央处理器负责取指、译码并执行机器指令。")
    repository.save_ocr_page(document["id"], 9, "文件系统组织目录和磁盘中的数据。")

    sources = repository.search_rag(document["id"], "CPU 的主要作用是什么", 2)

    assert sources
    assert sources[0]["page_number"] == 4
    assert sources[0]["semantic_score"] > 0
    assert sources[0]["retrieval"] in {"semantic", "hybrid"}


def test_updating_ocr_page_replaces_old_rag_content(tmp_path):
    repository = Repository(tmp_path)
    document = repository.add_document("os.pdf", b"%PDF-1.7\nfixture")
    repository.save_ocr_page(document["id"], 8, "旧内容讨论死锁。")
    repository.save_ocr_page(document["id"], 8, "新内容讨论银行家算法与安全状态。")

    assert repository.search_rag(document["id"], "银行家算法", 2)[0]["page_number"] == 8
    assert repository.search_rag(document["id"], "死锁", 2) == []


def test_repository_searches_multiple_books_with_book_origins(tmp_path):
    repository = Repository(tmp_path)
    os_book = repository.add_document("操作系统.pdf", b"%PDF-1.7\nos")
    network_book = repository.add_document("计算机网络.pdf", b"%PDF-1.7\nnetwork")
    repository.save_ocr_page(os_book["id"], 12, "进程调度使用时间片轮转改善交互响应。")
    repository.save_ocr_page(network_book["id"], 28, "网络分组调度使用公平队列改善不同流的响应。")

    sources = repository.search_rag_many(
        [os_book["id"], network_book["id"]], "调度", 8
    )
    status = repository.rag_status_many([os_book["id"], network_book["id"]])

    assert {item["document_title"] for item in sources} == {"操作系统", "计算机网络"}
    assert all(item["document_id"] for item in sources)
    assert status["document_count"] == 2
    assert status["indexed_pages"] == 2
    context = format_rag_context(sources)
    assert "操作系统｜PDF 第 12 页" in context
    assert "计算机网络｜PDF 第 28 页" in context


def test_embedding_model_catalog_and_builtin_reindex(tmp_path):
    repository = Repository(tmp_path)
    document = repository.add_document("os.pdf", b"%PDF-1.7\nfixture")
    repository.save_ocr_page(document["id"], 3, "process scheduling")

    catalog = repository.list_embedding_models()
    result = repository.select_embedding_model("builtin-local-hash")

    assert catalog["active_id"] == "builtin-local-hash"
    assert catalog["models"][0]["engine"] == "builtin"
    assert len(catalog["presets"]) == 2
    assert result["reindexed_chunks"] == 1
