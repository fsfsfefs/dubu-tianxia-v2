"""ASGI entry point. Importing this module does not touch user data."""
from .application import create_app

app = create_app()
