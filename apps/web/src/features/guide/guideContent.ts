export type GuideBlock =
  | {kind: 'paragraph' | 'heading' | 'code'; text: string}
  | {kind: 'list'; ordered: boolean; items: string[]};
export type GuideSection = {id: string; title: string; blocks: GuideBlock[]; searchText: string};
export type GuideDocument = {title: string; introduction: string; sections: GuideSection[]};

/** A small, text-only reader for the repository's controlled guide Markdown. No raw HTML. */
export function parseGuide(markdown: string): GuideDocument {
  const document: GuideDocument = {title: '读步天下使用指南', introduction: '', sections: []};
  const intro: string[] = [];
  let section: GuideSection | undefined;
  let paragraph: string[] = [], code: string[] | null = null;
  const flush = () => {
    if (!paragraph.length) return;
    const text = paragraph.join(' ');
    if (section) section.blocks.push({kind: 'paragraph', text}); else intro.push(text);
    paragraph = [];
  };
  for (const source of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = source.trim();
    if (line.startsWith('```')) {
      flush();
      if (code) {section?.blocks.push({kind: 'code', text: code.join('\n')}); code = null;}
      else code = [];
      continue;
    }
    if (code) {code.push(source); continue;}
    if (line.startsWith('# ')) {flush(); document.title = line.slice(2); continue;}
    if (line.startsWith('## ')) {
      flush();
      section = {id: `guide-section-${document.sections.length + 1}`, title: line.slice(3), blocks: [], searchText: ''};
      document.sections.push(section); continue;
    }
    if (line.startsWith('### ')) {flush(); section?.blocks.push({kind: 'heading', text: line.slice(4)}); continue;}
    const item = /^(?:([-*])|\d+\.)\s+(.+)$/.exec(line);
    if (item && section) {
      flush();
      const ordered = !item[1];
      const previous = section.blocks.at(-1);
      if (previous?.kind === 'list' && previous.ordered === ordered) previous.items.push(item[2]);
      else section.blocks.push({kind: 'list', ordered, items: [item[2]]});
      continue;
    }
    if (!line) flush(); else paragraph.push(line);
  }
  flush();
  if (code) section?.blocks.push({kind: 'code', text: code.join('\n')});
  document.introduction = intro.join('\n');
  for (const item of document.sections) item.searchText = [item.title, ...item.blocks.flatMap(block => block.kind === 'list' ? block.items : [block.text])].join(' ').toLocaleLowerCase();
  return document;
}

export function filterGuide(sections: GuideSection[], query: string): GuideSection[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return terms.length ? sections.filter(section => terms.every(term => section.searchText.includes(term))) : sections;
}
