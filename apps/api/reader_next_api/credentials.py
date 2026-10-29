from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Protocol


class KeyringBackend(Protocol):
    def get_password(self, service_name: str, username: str) -> str | None: ...

    def set_password(self, service_name: str, username: str, password: str) -> None: ...

    def delete_password(self, service_name: str, username: str) -> None: ...


class CredentialStore:
    """Keep API keys out of the database, with a local fallback for headless Windows."""

    service_name = "reader-next-v2"

    def __init__(self, data_root: Path, keyring_backend: KeyringBackend) -> None:
        self.path = data_root / "credentials.json"
        self.keyring = keyring_backend

    def set(self, profile_id: str, api_key: str) -> str:
        value = api_key.strip()
        if not value:
            raise ValueError("API Key 不能为空。")
        try:
            self.keyring.set_password(self.service_name, profile_id, value)
            return "system-keyring"
        except Exception:
            credentials = self._read_local()
            credentials[profile_id] = value
            self._write_local(credentials)
            return "local-file"

    def get(self, profile_id: str) -> str | None:
        try:
            value = self.keyring.get_password(self.service_name, profile_id)
        except Exception:
            value = None
        if value:
            return value
        return self._read_local().get(profile_id)

    def delete(self, profile_id: str) -> None:
        try:
            self.keyring.delete_password(self.service_name, profile_id)
        except Exception:
            pass
        credentials = self._read_local()
        if profile_id in credentials:
            del credentials[profile_id]
            self._write_local(credentials)

    def _read_local(self) -> dict[str, str]:
        if not self.path.exists():
            return {}
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError("本地凭据文件无法读取。") from error
        if not isinstance(value, dict):
            raise RuntimeError("本地凭据文件格式无效。")
        return {str(key): str(secret) for key, secret in value.items()}

    def _write_local(self, credentials: dict[str, str]) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(
                json.dumps(credentials, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            os.chmod(temporary, 0o600)
            temporary.replace(self.path)
        except OSError as error:
            raise RuntimeError("系统凭据不可用，且本地凭据文件无法写入。") from error
