from __future__ import annotations

import math
import re
import hashlib
from array import array
from collections import Counter


WHITESPACE = re.compile(r"\s+")
ENGLISH_TERM = re.compile(r"[a-zA-Z][a-zA-Z0-9_.+-]{1,}")
CHINESE_RUN = re.compile(r"[\u3400-\u9fff]{2,}")
SEMANTIC_VECTOR_SIZE = 384
SEMANTIC_MODEL = "local-semantic-hash-v1"

# Compact, dependency-free concept normalization. These aliases improve the
# common abbreviation/synonym cases in technical textbooks while character
# n-grams keep the embedder useful for arbitrary Chinese and English books.
SEMANTIC_ALIASES = (
    ("cpu", "processor", "central processing unit", "中央处理器", "处理器"),
    ("os", "operating system", "操作系统"),
    ("ram", "memory", "main memory", "内存", "主存", "存储器"),
    ("virtual memory", "虚拟内存", "虚存"),
    ("process", "进程", "任务"),
    ("thread", "线程", "轻量级进程"),
    ("schedule", "scheduling", "scheduler", "调度", "任务调度"),
    ("deadlock", "死锁"),
    ("cache", "缓存", "高速缓存"),
    ("database", "db", "数据库"),
    ("network", "computer network", "网络", "计算机网络"),
    ("vector", "embedding", "向量", "嵌入"),
    ("artificial intelligence", "ai", "人工智能"),
    ("machine learning", "ml", "机器学习"),
)


def _semantic_aliases(value: str) -> list[str]:
    folded = normalize_text(value).casefold()
    matched: list[str] = []
    for index, group in enumerate(SEMANTIC_ALIASES):
        if any(alias in folded for alias in group):
            matched.append(f"concept:{index}")
    return matched


def semantic_features(value: str) -> Counter[str]:
    """Create local multilingual features without downloading an ML model."""
    folded = normalize_text(value).casefold()
    features: Counter[str] = Counter()
    for word in ENGLISH_TERM.findall(folded):
        features[f"en:{word}"] += 2
        if len(word) >= 5:
            for index in range(len(word) - 2):
                features[f"engram:{word[index:index + 3]}"] += 1
    for run in CHINESE_RUN.findall(folded):
        for size, weight in ((1, 1), (2, 3), (3, 2)):
            for index in range(len(run) - size + 1):
                features[f"zh{size}:{run[index:index + size]}"] += weight
    for alias in _semantic_aliases(folded):
        features[alias] += 8
    return features


def semantic_embedding(value: str, *, size: int = SEMANTIC_VECTOR_SIZE) -> list[float]:
    """Return a deterministic, normalized local vector suitable for SQLite."""
    vector = [0.0] * size
    for feature, count in semantic_features(value).items():
        digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
        bucket = int.from_bytes(digest[:4], "little") % size
        sign = 1.0 if digest[4] & 1 else -1.0
        vector[bucket] += sign * math.log1p(count)
    length = math.sqrt(sum(value * value for value in vector))
    return [value / length for value in vector] if length else vector


def pack_embedding(vector: list[float]) -> bytes:
    return array("f", vector).tobytes()


def unpack_embedding(payload: bytes | None) -> list[float]:
    if not payload:
        return []
    values = array("f")
    values.frombytes(payload)
    return list(values)


def cosine_similarity(left: list[float], right: list[float]) -> float:
    if not left or len(left) != len(right):
        return 0.0
    # External embedding runtimes commonly return numpy.float32 values. The
    # arithmetic result then remains a numpy scalar, which json.dumps cannot
    # serialize when retrieval sources are emitted over SSE. Normalize the
    # public boundary to a native Python float.
    return float(max(0.0, sum(a * b for a, b in zip(left, right))))


def normalize_text(value: str) -> str:
    return WHITESPACE.sub(" ", value).strip()


def chunk_page_text(text: str, *, chunk_size: int = 900, overlap: int = 140) -> list[str]:
    """Split one PDF page into stable, overlapping chunks for retrieval."""
    clean = normalize_text(text)
    if not clean:
        return []
    if len(clean) <= chunk_size:
        return [clean]

    chunks: list[str] = []
    start = 0
    while start < len(clean):
        hard_end = min(len(clean), start + chunk_size)
        end = hard_end
        if hard_end < len(clean):
            boundary = max(
                clean.rfind("。", start + chunk_size // 2, hard_end),
                clean.rfind("！", start + chunk_size // 2, hard_end),
                clean.rfind("？", start + chunk_size // 2, hard_end),
                clean.rfind("；", start + chunk_size // 2, hard_end),
                clean.rfind(". ", start + chunk_size // 2, hard_end),
            )
            if boundary > start:
                end = boundary + 1
        chunk = clean[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(clean):
            break
        start = max(start + 1, end - overlap)
    return chunks


def query_terms(question: str, *, limit: int = 24) -> list[str]:
    """Create FTS-friendly English words and Chinese trigrams/four-grams."""
    terms: list[str] = []
    seen: set[str] = set()

    def add(term: str) -> None:
        normalized = term.casefold().strip()
        if len(normalized) < 2 or normalized in seen:
            return
        seen.add(normalized)
        terms.append(normalized)

    for word in ENGLISH_TERM.findall(question):
        add(word)
    for run in CHINESE_RUN.findall(question):
        if len(run) <= 6:
            add(run)
        for size in (4, 3):
            if len(run) < size:
                continue
            for index in range(0, len(run) - size + 1, 2 if size == 3 else 3):
                add(run[index:index + size])
    return terms[:limit]


def lexical_score(question: str, content: str) -> float:
    """A deterministic fallback/reranker that works for Chinese and English."""
    normalized_content = normalize_text(content).casefold()
    terms = query_terms(question, limit=48)
    if not terms or not normalized_content:
        return 0.0
    counts = Counter(term for term in terms if term in normalized_content)
    score = sum((len(term) ** 1.6) * count for term, count in counts.items())
    coverage = len(counts) / max(1, len(terms))
    return score * (1.0 + math.sqrt(coverage))


def fts_query(question: str) -> str:
    terms = query_terms(question)
    return " OR ".join(f'"{term.replace(chr(34), chr(34) * 2)}"' for term in terms)


def format_rag_context(sources: list[dict]) -> str:
    if not sources:
        return "全文索引中没有检索到足以回答问题的原文片段。"
    return "\n\n".join(
        f"【原文片段 {index}｜{source.get('document_title', '当前教材')}｜PDF 第 {source['page_number']} 页】\n"
        f"{source['content']}"
        for index, source in enumerate(sources, 1)
    )
