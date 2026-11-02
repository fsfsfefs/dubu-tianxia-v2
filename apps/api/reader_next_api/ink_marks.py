"""Atomic naming/deletion of ink regions, preserving stroke geometry and metadata."""
import json
PREFIX="__ink_region:"


def surface(tags):
    return "left" if "__margin_left__" in tags else "right" if "__margin_right__" in tags else "page"


def change_ink_mark(repo,document_id,member_ids,region_id,name=None):
    repo.document_path(document_id)
    ids=set(member_ids)
    with repo.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        rows=[dict(row) for row in connection.execute("SELECT * FROM highlights WHERE document_id=?",(document_id,))]
        selected=[row for row in rows if row['id'] in ids]
        if not selected or {row['id'] for row in selected}!=ids:raise LookupError("标记已变化或不属于当前教材，请重新打开列表。")
        for row in rows:row['tags']=json.loads(row['tags_json'])
        if any('__ink__' not in row['tags'] for row in selected):raise ValueError("只能编辑手写标记，不能混入文字高亮或星标。")
        pages={row['page_number'] for row in selected}
        if len(pages)!=1:raise ValueError("一个标记必须位于同一PDF页。")
        page=next(iter(pages))
        # Include all current strokes, including those saved after the list was opened.
        selected=[row for row in rows if row['page_number']==page and '__ink__' in row['tags'] and json.loads(row['rects_json'])]
        tag=PREFIX+region_id
        if name is not None:
            name=name.strip()
            if not name:raise ValueError("标记名称不能为空。")
            for row in selected:
                tags=[value for value in row['tags'] if not value.startswith(PREFIX)]+[tag]
                if len(tags)>30:raise ValueError("标记标签数量超过限制。")
                connection.execute("UPDATE highlights SET text=?,tags_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",(name,json.dumps(tags,ensure_ascii=False),row['id']))
        else:
            connection.executemany("DELETE FROM highlights WHERE document_id=? AND id=?",[(document_id,row['id']) for row in selected])
    selected_ids={row['id'] for row in selected}
    return [item for item in repo.list_highlights(document_id) if item['id'] in selected_ids] if name is not None else selected
