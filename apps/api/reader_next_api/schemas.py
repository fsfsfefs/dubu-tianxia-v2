"""Validated HTTP request contracts, independent of application startup."""
from pydantic import BaseModel, Field

class ProfileInput(BaseModel):
    id: str | None = None
    name: str = Field(min_length=1, max_length=80)
    endpoint: str
    model: str
    api_key: str | None = None
    temperature: float = 0.2
    max_tokens: int = 2048
    is_default: bool = False


class DocumentUpdateInput(BaseModel):
    title: str = Field(min_length=1, max_length=160)


class FolderInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class FolderMoveInput(BaseModel):
    folder_id: str | None = None


class EmbeddingDownloadInput(BaseModel):
    model_name: str = Field(min_length=1, max_length=200)


class EmbeddingSelectionInput(BaseModel):
    model_id: str = Field(min_length=1, max_length=200)


class IndexTaskInput(BaseModel):
    document_ids: list[str] = Field(min_length=1, max_length=20)


class ChatInput(BaseModel):
    document_id: str | None = None
    document_ids: list[str] = Field(default_factory=list, max_length=12)
    profile_id: str
    excerpt: str = Field(default="", max_length=12000)
    question: str = Field(min_length=1, max_length=4000)
    history: list[dict[str, str]] = Field(default_factory=list, max_length=24)
    page_number: int | None = Field(default=None, ge=1)
    max_tokens: int | None = Field(default=None, ge=1, le=16384)
    use_web: bool = False
    use_rag: bool = False
    use_agent: bool = False
    persist_history: bool = True
    verify_citations: bool = True


class PositionInput(BaseModel):
    page_number: int = Field(ge=1)
    page_offset: float = Field(default=0.0, ge=0.0, le=1.0)
    zoom: float = Field(ge=0.5, le=3.0)


class OcrPageInput(BaseModel):
    text: str = Field(default="", max_length=100000)


class ChapterSummaryInput(BaseModel):
    chapter_key: str = Field(min_length=1, max_length=500)
    title: str = Field(min_length=1, max_length=500)
    start_page: int = Field(ge=1)
    end_page: int = Field(ge=1)
    depth: int = Field(ge=0, le=20)
    content: str = Field(min_length=1, max_length=50000)


class OutlineEntryInput(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    page: int = Field(ge=1)
    depth: int = Field(ge=0, le=20)


class LearningStructureImportInput(BaseModel):
    outline: list[OutlineEntryInput] = Field(default_factory=list, max_length=1000)
    summaries: list[ChapterSummaryInput] = Field(default_factory=list, max_length=1001)


class HighlightRect(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(gt=0, le=1)
    height: float = Field(gt=0, le=1)


class HighlightInput(BaseModel):
    page_number: int = Field(ge=1)
    text: str = Field(min_length=1, max_length=12000)
    rects: list[HighlightRect] = Field(default_factory=list, max_length=1200)
    color: str = Field(default="yellow", pattern="^(yellow|green|blue|pink|black|red)$")
    comment: str = Field(default="", max_length=12000)
    tags: list[str] = Field(default_factory=list, max_length=30)


class HighlightUpdateInput(BaseModel):
    color: str = Field(pattern="^(yellow|green|blue|pink|black|red)$")
    comment: str = Field(default="", max_length=12000)
    tags: list[str] = Field(default_factory=list, max_length=30)


class NoteInput(BaseModel):
    page_number: int | None = Field(default=None, ge=1)
    excerpt: str = Field(default="", max_length=12000)
    content: str = Field(min_length=1, max_length=20000)
    title: str = Field(default="", max_length=300)
    tags: list[str] = Field(default_factory=list, max_length=30)
    pinned: bool = False


class NoteUpdateInput(BaseModel):
    content: str = Field(min_length=1, max_length=20000)
    title: str = Field(default="", max_length=300)
    tags: list[str] = Field(default_factory=list, max_length=30)
    pinned: bool = False


class FlashcardGenerateInput(BaseModel):
    profile_id: str
    page_number: int | None = Field(default=None, ge=1)
    excerpt: str = Field(min_length=1, max_length=12000)
    count: int | None = Field(default=None, ge=1)


class FlashcardInput(BaseModel):
    page_number: int | None = Field(default=None, ge=1)
    source_excerpt: str = Field(default="", max_length=12000)
    question: str = Field(min_length=1, max_length=1000)
    answer: str = Field(min_length=1, max_length=4000)


class FlashcardUpdateInput(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
    answer: str = Field(min_length=1, max_length=4000)


class FlashcardReviewInput(BaseModel):
    mastered: bool


class SummaryTaskInput(BaseModel):
    document_id: str
    profile_id: str
    outline: list[dict] = Field(min_length=1, max_length=1000)
    chapter_index: int | None = Field(default=None, ge=0)


class SummaryCheckpointInput(BaseModel):
    content: str = Field(min_length=1, max_length=50000)


class ProfileTestInput(BaseModel):
    id: str | None = None
    endpoint: str
    model: str
    api_key: str | None = None
    temperature: float = 0.2
    max_tokens: int = 2048
