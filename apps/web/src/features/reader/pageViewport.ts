export function pageAtViewportY(stage: HTMLElement, y: number, nearest = false) {
  const pages = stage.children;
  let low = 0, high = pages.length - 1;
  let above: {page: HTMLElement; bounds: DOMRect} | undefined;
  let below: {page: HTMLElement; bounds: DOMRect} | undefined;
  while (low <= high) {
    const index = (low + high) >>> 1;
    const page = pages[index] as HTMLElement;
    if (!page.dataset.pageNumber) {high = index - 1; continue;} // End-of-document spacer.
    const bounds = page.getBoundingClientRect();
    if (bounds.bottom < y) {above = {page, bounds}; low = index + 1;}
    else if (bounds.top > y) {below = {page, bounds}; high = index - 1;}
    else return {page, bounds};
  }
  if (!nearest) return undefined;
  if (!above || !below) return above || below;
  return y - above.bounds.bottom <= below.bounds.top - y ? above : below;
}

const pageObservers = new WeakMap<HTMLElement, {
  observer: IntersectionObserver;
  listeners: Map<Element, (visible: boolean) => void>;
}>();

export function observeNearbyPage(root: HTMLElement, page: HTMLElement, listener: (visible: boolean) => void) {
  let group = pageObservers.get(root);
  if (!group) {
    const listeners = new Map<Element, (visible: boolean) => void>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
    }, {root, rootMargin: '1600px 10000px'});
    group = {observer, listeners};
    pageObservers.set(root, group);
  }
  const {observer, listeners} = group;
  listeners.set(page, listener);
  observer.observe(page);
  return () => {
    observer.unobserve(page);
    listeners.delete(page);
    if (!listeners.size) {observer.disconnect(); pageObservers.delete(root);}
  };
}
