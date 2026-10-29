"""Public persistence facade. Domain-specific operations live in repositories/."""
from .embedding_models import EmbeddingModelManager
from .retrieval_service import RetrievalService
from .repositories.documents import DocumentsRepository
from .repositories.learning import LearningRepository
from .repositories.retrieval import RetrievalRepository
from .repositories.tasks import TasksRepository
from .repositories.profiles import ProfilesRepository
from .repositories.database import DatabaseRepository


class Repository(DocumentsRepository, LearningRepository, RetrievalRepository, TasksRepository, ProfilesRepository, DatabaseRepository):
    """Backward-compatible facade sharing one database and data root."""

    def __init__(self, root):
        self.embedding_models = EmbeddingModelManager(root)
        super().__init__(root)
        self.retrieval = RetrievalService(self, self.embedding_models)
        self.retrieval.initialize()

    def list_embedding_models(self):
        return self.retrieval.list_embedding_models()

    def download_embedding_model(self, model_name):
        return self.retrieval.download_embedding_model(model_name)

    def import_embedding_model(self, name, model_name, payload):
        return self.retrieval.import_embedding_model(name, model_name, payload)

    def select_embedding_model(self, model_id):
        return self.retrieval.select_embedding_model(model_id)

    def rebuild_rag_vectors(self):
        return self.retrieval.rebuild_rag_vectors()

    def save_ocr_page(self, *args, **kwargs):
        with self.retrieval.lock:
            return super().save_ocr_page(*args, **kwargs)

    def search_rag(self, *args, **kwargs):
        with self.retrieval.lock:
            return super().search_rag(*args, **kwargs)
