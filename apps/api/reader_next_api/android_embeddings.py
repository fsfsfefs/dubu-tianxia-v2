"""Run the shared dense model presets with the Android ONNX runtime."""
from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx

from .embedding_models import BUILTIN_ID, PRESETS, EmbeddingModelManager
from .rag import SEMANTIC_MODEL


SOURCES = {
    PRESETS[0]["model_name"]: "Qdrant/bge-small-zh-v1.5",
    PRESETS[1]["model_name"]: "qdrant/paraphrase-multilingual-MiniLM-L12-v2-onnx-Q",
}
MODEL_FILE = "model_optimized.onnx"
MODEL_FILES = (MODEL_FILE, "tokenizer.json", "tokenizer_config.json", "config.json")


class AndroidDenseModel:
    def __init__(self, path: Path, dimension: int, use_cls: bool):
        import numpy
        import onnxruntime
        from tokenizers import Tokenizer

        self.numpy = numpy
        self.dimension = dimension
        self.use_cls = use_cls
        self.tokenizer = Tokenizer.from_file(str(path / "tokenizer.json"))
        config = json.loads((path / "tokenizer_config.json").read_text(encoding="utf-8"))
        length = config.get("model_max_length")
        self.tokenizer.enable_truncation(max_length=min(length, 512) if isinstance(length, int) and length > 0 else 512)
        self.tokenizer.no_padding()
        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        self.session = onnxruntime.InferenceSession(str(path / MODEL_FILE), options, providers=["CPUExecutionProvider"])
        self.inputs = {item.name for item in self.session.get_inputs()}

    def embed(self, texts):
        np = self.numpy
        for text in texts:
            encoded = self.tokenizer.encode(text)
            features = {"input_ids": encoded.ids, "attention_mask": encoded.attention_mask, "token_type_ids": encoded.type_ids}
            inputs = {name: np.asarray([features[name]], dtype=np.int64) for name in self.inputs}
            output = self.session.run(None, inputs)[0][0]
            if output.ndim == 2:
                output = output[0] if self.use_cls else np.average(output, axis=0, weights=encoded.attention_mask)
            if self.use_cls:
                output = output / max(float(np.linalg.norm(output)), 1e-12)
            if output.shape != (self.dimension,) or not np.isfinite(output).all():
                raise ValueError("模型输出与所选向量模型不匹配。")
            yield output.tolist()


class AndroidEmbeddings(EmbeddingModelManager):
    def active(self) -> dict:
        model = super().active()
        if model["id"] != BUILTIN_ID:
            try:
                self._instance(model)
            except (RuntimeError, ValueError):
                return self.builtin()
        return model

    def list_models(self) -> dict:
        with self._lock:
            catalog = super().list_models()
            catalog["active_id"] = self.active()["id"]
            catalog["models"] = [
                model for model in catalog["models"]
                if model["id"] == BUILTIN_ID or model["model_name"] in SOURCES
            ]
            return catalog

    @property
    def active_key(self) -> str:
        model = self.active()
        if model["id"] == BUILTIN_ID:
            return SEMANTIC_MODEL
        return f"android-onnx-v1:{model['id']}:{model['model_name']}"

    def _model_path(self, model: dict, source: str) -> Path | None:
        root = self.models_dir.resolve()
        cache = root / "cache"
        snapshots = cache / ("models--" + source.replace("/", "--")) / "snapshots"
        candidates = [
            root / "downloads" / source.replace("/", "--"),
            cache / "fast-bge-small-zh-v1.5" if source == SOURCES[PRESETS[0]["model_name"]] else None,
            *sorted(snapshots.glob("*"), reverse=True),
        ]
        if model.get("local_path"):
            candidates = [Path(model["local_path"])]
        for candidate in candidates:
            if candidate is None:
                continue
            candidate = candidate.resolve()
            if root in candidate.parents and all((candidate / name).is_file() for name in MODEL_FILES):
                return candidate
        return None

    @staticmethod
    def _download(source: str, target: Path) -> None:
        with httpx.Client(follow_redirects=True, timeout=60) as client:
            for name in MODEL_FILES:
                limit = (512 if name == MODEL_FILE else 16) * 1024 * 1024
                with client.stream("GET", f"https://huggingface.co/{source}/resolve/main/{name}") as response:
                    response.raise_for_status()
                    received = 0
                    with (target / name).open("wb") as output:
                        for chunk in response.iter_bytes(256 * 1024):
                            received += len(chunk)
                            if received > limit:
                                raise ValueError("向量模型文件超过大小限制。")
                            output.write(chunk)

    def _instance(self, model: dict, *, allow_download: bool = False):
        with self._lock:
            model_id = model["id"]
            if model_id in self._instances:
                return self._instances[model_id]
            preset = next((item for item in PRESETS if item["model_name"] == model["model_name"]), None)
            if not preset:
                raise ValueError("安卓不支持这个向量模型。")
            source = SOURCES[preset["model_name"]]

            def load(path):
                instance = AndroidDenseModel(path, preset["dimension"], preset is PRESETS[0])
                next(instance.embed(["本地向量模型连接测试"]))
                return instance

            try:
                path = self._model_path(model, source)
                if path is not None:
                    instance = load(path)
                elif allow_download:
                    downloads = self.models_dir / "downloads"
                    downloads.mkdir(exist_ok=True)
                    with TemporaryDirectory(dir=downloads) as temporary:
                        staging = Path(temporary)
                        self._download(source, staging)
                        instance = load(staging)
                        path = downloads / source.replace("/", "--")
                        staging.replace(path)
                else:
                    raise ValueError("找不到向量模型文件，请检查备份或模型压缩包。")
            except httpx.HTTPError as error:
                raise RuntimeError("向量模型下载失败，请检查 Hugging Face 网络连接。") from error
            except ValueError:
                raise
            except Exception as error:
                raise RuntimeError("无法加载安卓向量模型，请检查 ONNX 文件、分词器及剩余空间。") from error
            model["local_path"] = str(path)
            self._instances[model_id] = instance
            return instance
