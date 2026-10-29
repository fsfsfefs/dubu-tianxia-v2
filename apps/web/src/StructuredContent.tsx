import React from 'react';

type ContentBlock =
  | {kind: 'heading'; text: string}
  | {kind: 'paragraph'; text: string}
  | {kind: 'quote'; text: string}
  | {kind: 'list'; items: string[]}
  | {kind: 'key'; label: string; text: string}
  | {kind: 'table'; headers: string[]; rows: string[][]};

const knownHeadings = new Set([
  '一句话结论', '核心结论', '关键依据', '详细解释', '教材依据', '外部补充', '需要注意', '信息边界',
  '全书定位', '全书结论', '总体知识地图', '各大章内容与关系', '大章关系', '核心主线', '学习与复习路线',
  '大章定位', '大章结论', '子章结构与关系', '子章关系', '核心知识体系', '本章定位', '本节定位', '本节结论', '知识结构',
  '知识骨架', '核心概念与关系', '核心概念', '重点与易混点', '学习重点', '易混点', '跨章易混点',
  '复习提纲', '复习路径', '复习路线', '例子', '应用', '对比', '总结', '摘要',
]);

function cleanInline(value: string): string {
  return value
    .replace(/^\s{0,3}#{1,6}\s*/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function plainInline(value: string): string {
  return cleanInline(value)
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\x60([^\x60]+)\x60/g, '$1')
    .trim();
}

function mergedParagraph(lines: string[]): string {
  return lines.join(' ')
    .replace(/([\u3400-\u9fff，。！？；：、])\s+(?=[\u3400-\u9fff])/g, '$1')
    .trim();
}

function cleanListItem(value: string): string {
  let cleaned = cleanInline(value).replace(/^\d+[.)、]\s*/, '');
  // Older model replies occasionally emitted list markers such as
  // `1. *标题**`. Repair those remnants so users never see raw Markdown.
  if (/^\*[^*].*\*\*$/.test(cleaned)) cleaned = '*' + cleaned;
  return cleaned
    .replace(/^(\*{1,2})\s*\d+[.)、．]\s*/, '$1')
    .replace(/^(\*{1,2})?\s*\d+(?![\d.])(?:[.)、．]\s*|\s*(?=[\u3400-\u9fff]))/, '$1');
}

type ConceptGroup = {title?: string; details: string[]};

function isConceptTitle(value: string): boolean {
  const text = plainInline(value);
  return text.length >= 2
    && text.length <= 22
    && !/[，。！？；：、,.;:!?\[\]〔〕]/.test(text)
    && !/^(?:第?\d+页|PDF|网络\d+)$/i.test(text);
}

function groupConceptItems(items: string[]): ConceptGroup[] | null {
  if (!items.some(isConceptTitle)) return null;
  const groups: ConceptGroup[] = [];
  for (const item of items) {
    if (isConceptTitle(item)) {
      groups.push({title: item, details: []});
      continue;
    }
    const current = groups.at(-1);
    if (current?.title) current.details.push(item);
    else if (current) current.details.push(item);
    else groups.push({details: [item]});
  }
  return groups;
}

function tableCells(value: string): string[] {
  return value.split('|').map(cleanInline).filter(Boolean);
}

function isTableDivider(value: string): boolean {
  const cells = value.split('|').map(cell => cell.trim()).filter(Boolean);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

export function parseStructuredContent(value: string | undefined): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const paragraph: string[] = [];
  let listItems: string[] = [];
  const lines = (value || '').replace(/\r/g, '').split('\n');
  const flushParagraph = () => {
    const text = mergedParagraph(paragraph.splice(0));
    if (text) blocks.push({kind: 'paragraph', text});
  };
  const flushList = () => {
    if (listItems.length) blocks.push({kind: 'list', items: listItems});
    listItems = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim();
    if (!raw || raw.startsWith(String.fromCharCode(96, 96, 96))) {
      flushParagraph();
      flushList();
      continue;
    }

    if (raw.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1].trim())) {
      flushParagraph();
      flushList();
      const headers = tableCells(raw);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && !isTableDivider(lines[index].trim())) {
        const cells = tableCells(lines[index]);
        if (cells.length) rows.push(cells);
        index += 1;
      }
      index -= 1;
      if (rows.length) blocks.push({kind: 'table', headers, rows});
      continue;
    }
    if (isTableDivider(raw)) continue;

    const bracketHeading = raw.match(/^【([^】]{2,24})】\s*$/);
    const markdownHeading = raw.match(/^#{1,6}\s*(.+)$/);
    const possibleHeading = plainInline(bracketHeading?.[1] || markdownHeading?.[1] || raw).replace(/[：:]$/, '');
    if (bracketHeading || markdownHeading || knownHeadings.has(possibleHeading)) {
      flushParagraph();
      flushList();
      blocks.push({kind: 'heading', text: possibleHeading});
      continue;
    }

    if (/^>\s?/.test(raw)) {
      flushParagraph();
      flushList();
      blocks.push({kind: 'quote', text: cleanInline(raw)});
      continue;
    }

    if (raw.includes('|')) {
      const cells = tableCells(raw);
      if (cells.length > 1) {
        flushParagraph();
        flushList();
        if (cells.length === 2) blocks.push({kind: 'key', label: cells[0], text: cells[1]});
        else blocks.push({kind: 'table', headers: [], rows: [cells]});
        continue;
      }
    }

    const listMatch = raw.match(/^\s*(?:[-*+]|\d+[.)、]|[①②③④⑤⑥⑦⑧⑨⑩])\s*(.+)$/);
    if (listMatch) {
      flushParagraph();
      listItems.push(cleanListItem(listMatch[1]));
      continue;
    }

    const cleaned = cleanInline(raw);
    const keyMatch = plainInline(cleaned).match(/^([^：:]{2,24})[：:]\s*(.+)$/);
    if (keyMatch && !/[。！？；]$/.test(keyMatch[1])) {
      flushParagraph();
      flushList();
      const divider = cleaned.search(/[：:]/);
      blocks.push({kind: 'key', label: cleanInline(cleaned.slice(0, divider)), text: cleanInline(cleaned.slice(divider + 1))});
      continue;
    }

    flushList();
    paragraph.push(cleaned);
  }
  flushParagraph();
  flushList();
  return blocks;
}

function escapedPattern(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
}

function MarkupText({text}: {text: string}) {
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|\x60[^\x60]+\x60|\[[^\]\n]{1,80}\]|〔[^〕\n]{1,80}〕)/g;
  const parts = text.split(pattern).filter(Boolean);
  return <>{parts.map((part, index) => {
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) {
      return <strong className="content-emphasis" key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('\x60') && part.endsWith('\x60')) return <code key={index}>{part.slice(1, -1)}</code>;
    if ((part.startsWith('[') && part.endsWith(']')) || (part.startsWith('〔') && part.endsWith('〕'))) {
      return <span className="content-citation" key={index}>{part.slice(1, -1)}</span>;
    }
    return <React.Fragment key={index}>{part.replace(/~~(.*?)~~/g, '$1')}</React.Fragment>;
  })}</>;
}

function RichText({text, highlight}: {text: string; highlight?: string}) {
  if (!highlight?.trim()) return <MarkupText text={text}/>;
  const normalized = plainInline(text);
  const pattern = highlight.trim().split(/\s+/).filter(Boolean).map(escapedPattern).join('\\s+');
  const match = pattern ? new RegExp(pattern).exec(normalized) : null;
  if (!match || match.index === undefined) return <MarkupText text={text}/>;
  return <>{normalized.slice(0, match.index)}<mark className="returned-summary-text" data-summary-return="true">{normalized.slice(match.index, match.index + match[0].length)}</mark>{normalized.slice(match.index + match[0].length)}</>;
}

function StructuredContent({value, highlight, variant}: {value: string | undefined; highlight?: string; variant: 'summary' | 'answer'}) {
  const blocks = parseStructuredContent(value);
  if (!blocks.length) return null;
  let sectionNumber = 0;
  let leadUsed = false;
  return <div className={'structured-document ' + variant + '-document'}>
    {blocks.map((block, index) => {
      if (block.kind === 'heading') {
        sectionNumber += 1;
        return <h3 key={index}>{variant === 'summary' && <span>{String(sectionNumber).padStart(2, '0')}</span>}<RichText text={block.text} highlight={highlight}/></h3>;
      }
      if (block.kind === 'list') {
        const conceptGroups = groupConceptItems(block.items);
        if (conceptGroups) return <div className="concept-list" key={index}>{conceptGroups.map((group, groupIndex) => group.title
          ? <article className="concept-card" key={groupIndex}>
              <h4><RichText text={group.title} highlight={highlight}/></h4>
              <div>{group.details.map((detail, detailIndex) => <p key={detailIndex}><RichText text={detail} highlight={highlight}/></p>)}</div>
            </article>
          : <ul className="content-points" key={groupIndex}>{group.details.map((detail, detailIndex) => <li key={detailIndex}><RichText text={detail} highlight={highlight}/></li>)}</ul>
        )}</div>;
        return <ul className="content-points" key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}><RichText text={item} highlight={highlight}/></li>)}</ul>;
      }
      if (block.kind === 'key') {
        const vertical = plainInline(block.label).length > 15 || plainInline(block.text).length < plainInline(block.label).length;
        return <section className={'summary-key-point ' + (vertical ? 'vertical' : '')} key={index}><strong><RichText text={block.label} highlight={highlight}/></strong><p><RichText text={block.text} highlight={highlight}/></p></section>;
      }
      if (block.kind === 'quote') return <blockquote key={index}><RichText text={block.text} highlight={highlight}/></blockquote>;
      if (block.kind === 'table') return <section className="content-table" key={index}>
        {block.rows.map((row, rowIndex) => {
          const titleIndex = row.length > 2 ? 1 : 0;
          const detailStart = row.length > 2 ? 2 : 1;
          return <article className="content-table-row" key={rowIndex}>
            <header>{titleIndex > 0 && <span><RichText text={row[0]} highlight={highlight}/></span>}<strong><RichText text={row[titleIndex] || row[0]} highlight={highlight}/></strong></header>
            <section className="content-table-details">
              {row.slice(detailStart).map((cell, cellIndex) => <div key={cellIndex}>{block.headers[detailStart + cellIndex] && <small>{plainInline(block.headers[detailStart + cellIndex])}</small>}<p><RichText text={cell} highlight={highlight}/></p></div>)}
            </section>
          </article>;
        })}
      </section>;
      const lead = !leadUsed;
      leadUsed = true;
      return <p className={lead ? 'structured-lead' : undefined} key={index}><RichText text={block.text} highlight={highlight}/></p>;
    })}
  </div>;
}

export function SummaryContent({value, highlight}: {value: string | undefined; highlight?: string}) {
  return <StructuredContent value={value} highlight={highlight} variant="summary"/>;
}

export function AnswerContent({value}: {value: string | undefined}) {
  return <StructuredContent value={value} variant="answer"/>;
}
