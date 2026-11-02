from io import BytesIO
import json
import zipfile
import pytest
from PIL import Image
from fastapi.testclient import TestClient
from reader_next_api.application import create_app
from reader_next_api.repository import Repository
from reader_next_api.note_images import MAX_NOTE_IMAGES
from reader_next_api.book_backup import create_book_backup,inspect_book_backup,install_book_backup
from reader_next_api.full_backup import create_full_backup,inspect_backup,install_full_backup


def png():
    output=BytesIO();Image.new('RGB',(8,8),'red').save(output,format='PNG');return output.getvalue()


@pytest.fixture
def context(tmp_path):
    with TestClient(create_app(tmp_path/'live')) as client:
        repo=client.app.state.runtime.repository
        book=repo.add_document('book.pdf',b'%PDF-1.7 fixture')
        other=repo.add_document('other.pdf',b'%PDF-1.7 other')
        yield client,repo,book['id'],other['id']


def post(client,doc,**kwargs):
    files=kwargs.pop('files',[])
    return client.post(f'/api/documents/{doc}/sticky-notes',data={'payload':json.dumps({'page_number':1,**kwargs})},files=[('files',('image.png',data,'image/png')) for data in files])


def test_image_only_note_read_edit_remove_and_document_isolation(context):
    client,repo,doc,other=context
    result=post(client,doc,files=[png()]);assert result.status_code==200
    note=result.json()['note'];image=note['images'][0]
    assert note['content']=='' and image['byte_size']==len(png())
    assert client.get(image['url']).content==png()
    assert client.get(image['url'].replace(doc,other)).status_code==404
    assert client.get(f'/api/documents/{doc}/notes').json()['notes'][0]['images']==note['images']
    assert client.put(f'/api/documents/{doc}/notes/{note["id"]}',json={'content':'','pinned':True,'tags':['页边便签']}).status_code==200
    assert post(client,doc,note_id=note['id'],keep_image_ids=[],content='').status_code==422
    assert client.get(image['url']).status_code==200
    changed=post(client,doc,note_id=note['id'],keep_image_ids=[],content='只保留文字')
    assert changed.json()['note']['images']==[] and client.get(image['url']).status_code==404
    assert post(client,other,note_id=note['id'],content='cross book').status_code==404
    assert repo.list_notes(doc)[0]['content']=='只保留文字'


def test_corrupt_and_oversize_images_leave_no_partial_note(context):
    client,repo,doc,_=context
    assert post(client,doc,files=[b'<svg onload="alert(1)"/>']).status_code==422
    assert post(client,doc,files=[b'x'*(MAX_NOTE_IMAGES+1)]).status_code==413
    assert repo.list_notes(doc)==[]


def test_exact_twenty_mb_is_accepted_and_total_limit_is_enforced(context):
    client,repo,doc,_=context
    data=png()+b'\0'*(MAX_NOTE_IMAGES-len(png()))
    result=post(client,doc,files=[data]);assert result.status_code==200
    note=result.json()['note'];image=note['images'][0]
    assert post(client,doc,note_id=note['id'],keep_image_ids=[image['id']],files=[png()]).status_code==422
    assert len(repo.note_image(doc,note['id'],image['id'])['data'])==MAX_NOTE_IMAGES
    client.delete(f'/api/documents/{doc}/notes/{note["id"]}')
    assert client.get(image['url']).status_code==404


def test_single_book_and_full_backup_preserve_binary_images_and_margin_tags(context,tmp_path):
    _,repo,doc,_=context
    note=repo.save_sticky_note(doc,None,1,'图文便签',[],[png()])
    repo.add_highlight(doc,1,'页边手写',[{'x':.1,'y':.1,'width':.004,'height':.004}], 'blue','',['__ink__','pen','__margin_left__'])
    archive=tmp_path/'single.zip';create_book_backup(repo,doc,archive)
    with zipfile.ZipFile(archive) as z:
        assert json.loads(z.read('manifest.json'))['version']==2
        assert 'note-images/0.bin' in z.namelist()
    stage=tmp_path/'single-stage';data=inspect_book_backup(archive,stage)
    target=Repository(tmp_path/'single-target');report=install_book_backup(target,data,stage/'document.pdf')
    restored=target.list_notes(report['document_id'])[0];image=restored['images'][0]
    assert restored['id']!=note['id'] and target.note_image(report['document_id'],restored['id'],image['id'])['data']==png()
    assert '__margin_left__' in target.list_highlights(report['document_id'])[0]['tags']
    archive=tmp_path/'full.zip';create_full_backup(repo.root,archive)
    stage=tmp_path/'full-stage';inspect_backup(archive,stage)
    root=tmp_path/'full-target';Repository(root);install_full_backup(root,stage)
    target=Repository(root);restored=target.list_notes(doc)[0]
    assert target.note_image(doc,restored['id'],restored['images'][0]['id'])['data']==png()
