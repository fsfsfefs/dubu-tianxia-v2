import pytest
from fastapi.testclient import TestClient
from reader_next_api.application import create_app
from reader_next_api.book_backup import create_book_backup,inspect_book_backup,install_book_backup
from reader_next_api.repository import Repository


@pytest.fixture
def context(tmp_path):
    with TestClient(create_app(tmp_path/'data')) as client:
        repo=client.app.state.runtime.repository
        doc=repo.add_document('book.pdf',b'%PDF-1.7 fixture')['id']
        other=repo.add_document('other.pdf',b'%PDF-1.7 other')['id']
        def ink(page=1,tags=None,document=doc):
            return repo.add_highlight(document,page,'手写标注 · PDF 第 1 页',[{'x':.2,'y':.2,'width':.004,'height':.004},{'x':.4,'y':.4,'width':.004,'height':.004}],'blue','保留备注',tags or ['__ink__','pen'])
        yield client,repo,doc,other,ink


def test_region_naming_is_atomic_preserves_geometry_and_deletes_as_one(context,tmp_path):
    client,repo,doc,_,ink=context
    a,b=ink(),ink();url=f'/api/documents/{doc}/ink-marks'
    data={'member_ids':[a['id'],b['id']],'region_id':'region-1','name':'图形推导'}
    response=client.put(url,json=data);assert response.status_code==200
    rows=response.json()['highlights'];assert len(rows)==2
    assert all(row['text']=='图形推导' and row['comment']=='保留备注' and row['rects']==a['rects'] for row in rows)
    assert all('__ink_region:region-1' in row['tags'] for row in rows)
    archive=tmp_path/'book.zip';create_book_backup(repo,doc,archive)
    stage=tmp_path/'stage';backup=inspect_book_backup(archive,stage)
    target=Repository(tmp_path/'target');report=install_book_backup(target,backup,stage/'document.pdf')
    assert all(item['text']=='图形推导' and '__ink_region:region-1' in item['tags'] for item in target.list_highlights(report['document_id']))
    # A newly saved stroke in the same region is renamed/deleted with the rest.
    c=ink(tags=['__ink__','pen','__ink_region:region-1'])
    assert len(client.put(url,json={**data,'name':'统一命名'}).json()['highlights'])==3
    deleted=client.request('DELETE',url,json=data)
    assert set(deleted.json()['deleted_ids'])=={a['id'],b['id'],c['id']}
    assert len(deleted.json()['removed'])==3 and repo.list_highlights(doc)==[]


@pytest.mark.parametrize('kind',['cross-book','cross-page','cross-surface','text-highlight','missing','blank-name'])
def test_invalid_region_edits_leave_all_ink_unchanged(context,kind):
    client,repo,doc,other,ink=context
    a=ink()
    if kind=='cross-book':b=ink(document=other)
    elif kind=='cross-page':b=ink(page=2)
    elif kind=='cross-surface':b=ink(tags=['__ink__','pen','__margin_left__'])
    elif kind=='text-highlight':b=ink(tags=['复习'])
    else:b=ink()
    before=repo.list_highlights(doc)
    result=client.put(f'/api/documents/{doc}/ink-marks',json={'member_ids':[a['id'],b['id'] if kind!='missing' else 'missing'],'region_id':'x','name':' ' if kind=='blank-name' else '测试'})
    assert result.status_code in {404,422}
    assert repo.list_highlights(doc)==before
