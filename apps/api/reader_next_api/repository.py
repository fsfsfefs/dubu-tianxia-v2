"""Public persistence facade. Domain-specific operations live in repositories/."""
from .repositories.documents import DocumentsRepository
from .repositories.learning import LearningRepository
from .repositories.retrieval import RetrievalRepository
from .repositories.tasks import TasksRepository
from .repositories.profiles import ProfilesRepository
from .repositories.database import DatabaseRepository


class Repository(DocumentsRepository, LearningRepository, RetrievalRepository, TasksRepository, ProfilesRepository, DatabaseRepository):
    """Backward-compatible facade sharing one database and data root."""
