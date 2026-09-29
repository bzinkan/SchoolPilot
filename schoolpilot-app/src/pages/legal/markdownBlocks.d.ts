export type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'rule' }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'paragraph'; lines: string[] };

export type InlineToken = { type: 'text' | 'strong' | 'code' | 'link'; value: string };

export function parseMarkdownBlocks(source: string): MarkdownBlock[];
export function parseInline(text: string): InlineToken[];
