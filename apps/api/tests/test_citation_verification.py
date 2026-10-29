from reader_next_api.citation_verification import extract_claims, local_verification, merge_ai_checks


SOURCES = [
    {"page_number": 12, "content": "时间片轮转调度算法为每个就绪进程分配固定时间片，提高交互响应能力。"},
    {"page_number": 27, "content": "虚拟内存使用页面置换算法，在物理内存不足时换出部分页面。"},
]


def test_extracts_pdf_page_citations_and_uncited_claims():
    claims = extract_claims("时间片轮转提高响应速度。[PDF第12页]\n没有引用的另一个完整结论。")

    assert claims[0]["pages"] == [12]
    assert claims[1]["pages"] == []


def test_verifies_book_aware_citations_without_cross_book_page_collision():
    answer = "时间片轮转改善交互响应。[操作系统｜PDF第12页]"
    sources = [
        {"document_id": "os", "document_title": "操作系统", "page_number": 12, "content": "时间片轮转可以改善交互任务响应。"},
        {"document_id": "net", "document_title": "计算机网络", "page_number": 12, "content": "本页讨论网络拓扑。"},
    ]

    result = local_verification(answer, sources)

    assert result["checks"][0]["status"] in {"supported", "partial"}
    assert result["checks"][0]["origins"] == [{
        "document_id": "os", "document_title": "操作系统", "page_number": 12,
    }]


def test_local_verification_flags_supported_missing_and_unknown_pages():
    result = local_verification(
        "时间片轮转调度算法提高交互响应能力。[PDF第12页]\n"
        "页面置换用于虚拟内存。[PDF第99页]\n"
        "这是一个没有引用页码的完整结论。",
        SOURCES,
    )

    assert result["checks"][0]["status"] == "supported"
    assert result["checks"][1]["status"] == "unsupported"
    assert result["checks"][2]["status"] == "missing"


def test_ai_verification_merges_auditor_result():
    baseline = local_verification(
        "时间片轮转调度算法提高交互响应能力。[PDF第12页]",
        SOURCES,
    )
    result = merge_ai_checks(baseline, {
        "checks": [{"index": 1, "status": "partial", "reason": "原文支持概念，但未明确比较效果。"}]
    })

    assert result["method"] == "ai"
    assert result["checks"][0]["status"] == "partial"
    assert "未明确" in result["checks"][0]["reason"]
