"""Chapter identity shared with web chapters.ts; independent of list positions."""
import json


def chapter_key(document_id, outline, index):
    node = outline[index]
    boundary = next((j for j in range(index + 1, len(outline)) if outline[j]["depth"] <= node["depth"]), len(outline))
    ancestors = []
    depth = node["depth"]
    for item in reversed(outline[:index]):
        if item["depth"] < depth:
            ancestors.insert(0, item["title"])
            depth = item["depth"]
    scope = [[n["title"], n["page"], n["depth"]] for n in outline[index:boundary]]
    identity = json.dumps([ancestors, scope, outline[boundary]["page"] if boundary < len(outline) else None], ensure_ascii=False, separators=(",", ":"))
    digest = 14695981039346656037
    for byte in identity.encode("utf-8"):
        digest = ((digest ^ byte) * 1099511628211) & ((1 << 64) - 1)
    return f"{document_id}:ch-{digest:016x}"
