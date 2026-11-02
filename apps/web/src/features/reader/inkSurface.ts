import type {Highlight} from '../../api';
export type InkSurface='page'|'left'|'right';
export function inkSurface(item:Pick<Highlight,'tags'>):InkSurface{
 return item.tags?.includes('__margin_left__')?'left':item.tags?.includes('__margin_right__')?'right':'page';
}
export function surfaceTags(surface:InkSurface='page'):string[]{return surface==='page'?[]:[`__margin_${surface}__`];}

export const MARGIN_METRIC_TAG='__margin_metric_v1__';
/** Legacy margins did not store their viewport width. Use a stable half-page reference. */
export function marginInkForCanvas(item:Highlight):Highlight{
 if(inkSurface(item)==='page'||item.tags.includes(MARGIN_METRIC_TAG))return item;
 const left=inkSurface(item)==='left';
 return {...item,tags:[...item.tags,MARGIN_METRIC_TAG],rects:item.rects.map(p=>({...p,x:(left?.75:0)+p.x*.25,width:p.width*.25}))};
}
