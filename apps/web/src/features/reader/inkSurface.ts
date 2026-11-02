import type {Highlight} from '../../api';
export type InkSurface='page'|'left'|'right';
export function inkSurface(item:Pick<Highlight,'tags'>):InkSurface{
 return item.tags?.includes('__margin_left__')?'left':item.tags?.includes('__margin_right__')?'right':'page';
}
export function surfaceTags(surface:InkSurface='page'):string[]{return surface==='page'?[]:[`__margin_${surface}__`];}
