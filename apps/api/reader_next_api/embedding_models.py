from __future__ import annotations

import json
import shutil
import threading
import zipfile
from io import BytesIO
from pathlib import Path
from uuid import uuid4

from .rag import SEMANTIC_MODEL, semantic_embedding


BUILTIN_ID = "builtin-local-hash"
PRESETS = (
    {
        "id": "download-bge-small-zh-v1.5",
        "name": "BGE Small 中文",
        "engine": "fastembed",
        "model_name": "BAAI/bge-small-zh-v1.5",
        "dimension": 512,
        "size_gb": 0.09,
        "description": "轻量中文语义模型，适合中文教材。",
    },
    {
        "id": "download-paraphrase-multilingual-minilm",
        "name": "Multilingual MiniLM",
        "engine": "fastembed",
        "model_name": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
        "dimension": 384,
        "size_gb": 0.22,
        "description": "中英文混合教材与跨语言检索。",
    },
)


class EmbeddingModelManager:
    """Manage local embedding models without coupling them to SQLite."""

    def __init__(self, data_root: Path) -> None:
        self.data_root = data_root
        self.models_dir = data_root / "embedding-models"
        self.models_dir.mkdir(parents=True, exist_ok=True)
        self.config_path = data_root / "embedding-models.json"
        self._lock = threading.RLock()
        self._instances: dict[str, object] = {}
        if not self.config_path.exists():
            self._write({"active_id": BUILTIN_ID, "models": []})

    def _read(self) -> dict:
        try:
            payload = json.loads(self.config_path.read_text(encoding="utf-8"))
            if isinstance(payload, dict):
                payload.setdefault("active_id", BUILTIN_ID)
                payload.setdefault("models", [])
                return payload
        except (OSError, ValueError):
            pass
        return {"active_id": BUILTIN_ID, "models": []}

    def _write(self, payload: dict) -> None:
        temporary = self.config_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self.config_path)

    @staticmethod
    def builtin() -> dict:
        return {
            "id": BUILTIN_ID,
            "name": "内置轻量语义向量",
            "engine": "builtin",
            "model_name": SEMANTIC_MODEL,
            "dimension": 384,
            "size_gb": 0,
            "source": "builtin",
            "status": "ready",
            "description": "完全离线、零下载，适合基础术语和缩写检索。",
        }

    def list_models(self) -> dict:
        with self._lock:
            config = self._read()
            installed = {item["model_name"]: item for item in config["models"]}
            models = [self.builtin(), *config["models"]]
            presets = [
                {**item, "source": "download", "status": "ready" if item["model_name"] in installed else "available"}
                for item in PRESETS
            ]
            return {"active_id": config["active_id"], "models": models, "presets": presets}

    def active(self) -> dict:
        config = self._read()
        if config["active_id"] == BUILTIN_ID:
            return self.builtin()
        return next((item for item in config["models"] if item["id"] == config["active_id"]), self.builtin())

    @property
    def active_key(self) -> str:
        item = self.active()
        return SEMANTIC_MODEL if item["id"] == BUILTIN_ID else f"fastembed:{item['id']}:{item['model_name']}"

    @property
    def uses_builtin(self) -> bool:
        return self.active()["id"] == BUILTIN_ID

    @staticmethod
    def _fastembed_class():
        try:
            from fastembed import TextEmbedding
        except ImportError as error:
            raise RuntimeError("尚未安装本地向量运行时，请重新安装后端依赖。") from error
        return TextEmbedding

    def _instance(self, model: dict, *, allow_download: bool = False):
        model_id = model["id"]
        if model_id in self._instances:
            return self._instances[model_id]
        TextEmbedding = self._fastembed_class()
        options = {
            "model_name": model["model_name"],
            "cache_dir": str(self.models_dir / "cache"),
            "local_files_only": not allow_download,
        }
        if model.get("local_path"):
            options["specific_model_path"] = model["local_path"]
        instance = TextEmbedding(**options)
        self._instances[model_id] = instance
        return instance

    def install_download(self, model_name: str) -> dict:
        preset = next((item for item in PRESETS if item["model_name"] == model_name), None)
        if not preset:
            raise ValueError("不支持的预设向量模型。")
        with self._lock:
            config = self._read()
            existing = next((item for item in config["models"] if item["model_name"] == model_name), None)
            if existing:
                return existing
            record = {
                **preset,
                "id": str(uuid4()),
                "source": "download",
                "status": "ready",
                "local_path": None,
            }
            instance = self._instance(record, allow_download=True)
            vector = list(next(instance.embed(["本地向量模型连接测试"])))
            record["dimension"] = len(vector)
            config["models"].append(record)
            self._write(config)
            return record

    @staticmethod
    def _safe_extract(payload: bytes, target: Path) -> Path:
        if len(payload) > 2 * 1024 * 1024 * 1024:
            raise ValueError("模型压缩包不能超过 2 GB。")
        target.mkdir(parents=True, exist_ok=False)
        try:
            with zipfile.ZipFile(BytesIO(payload)) as archive:
                total = 0
                root = target.resolve()
                for info in archive.infolist():
                    total += info.file_size
                    if total > 3 * 1024 * 1024 * 1024:
                        raise ValueError("模型解压后不能超过 3 GB。")
                    destination = (target / info.filename).resolve()
                    if root not in destination.parents and destination != root:
                        raise ValueError("模型压缩包包含不安全路径。")
                archive.extractall(target)
            children = [item for item in target.iterdir() if item.name != "__MACOSX"]
            return children[0] if len(children) == 1 and children[0].is_dir() else target
        except Exception:
            shutil.rmtree(target, ignore_errors=True)
            raise

    def install_archive(self, name: str, model_name: str, payload: bytes) -> dict:
        preset = next((item for item in PRESETS if item["model_name"] == model_name), None)
        if not preset:
            raise ValueError("请选择与导入文件对应的基础模型。")
        with self._lock:
            model_id = str(uuid4())
            model_path = self._safe_extract(payload, self.models_dir / "imports" / model_id)
            record = {
                **preset,
                "id": model_id,
                "name": name.strip()[:80] or preset["name"],
                "source": "import",
                "status": "ready",
                "local_path": str(model_path),
            }
            try:
                instance = self._instance(record)
                vector = list(next(instance.embed(["本地导入模型连接测试"])))
                record["dimension"] = len(vector)
            except Exception:
                shutil.rmtree(self.models_dir / "imports" / model_id, ignore_errors=True)
                self._instances.pop(model_id, None)
                raise
            config = self._read()
            config["models"].append(record)
            self._write(config)
            return record

    def select(self, model_id: str) -> dict:
        with self._lock:
            config = self._read()
            if model_id == BUILTIN_ID:
                model = self.builtin()
            else:
                model = next((item for item in config["models"] if item["id"] == model_id), None)
                if not model:
                    raise LookupError("向量模型不存在或尚未下载。")
                self._instance(model)
            config["active_id"] = model_id
            self._write(config)
            return model

    def embed_passages(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        model = self.active()
        if model["id"] == BUILTIN_ID:
            return [semantic_embedding(text) for text in texts]
        return [list(vector) for vector in self._instance(model).embed(texts)]

    def embed_query(self, text: str) -> list[float]:
        model = self.active()
        if model["id"] == BUILTIN_ID:
            return semantic_embedding(text)
        instance = self._instance(model)
        query_embed = getattr(instance, "query_embed", None)
        return list(next(query_embed(text) if query_embed else instance.embed([text])))
