"""File constraints shared by chapter draft upload and backup import."""
from io import BytesIO
from zipfile import BadZipFile, ZipFile

MAX_DRAFT_BYTES = 20 * 1024 * 1024
DRAFT_TYPES = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "md": "text/plain; charset=utf-8",
    "txt": "text/plain; charset=utf-8",
}


def validate_draft(kind, data):
    if kind not in DRAFT_TYPES:
        raise ValueError("请选择 PDF、Word（.docx）、Markdown 或 TXT。")
    if not data or len(data) > MAX_DRAFT_BYTES:
        raise ValueError("请选择非空文件，单份不超过 20 MB。")
    if kind == "pdf" and not data.startswith(b"%PDF-"):
        raise ValueError("PDF 文件无效。")
    if kind == "docx":
        try:
            with ZipFile(BytesIO(data)) as archive:
                if not {"[Content_Types].xml", "word/document.xml"}.issubset(archive.namelist()):
                    raise ValueError("Word 文件无效。")
                if sum(entry.file_size for entry in archive.infolist()) > 100 * 1024 * 1024:
                    raise ValueError("Word 文件展开后超过 100 MB。")
        except BadZipFile as error:
            raise ValueError("Word 文件无效。") from error
    if kind in {"md", "txt"}:
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise ValueError("请使用 UTF-8 编码的文本文件。") from error
        if not text.strip() or len(text) > 300_000:
            raise ValueError("文本须有内容，且最多 30 万字符。")
