"""Create a checksum-valid v1 fixture from a disposable test server backup."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import zipfile

source,target,document_id=Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3]
with zipfile.ZipFile(source) as z:
    files={name:z.read(name) for name in z.namelist()}
database=target.with_suffix(".db")
database.write_bytes(files["database/reader.db"])
with sqlite3.connect(database) as c:
    c.execute("DROP TABLE schema_migrations")
    c.execute("DELETE FROM document_outlines WHERE document_id=?",(document_id,))
    c.execute("DELETE FROM chapter_summaries WHERE document_id=?",(document_id,))
    for index,title in enumerate(("兼容第一章","兼容第二章")):
        c.execute("INSERT INTO document_outlines(document_id,position,title,page_number,depth) VALUES (?,?,?,?,0)",(document_id,index,title,index+1))
    c.execute("INSERT INTO chapter_summaries(document_id,chapter_key,title,start_page,end_page,depth,content) VALUES (?,?,?,1,1,0,?)",
              (document_id,document_id+":0","兼容第一章","旧版总结已兼容，可查看 PDF2。"))
    c.execute("INSERT INTO chapter_summaries(document_id,chapter_key,title,start_page,end_page,depth,content) VALUES (?,?,?,2,2,0,?)",
              (document_id,document_id+":1","无法对应的旧章节","保留的历史总结 PDF1。"))
    for column in ("title","tags_json","pinned","updated_at"):
        c.execute("ALTER TABLE notes DROP COLUMN "+column)
files["database/reader.db"]=database.read_bytes()
manifest=json.loads(files["manifest.json"])
for item in manifest["files"]:
    item["size"]=len(files[item["path"]])
    item["sha256"]=hashlib.sha256(files[item["path"]]).hexdigest()
files["manifest.json"]=json.dumps(manifest).encode()
with zipfile.ZipFile(target,"w",zipfile.ZIP_DEFLATED) as z:
    for name,content in files.items(): z.writestr(name,content)
