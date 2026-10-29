from reader_next_api.credentials import CredentialStore


class FailingKeyring:
    def get_password(self, service_name, username):
        raise RuntimeError("no desktop session")

    def set_password(self, service_name, username, password):
        raise RuntimeError("no desktop session")

    def delete_password(self, service_name, username):
        raise RuntimeError("no desktop session")


def test_falls_back_to_local_file(tmp_path):
    store = CredentialStore(tmp_path, FailingKeyring())

    assert store.set("profile-1", " secret-value ") == "local-file"
    assert store.get("profile-1") == "secret-value"
    assert "secret-value" in (tmp_path / "credentials.json").read_text(encoding="utf-8")

    store.delete("profile-1")
    assert store.get("profile-1") is None
