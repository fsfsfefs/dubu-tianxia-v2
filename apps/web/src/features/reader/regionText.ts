type TextFragment = {text: string; left: number; right: number; top: number; height: number};

export function joinRegionLines(fragments: TextFragment[]): string {
  const rows: {center: number; height: number; fragments: TextFragment[]}[] = [];
  const center = (fragment: TextFragment) => fragment.top + fragment.height / 2;
  for (const fragment of [...fragments].sort((a, b) => center(a) - center(b))) {
    const row = rows.at(-1);
    if (row && Math.abs(center(fragment) - row.center) <= Math.min(row.height, fragment.height) * .45) {
      row.fragments.push(fragment);
    } else {
      rows.push({center: center(fragment), height: fragment.height, fragments: [fragment]});
    }
  }
  return rows.map(row => {
    let line = '';
    let previous: TextFragment | undefined;
    for (const fragment of row.fragments.sort((a, b) => a.left - b.left)) {
      if (previous && !/\s$/.test(line) && !/^\s/.test(fragment.text)
          && fragment.left - previous.right > Math.min(previous.height, fragment.height) * .16) {
        line += ' ';
      }
      line += fragment.text;
      previous = fragment;
    }
    return line.trim();
  }).filter(Boolean).join('\n');
}
