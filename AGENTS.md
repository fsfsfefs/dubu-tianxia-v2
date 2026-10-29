# Project workflow

- Product name: 读步天下.
- For every user-requested source change, update CHANGELOG.md with a concise description of what was added, changed, or fixed.
- Run relevant frontend/backend checks before committing.
- Unless the user explicitly says not to sync, commit completed changes and push them to the configured GitHub origin branch.
- Never commit .env, API keys, credentials, local databases, uploaded PDFs, downloaded models, backups, logs, virtual environments, dependencies, or generated build output.


- Before proposing or implementing new features, read docs/features.md and inspect the corresponding code. Distinguish existing capabilities, configurable capabilities, enhancements, and genuinely missing features. Update docs/features.md when capabilities or limits change.
