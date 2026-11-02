"""Own application resources and coordinate exclusive data restoration."""
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import RLock


from .background_tasks import BackgroundTaskManager
from .credentials import CredentialStore
from .full_backup import create_full_backup, inspect_backup, install_full_backup
from .providers import OpenAICompatibleProvider
from .repository import Repository


class MaintenanceBusy(Exception):
    pass


class Runtime:
    def __init__(self, data_root: Path, ocr_assets: Path, *, credential_store=None, repository_factory=Repository):
        self.data_root = data_root
        self.ocr_assets = ocr_assets
        self._credential_store = credential_store
        self._repository_factory = repository_factory
        self._lock = RLock()
        self._active = 0
        self._maintenance = False

    def start(self):
        self.repository = self._repository_factory(self.data_root)
        self.provider = OpenAICompatibleProvider()
        if self._credential_store is None:
            import keyring
            self.credential_store = CredentialStore(self.data_root, keyring)
        else:
            self.credential_store = self._credential_store
        self.task_manager = BackgroundTaskManager(self.repository, self.provider, self.credential_store)

    def stop(self):
        self.task_manager.shutdown()

    @contextmanager
    def lease(self, exclusive=False):
        with self._lock:
            if self._maintenance or (exclusive and self._active):
                raise MaintenanceBusy()
            self._active += 1
            self._maintenance = exclusive
        try:
            yield
        finally:
            with self._lock:
                self._active -= 1
                if exclusive:
                    self._maintenance = False

    def restore(self, staging: Path, safety_path: Path):
        """Called under an exclusive request lease, including streamed responses."""
        self.task_manager.shutdown()
        replacement = None
        try:
            safety = create_full_backup(self.data_root, safety_path)
            counts = install_full_backup(self.data_root, staging)
            try:
                replacement = self._repository_factory(self.data_root)
            except Exception as error:
                with TemporaryDirectory(dir=self.data_root) as temporary:
                    rollback_stage = Path(temporary) / "rollback"
                    inspect_backup(safety_path, rollback_stage)
                    install_full_backup(self.data_root, rollback_stage)
                raise RuntimeError(f"导入后初始化失败，已回滚到导入前的数据：{error}") from error
        finally:
            self.repository = replacement if replacement is not None else self._repository_factory(self.data_root)
            self.task_manager = BackgroundTaskManager(self.repository, self.provider, self.credential_store)
        return counts, safety
