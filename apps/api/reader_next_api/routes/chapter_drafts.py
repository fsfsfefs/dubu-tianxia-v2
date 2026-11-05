"""Store external chapter drafts independently of generated summaries."""
import json
from uuid import NAMESPACE_URL, uuid4, uuid5

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pypdf import PdfReader
from starlette.responses import Response

from ..chapter_drafts import DRAFT_TYPES, MAX_DRAFT_BYTES, DraftLink, validate_draft

METADATA = "id,document_id,chapter_key,chapter_title,start_page,end_page,depth,filename,format,links,created_at"


def describe(row):
    links = json.loads(row["links"])
    for index, link in enumerate(links):
        if "id" not in link:
            source = json.dumps(link, sort_keys=True)
            link["id"] = str(uuid5(NAMESPACE_URL, f"chapter-draft:{row['id']}:{index}:{source}"))
    return {**dict(row), "links": links}


def create_router(runtime):
    router = APIRouter(prefix="/api/documents/{document_id}/chapter-drafts")

    def page_count(document_id):
        try:
            path = runtime.repository.document_path(document_id)
        except LookupError as error:
            raise HTTPException(404, "教材不存在。") from error
        return len(PdfReader(path).pages)

    @router.get("")
    def list_drafts(document_id: str):
        with runtime.repository.connect() as connection:
            rows = connection.execute(
                f"SELECT {METADATA} FROM chapter_drafts WHERE document_id=? ORDER BY created_at, rowid",
                (document_id,),
            )
            return {"drafts": [describe(row) for row in rows]}

    @router.post("", status_code=201)
    def import_draft(
        document_id: str, file: UploadFile = File(), chapter_key: str = Form(max_length=500),
        chapter_title: str = Form(min_length=1, max_length=500), start_page: int = Form(ge=1),
        depth: int = Form(ge=0, le=20), end_page: int | None = Form(default=None, ge=1),
    ):
        if not chapter_key.startswith(f"{document_id}:ch-"):
            raise HTTPException(422, "小章标识无效。")
        pages = page_count(document_id)
        end_page = pages if end_page is None else end_page
        if not start_page <= end_page <= pages:
            raise HTTPException(422, "章节页码超出教材范围。")
        filename = (file.filename or "").replace("\\", "/").split("/")[-1]
        if not filename or len(filename) > 255:
            raise HTTPException(422, "文件名无效。")
        kind = filename.lower().rpartition(".")[2]
        data = file.file.read(MAX_DRAFT_BYTES + 1)
        try:
            validate_draft(kind, data)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        draft_id = str(uuid4())
        with runtime.repository.connect() as connection:
            row = connection.execute(f"""
                INSERT INTO chapter_drafts
                (id,document_id,chapter_key,chapter_title,start_page,end_page,depth,filename,format,data)
                VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING {METADATA}
            """, (draft_id, document_id, chapter_key, chapter_title, start_page, end_page, depth, filename, kind, data)).fetchone()
            return {"draft": describe(row)}

    @router.get("/{draft_id}/file")
    def read_file(document_id: str, draft_id: str):
        with runtime.repository.connect() as connection:
            row = connection.execute("SELECT format,data FROM chapter_drafts WHERE document_id=? AND id=?",
                                     (document_id, draft_id)).fetchone()
        if row is None:
            raise HTTPException(404, "导入稿不存在。")
        return Response(row["data"], media_type=DRAFT_TYPES[row["format"]], headers={
            "X-Content-Type-Options": "nosniff", "Content-Disposition": "attachment",
        })

    def change_link(document_id, draft_id, link_id=None, link=None):
        if link is not None and link.page > page_count(document_id):
            raise HTTPException(422, "跳转页码超出教材范围。")
        with runtime.repository.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(f"SELECT {METADATA} FROM chapter_drafts WHERE document_id=? AND id=?",
                                     (document_id, draft_id)).fetchone()
            if row is None:
                raise HTTPException(404, "导入稿不存在。")
            draft = describe(row)
            links = draft["links"]
            if link_id is None:
                if len(links) >= 500:
                    raise HTTPException(422, "每份导入稿最多添加 500 个跳转。")
                links.append({"id": str(uuid4()), **link.model_dump(exclude_none=True)})
            else:
                index = next((index for index, item in enumerate(links) if item["id"] == link_id), None)
                if index is None:
                    raise HTTPException(404, "跳转不存在。")
                if link is None:
                    links.pop(index)
                else:
                    links[index] = {"id": link_id, **link.model_dump(exclude_none=True)}
            connection.execute("UPDATE chapter_drafts SET links=? WHERE document_id=? AND id=?",
                               (json.dumps(links, ensure_ascii=False), document_id, draft_id))
            return {"draft": draft}

    @router.post("/{draft_id}/links", status_code=201)
    def add_link(document_id: str, draft_id: str, link: DraftLink):
        return change_link(document_id, draft_id, link=link)

    @router.put("/{draft_id}/links/{link_id}")
    def edit_link(document_id: str, draft_id: str, link_id: str, link: DraftLink):
        return change_link(document_id, draft_id, link_id, link)

    @router.delete("/{draft_id}/links/{link_id}")
    def delete_link(document_id: str, draft_id: str, link_id: str):
        return change_link(document_id, draft_id, link_id)

    return router
