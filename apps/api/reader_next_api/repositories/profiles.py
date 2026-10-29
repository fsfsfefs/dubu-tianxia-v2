from __future__ import annotations


from ..domain import ModelProfile


class ProfilesRepository:
    def list_profiles(self) -> list[dict]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM model_profiles ORDER BY is_default DESC, created_at DESC"
            ).fetchall()
        return [{**dict(row), "is_default": bool(row["is_default"])} for row in rows]


    def save_profile(self, profile: ModelProfile) -> dict:
        profile.validate()
        with self.connect() as connection:
            if profile.is_default:
                connection.execute("UPDATE model_profiles SET is_default = 0")
            connection.execute(
                """INSERT INTO model_profiles
                   (id,name,endpoint,model,temperature,max_tokens,is_default)
                   VALUES (?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET name=excluded.name,
                     endpoint=excluded.endpoint,model=excluded.model,
                     temperature=excluded.temperature,max_tokens=excluded.max_tokens,
                     is_default=excluded.is_default""",
                (
                    profile.id,
                    profile.name.strip(),
                    profile.endpoint.strip(),
                    profile.model.strip(),
                    profile.temperature,
                    profile.max_tokens,
                    int(profile.is_default),
                ),
            )
            row = connection.execute(
                "SELECT * FROM model_profiles WHERE id = ?", (profile.id,)
            ).fetchone()
        return {**dict(row), "is_default": bool(row["is_default"])}


    def profile(self, profile_id: str) -> ModelProfile:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM model_profiles WHERE id = ?", (profile_id,)
            ).fetchone()
        if row is None:
            raise LookupError("模型配置不存在。")
        return ModelProfile(
            id=row["id"],
            name=row["name"],
            endpoint=row["endpoint"],
            model=row["model"],
            temperature=row["temperature"],
            max_tokens=row["max_tokens"],
            is_default=bool(row["is_default"]),
        )


    def delete_profile(self, profile_id: str) -> bool:
        with self.connect() as connection:
            row = connection.execute("SELECT is_default FROM model_profiles WHERE id = ?", (profile_id,)).fetchone()
            if row is None:
                return False
            connection.execute("DELETE FROM model_profiles WHERE id = ?", (profile_id,))
            if row["is_default"]:
                replacement = connection.execute(
                    "SELECT id FROM model_profiles ORDER BY created_at DESC LIMIT 1"
                ).fetchone()
                if replacement:
                    connection.execute("UPDATE model_profiles SET is_default = 1 WHERE id = ?", (replacement["id"],))
        return True
