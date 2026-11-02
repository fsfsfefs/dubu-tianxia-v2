import json
from reader_next_api.application import create_app
from fastapi.testclient import TestClient
from reader_next_api.book_backup import create_book_backup, inspect_book_backup, install_book_backup
from reader_next_api.repository import Repository

def test_sessions_are_named_isolated_versioned_and_preserve_legacy(tmp_path):
 with TestClient(create_app(tmp_path/'data')) as client:
  repo=client.app.state.runtime.repository
  from pypdf import PdfWriter
  from io import BytesIO
  def pdf(count):
   writer=PdfWriter()
   for _ in range(count):writer.add_blank_page(width=200,height=300)
   buf=BytesIO();writer.write(buf);return buf.getvalue()
  a=repo.add_document('a.pdf',pdf(1))['id'];b=repo.add_document('b.pdf',pdf(2))['id']
  repo.add_chat_message(a,'user','旧问题');repo.add_chat_message(a,'assistant','旧回答')
  base=f'/api/documents/{a}/saved-chats'
  legacy=client.get(base).json()['chats'];assert len(legacy)==1 and legacy[0]['messages'][1]['content']=='旧回答'
  assert len(client.get(base).json()['chats'])==1
  body={'title':'第一节讨论','kind':'chat','messages':[{'role':'user','content':'问题'},{'role':'assistant','content':'回答'}],'revision':0}
  created=client.post(base,json=body);assert created.status_code==201
  record=created.json()['chat'];url=base+'/'+record['id']
  body['title']='重新命名'
  assert client.put(url,json=body).json()['chat']['revision']==1
  assert client.put(url,json=body).status_code==409
  assert client.put(f"/api/documents/{b}/saved-chats/{record['id']}",json=body).status_code==404
  assert client.get(f'/api/documents/{b}/saved-chats').json()['chats']==[]
  body['revision']=1;body['title']=' ';assert client.put(url,json=body).status_code==422
  repo.clear_chat_messages(a)
  assert len(client.get(base).json()['chats'])==2
  # Single-book migration remaps owners and keeps session text and names.
  archive=tmp_path/'book.zip';create_book_backup(repo,a,archive)
  stage=tmp_path/'stage';data=inspect_book_backup(archive,stage)
  other=Repository(tmp_path/'other')
  imported=install_book_backup(other,data,stage/'document.pdf')
  with other.connect() as db:
   rows=db.execute('SELECT title,messages_json FROM saved_chats').fetchall()
   assert len(rows)==2 and '重新命名' in [x['title'] for x in rows]
