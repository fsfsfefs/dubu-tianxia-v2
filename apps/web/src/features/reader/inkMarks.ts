import type {Highlight,HighlightRect} from '../../api';
import {inkSurface,type InkSurface} from './inkSurface';
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
function markName(items:Highlight[],page:number){return items.find(item=>!/^手写标注 · PDF 第 \d+ 页$/.test(item.text))?.text || `手写标记 · PDF ${page}`;}
export function buildInkMarks(items:Highlight[]):InkMark[]{
 const strokes=items.filter(item=>item.tags?.includes('__ink__') && item.rects.length);
 const known=new Map<string,InkMark>(),legacy:InkMark[]=[];
 for(const item of strokes){
  const region=inkRegionId(item),surface=inkSurface(item),bounds=inkBounds(item.rects);
  if(!region){legacy.push({id:'legacy_'+item.id,page:item.page_number,surface,name:markName([item],item.page_number),members:[item],bounds});continue;}
  const key=`${item.page_number}:${surface}:${region}`,mark=known.get(key);
  if(mark){mark.members.push(item);mark.bounds=union(mark.bounds,bounds);mark.name=markName(mark.members,mark.page);}
  else known.set(key,{id:region,page:item.page_number,surface,name:markName([item],item.page_number),members:[item],bounds});
 }
 // Connected legacy strokes form regions without rewriting the user's old records.
 for(let index=0;index<legacy.length;index++){
  for(let other=index+1;other<legacy.length;){
   const a=legacy[index],b=legacy[other];
   if(a.page===b.page && a.surface===b.surface && nearby(a.bounds,b.bounds)){
    a.members.push(...b.members);a.bounds=union(a.bounds,b.bounds);legacy.splice(other,1);other=index+1;
   }else other++;
  }
 }
 const result=[...known.values()];
 for(const mark of legacy){
  const target=closestMark(result,mark.page,mark.surface,mark.bounds);
  if(target){target.members.push(...mark.members);target.bounds=union(target.bounds,mark.bounds);target.name=markName(target.members,target.page);}
  else {mark.id='legacy_'+mark.members.map(item=>item.id).sort()[0];mark.name=markName(mark.members,mark.page);result.push(mark);}
 }
 return result.sort((a,b)=>a.page-b.page || a.bounds.top-b.bounds.top || a.surface.localeCompare(b.surface));
}
