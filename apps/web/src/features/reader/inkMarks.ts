import type {Highlight,HighlightRect} from '../../api';
import type {InkSurface} from './inkSurface';
export const INK_REGION_PREFIX='__ink_region:';
export type InkBounds={left:number;right:number;top:number;bottom:number};
export type InkMark={id:string;page:number;surface:InkSurface;name:string;members:Highlight[];bounds:InkBounds};
export function inkRegionId(item:Pick<Highlight,'tags'>){return item.tags?.find(tag=>tag.startsWith(INK_REGION_PREFIX))?.slice(INK_REGION_PREFIX.length);}
export function regionTags(tags:string[],id:string){return [...tags.filter(tag=>!tag.startsWith(INK_REGION_PREFIX)),INK_REGION_PREFIX+id];}
export function inkBounds(points:Pick<HighlightRect,'x'|'y'>[]):InkBounds{
 const xs=points.map(p=>p.x),ys=points.map(p=>p.y);
 return {left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...ys),bottom:Math.max(...ys)};
}
function union(a:InkBounds,b:InkBounds):InkBounds{return {left:Math.min(a.left,b.left),right:Math.max(a.right,b.right),top:Math.min(a.top,b.top),bottom:Math.max(a.bottom,b.bottom)};}
export function nearby(a:InkBounds,b:InkBounds){return Math.max(a.left-b.right,b.left-a.right,0)<=.055 && Math.max(a.top-b.bottom,b.top-a.bottom,0)<=.035;}
function distance(a:InkBounds,b:InkBounds){return Math.hypot((a.left+a.right-b.left-b.right)/2,(a.top+a.bottom-b.top-b.bottom)/2);}
export function closestMark(marks:InkMark[],page:number,surface:InkSurface,bounds:InkBounds){
 return marks.filter(mark=>mark.page===page && mark.surface===surface && nearby(mark.bounds,bounds)).sort((a,b)=>distance(a.bounds,bounds)-distance(b.bounds,bounds))[0];
}
function markName(items:Highlight[],page:number){return items.find(item=>!/^(手写标注 · PDF 第 \d+ 页|标记 \d+|手写标记 · PDF \d+)$/.test(item.text))?.text || `手写标记 · PDF ${page}`;}
export function buildInkMarks(items:Highlight[]):InkMark[]{
 const pages=new Map<number,InkMark>();
 for(const item of items.filter(item=>item.tags?.includes('__ink__')&&item.rects.length)){
  const bounds=inkBounds(item.rects),page=item.page_number,mark=pages.get(page);
  if(mark){mark.members.push(item);mark.bounds=union(mark.bounds,bounds);}
  else pages.set(page,{id:`page_${page}`,page,surface:'page',name:'',members:[item],bounds});
 }
 return [...pages.values()].sort((a,b)=>a.page-b.page).map(mark=>({...mark,name:markName(mark.members,mark.page)}));
}
