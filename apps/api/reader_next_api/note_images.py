"""Raster attachments, stored in SQLite so all backup types include them."""
from io import BytesIO
from PIL import Image, UnidentifiedImageError
MAX_NOTE_IMAGES = 20 * 1024 * 1024
FORMATS = {"PNG":"image/png", "JPEG":"image/jpeg", "WEBP":"image/webp", "GIF":"image/gif"}


def validate_note_image(data):
    if not data or len(data) > MAX_NOTE_IMAGES:
        raise ValueError("便签图片不得为空，单张及每条便签的图片合计不能超过20MB。")
    try:
        with Image.open(BytesIO(data)) as image:
            mime=FORMATS.get(image.format)
            if not mime:
                raise ValueError("仅支持PNG、JPEG、WebP和GIF图片。")
            image.verify()
    except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError) as error:
        raise ValueError("图片文件损坏或尺寸过大，无法保存。") from error
    return mime


def image_metadata(row):
    return {"id":row["id"],"mime_type":row["mime_type"],"byte_size":row["byte_size"],
            "url":f"/api/documents/{row['document_id']}/notes/{row['note_id']}/images/{row['id']}"}
