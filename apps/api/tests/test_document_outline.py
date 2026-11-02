from io import BytesIO
from types import SimpleNamespace
import json
import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter
from reader_next_api.application import create_app
from reader_next_api.domain import ModelProfile
from reader_next_api.document_outline import validate_outline, parse_outline, outline_evidence


@pytest.fixture
def setup(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        runtime=client.app.state.runtime
        writer=PdfWriter()
        for _ in range(4): writer.add_blank_page(width=595,height=842)
        buffer=BytesIO();writer.write(buffer)
        book=runtime.repository.add_document('test.pdf',buffer.getvalue())
        runtime.repository.save_profile(ModelProfile('test','Test','https://example.com/chat/completions','fake'))
        for page in range(1,5):runtime.repository.save_ocr_page(book['id'],page,f'第{page}章 原文标题及内容')
        calls=[]
        async def complete(profile,key,**kwargs):
            calls.append((profile.id,kwargs))
            return json.dumps([{'title':'第一章','page':1,'depth':0},{'title':'第二章','page':3,'depth':0}])
        runtime.provider=SimpleNamespace(complete=complete)
        runtime.credential_store=SimpleNamespace(get=lambda _: 'test-key')
        yield client,runtime,book['id'],calls,writer


def test_existing_bookmarks_win_without_model_call(setup):
    client,runtime,doc,calls,writer=setup
    writer.add_outline_item('原有第一章',0)
    writer.add_outline_item('原有第二章',2)
    with runtime.repository.document_path(doc).open('wb') as stream:writer.write(stream)
    url=f'/api/documents/{doc}/outline'
    original=client.get(url).json()
    assert original['source']=='pdf'
    assert [item['page'] for item in original['outline']]==[1,3]
    result=client.post(url+'/generate',json={'profile_id':'nonexistent'})
    assert result.status_code==200 and not result.json()['generated']
    assert calls==[]


def test_ai_is_reviewable_draft_then_shared_save_and_stale_protection(setup):
    client,runtime,doc,calls,_=setup
    url=f'/api/documents/{doc}/outline'
    before=client.get(url).json()
    draft=client.post(url+'/generate',json={'profile_id':'test'})
    assert draft.status_code==200
    assert draft.json()['generated'] and draft.json()['revision']==before['revision']
    assert runtime.repository.get_imported_outline(doc)==[]
    assert 'PDF实际第4页' in calls[0][1]['prompt']
    assert '印刷页码须转换' in calls[0][1]['system']
    runtime.repository.save_chapter_summary(doc,doc+':__book__','全书',1,4,0,'已有总结')
    items=draft.json()['outline'];items[1]['title']='人工校对第二章';items[1]['page']=4
    saved=client.put(url,json={'outline':items,'expected_revision':before['revision']})
    assert saved.status_code==200 and saved.json()['outline']==items
    assert client.get(url).json()['outline']==items
    assert runtime.repository.list_chapter_summaries(doc)[0]['content']=='已有总结'
    assert client.put(url,json={'outline':items,'expected_revision':before['revision']}).status_code==409
    assert not client.post(url+'/generate',json={'profile_id':'test'}).json()['generated']
    assert len(calls)==1


@pytest.mark.parametrize('items',[
    [{'title':'章节','page':5,'depth':0}],
    [{'title':'章节','page':1,'depth':1}],
    [{'title':'章节','page':3,'depth':0},{'title':'另一章','page':2,'depth':0}],
    [{'title':'章节','page':1,'depth':0},{'title':'另一章','page':2,'depth':2}],
    [{'title':'  ','page':1,'depth':0}],
])
def test_invalid_or_invented_page_and_hierarchy_never_saved(setup,items):
    client,runtime,doc,_,_=setup
    url=f'/api/documents/{doc}/outline'
    revision=client.get(url).json()['revision']
    result=client.put(url,json={'outline':items,'expected_revision':revision})
    assert result.status_code==422
    assert runtime.repository.get_imported_outline(doc)==[]


def test_busy_book_and_missing_model_key_do_not_mutate(setup):
    client,runtime,doc,calls,_=setup
    url=f'/api/documents/{doc}/outline'
    revision=client.get(url).json()['revision']
    runtime.task_manager.book_busy=lambda _:True
    assert client.put(url,json={'outline':[{'title':'章节','page':1,'depth':0}],'expected_revision':revision}).status_code==409
    runtime.credential_store.get=lambda _:None
    assert client.post(url+'/generate',json={'profile_id':'test'}).status_code==409
    assert calls==[] and runtime.repository.get_imported_outline(doc)==[]


def test_invalid_ai_output_and_unreadable_document_preserve_original(setup):
    client,runtime,doc,calls,_=setup
    async def bad(*args,**kwargs):return '[{"title":"虚构页","page":90,"depth":0}]'
    runtime.provider.complete=bad
    url=f'/api/documents/{doc}/outline'
    assert client.post(url+'/generate',json={'profile_id':'test'}).status_code==422
    with runtime.repository.connect() as connection:connection.execute('DELETE FROM ocr_pages WHERE document_id=?',(doc,))
    assert client.post(url+'/generate',json={'profile_id':'test'}).status_code==422
    assert runtime.repository.get_imported_outline(doc)==[]


def test_parser_rejects_bad_json_and_noninteger_pages():
    for raw in ['broken','[{"title":"x",','[{"title":"x","page":true,"depth":0}]']:
        with pytest.raises(ValueError):parse_outline(raw,10)
    assert parse_outline('```json\n[{"title":"x","page":1,"depth":0}]\n```',2)[0]['page']==1


def test_concurrent_outline_edits_reject_the_stale_writer(setup):
    from concurrent.futures import ThreadPoolExecutor
    client,runtime,doc,_,_=setup
    url=f'/api/documents/{doc}/outline'
    revision=client.get(url).json()['revision']
    def save(title):
        return client.put(url,json={'outline':[{'title':title,'page':1,'depth':0}],'expected_revision':revision}).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(save,['编辑甲','编辑乙']))
    assert sorted(results)==[200,409]
    assert len(runtime.repository.get_imported_outline(doc))==1
