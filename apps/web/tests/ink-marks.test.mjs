import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildInkMarks,regionTags} from '../.tmp/tests/features/reader/inkMarks.js';
const stroke=(id,x,y,page=1,tags=['__ink__','pen'])=>({id,page_number:page,tags,text:'手写标注 · PDF 第 1 页',rects:[{x,y,width:.004,height:.004},{x:x+.1,y:y+.1,width:.004,height:.004}]});

test('same-page legacy, distant and margin strokes count as one mark; pages stay separate',()=>{
 const marks=buildInkMarks([stroke('a',.1,.1),stroke('b',.18,.18),stroke('c',.75,.75),stroke('d',.1,.1,2),stroke('e',.1,.1,1,['__ink__','pen','__margin_left__']),stroke('text',.1,.1,1,[])]);
 assert.equal(marks.length,2);assert.equal(marks.find(mark=>mark.members.some(item=>item.id==='a')).members.length,4);
});

test('old region identities merge into one page mark and preserve a custom name',()=>{
 const a=stroke('a',.1,.1,1,regionTags(['__ink__','pen'],'A')),b=stroke('b',.1,.1,1,regionTags(['__ink__','pen'],'B'));
 const c={...stroke('c',.8,.8,1,regionTags(['__ink__','pen'],'A')),text:'公式推导'};
 const marks=buildInkMarks([a,b,c]);assert.equal(marks.length,1);assert.equal(marks[0].name,'公式推导');
 assert.equal(marks[0].members.length,3);
});


test('legacy margin projection is stable and idempotent without mutating saved geometry',async()=>{
 const {marginInkForCanvas,MARGIN_METRIC_TAG}=await import('../.tmp/tests/features/reader/inkSurface.js');
 for(const side of ['left','right']){
  const old=stroke('old',.2,.3,1,['__ink__',`__margin_${side}__`]);
  const mapped=marginInkForCanvas(old);
  assert.equal(mapped.rects[0].x,(side==='left'?.75:0)+.2*.25);
  assert.equal(mapped.rects[0].y,.3);assert.equal(mapped.rects[0].width,.001);
  assert.equal(old.rects[0].x,.2);assert.ok(mapped.tags.includes(MARGIN_METRIC_TAG));
  assert.equal(marginInkForCanvas(mapped),mapped);
 }
});
