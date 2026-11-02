"""Named, book-owned conversation snapshots; never includes credentials or image payloads."""
import json
from uuid import uuid4
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Literal

class Message(BaseModel):
    role: Literal['user','assistant']
    content: str = Field(max_length=1000000)
class Snapshot(BaseModel):
    title: str = Field(min_length=1,max_length=80)
    kind: Literal['chat','master']
    messages: list[Message] = Field(default_factory=list,max_length=1000)
    revision: int = Field(default=0,ge=0)

def create_router(runtime):
    router=APIRouter()
    def owned(doc):
        try: runtime.repository.document_path(doc)
        except LookupError as error: raise HTTPException(404,str(error)) from error
    def decode(row):
        data=dict(row);data['messages']=json.loads(data.pop('messages_json'));return data
    @router.get('/api/documents/{doc}/saved-chats')
    def listing(doc:str):
        owned(doc)
        with runtime.repository.connect() as db:
            # Lazy import preserves old Master rows and their original API unchanged.
            legacy=db.execute('SELECT role,content FROM chat_messages WHERE document_id=? ORDER BY created_at,rowid',(doc,)).fetchall()
            if legacy and not db.execute("SELECT 1 FROM saved_chats WHERE document_id=? AND kind='master'",(doc,)).fetchone():
                db.execute("INSERT OR IGNORE INTO saved_chats(id,document_id,title,kind,messages_json) VALUES(?,?,?,'master',?)",
                  ('legacy:'+doc,doc,'旧Master对话',json.dumps([dict(x) for x in legacy],ensure_ascii=False)))
            rows=db.execute('SELECT * FROM saved_chats WHERE document_id=? ORDER BY updated_at DESC,rowid DESC',(doc,)).fetchall()
        return {'chats':[decode(row) for row in rows]}
    @router.post('/api/documents/{doc}/saved-chats',status_code=201)
    def create(doc:str,payload:Snapshot):
        return write(doc,str(uuid4()),payload,True)
    def write(doc,chat,payload,create=False):
        owned(doc)
        title=payload.title.strip()
        if not title: raise HTTPException(422,'聊天名称不能为空。')
        raw=json.dumps([x.model_dump() for x in payload.messages],ensure_ascii=False)
        if len(raw.encode())>2*1024*1024: raise HTTPException(413,'单个聊天文字记录不能超过2MB，请新建聊天。')
        with runtime.repository.connect() as db:
            if create:
                db.execute('INSERT INTO saved_chats(id,document_id,title,kind,messages_json) VALUES(?,?,?,?,?)',(chat,doc,title,payload.kind,raw))
            else:
                old=db.execute('SELECT * FROM saved_chats WHERE id=? AND document_id=?',(chat,doc)).fetchone()
                if old is None: raise HTTPException(404,'聊天不存在。')
                result=db.execute('UPDATE saved_chats SET title=?,kind=?,messages_json=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND document_id=? AND revision=?',(title,payload.kind,raw,chat,doc,payload.revision))
                if result.rowcount!=1: raise HTTPException(409,'聊天已在其他窗口修改，请重新打开历史聊天。')
            row=db.execute('SELECT * FROM saved_chats WHERE id=? AND document_id=?',(chat,doc)).fetchone()
        return {'chat':decode(row)}
    @router.put('/api/documents/{doc}/saved-chats/{chat}')
    def update(doc:str,chat:str,payload:Snapshot): return write(doc,chat,payload)
    return router
