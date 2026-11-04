export function formatCardQuestion(question: string): string {
  if (/[\r\n]/.test(question)) return question;

  // Older cards stored the whole question on a single line.
  const options = [...question.matchAll(/(?:^|\s)([A-D])(?:[.．、:：)]|(?=\s|\d+\s*项))/g)];
  const optionLabels = options.map(match => match[1]).join('');
  const optionBreaks = /^(ABC|ABCD)$/.test(optionLabels) ? options.map(match => match.index) : [];
  const stem = question.slice(0, optionBreaks[0] ?? question.length);
  const statements = [...stem.matchAll(/[①②③④⑤⑥⑦⑧⑨⑩]/g)];
  const numbered = statements.length > 1 && statements.every((match, index) =>
    match[0] === '①②③④⑤⑥⑦⑧⑨⑩'[index]
    && (statements[index + 1]?.index ?? stem.length) - match.index > 1);
  const offsets = [0, ...(numbered ? statements.map(match => match.index) : []), ...optionBreaks, question.length];
  return offsets.slice(1).map((end, index) =>
    question.slice(offsets[index], end).trim(),
  ).filter(Boolean).join('\n');
}
