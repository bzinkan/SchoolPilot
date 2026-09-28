// Parses the Markdown subset our own public docs use (headings, rules, tables,
// lists, paragraphs, bold, code, bare links) into plain objects for React.
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const RULE_RE = /^(-{3,}|\*{3,}|_{3,})$/;
const LIST_ITEM_RE = /^([-*]|\d+\.)\s+(.*)$/;
const TABLE_DIVIDER_CELL_RE = /^:?-{3,}:?$/;
const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s)|]*[^\s).,;:|])/g;

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isTableDivider(cells) {
  return cells.length > 0 && cells.every((cell) => TABLE_DIVIDER_CELL_RE.test(cell));
}

function startsBlock(trimmed) {
  return HEADING_RE.test(trimmed) || RULE_RE.test(trimmed) || trimmed.startsWith('|') || LIST_ITEM_RE.test(trimmed);
}

export function parseMarkdownBlocks(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const trimmed = lines[index].trim();

    if (trimmed === '') {
      index += 1;
      continue;
    }

    const heading = HEADING_RE.exec(trimmed);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    if (RULE_RE.test(trimmed)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    if (trimmed.startsWith('|')) {
      const rows = [];
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      const [header, ...rest] = rows;
      const body = rest.length > 0 && isTableDivider(rest[0]) ? rest.slice(1) : rest;
      blocks.push({ type: 'table', header, rows: body });
      continue;
    }

    const firstItem = LIST_ITEM_RE.exec(trimmed);
    if (firstItem) {
      const ordered = firstItem[1] !== '-' && firstItem[1] !== '*';
      const items = [];
      while (index < lines.length) {
        const item = LIST_ITEM_RE.exec(lines[index].trim());
        if (!item || (item[1] !== '-' && item[1] !== '*') !== ordered) break;
        items.push(item[2]);
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraph = [];
    while (index < lines.length) {
      const line = lines[index].trim();
      if (line === '' || startsBlock(line)) break;
      paragraph.push(line);
      index += 1;
    }
    blocks.push({ type: 'paragraph', lines: paragraph });
  }

  return blocks;
}

export function parseInline(text) {
  const tokens = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    if (match.index > cursor) tokens.push({ type: 'text', value: text.slice(cursor, match.index) });
    const value = match[0];
    if (value.startsWith('**')) tokens.push({ type: 'strong', value: value.slice(2, -2) });
    else if (value.startsWith('`')) tokens.push({ type: 'code', value: value.slice(1, -1) });
    else tokens.push({ type: 'link', value });
    cursor = match.index + value.length;
  }
  if (cursor < text.length) tokens.push({ type: 'text', value: text.slice(cursor) });
  return tokens;
}
