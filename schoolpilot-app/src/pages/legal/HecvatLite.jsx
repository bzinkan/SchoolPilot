import { Fragment, useEffect } from 'react';
import hecvatMarkdown from '../../../../docs/HECVAT-LITE.md?raw';
import { parseInline, parseMarkdownBlocks } from './markdownBlocks';

const BLOCKS = parseMarkdownBlocks(hecvatMarkdown);

const PRINT_STYLES = `
@page { size: letter; margin: 0.5in; }
@media print {
  html, body { background: #fff !important; }
  tr { break-inside: avoid; }
  h2 { break-after: avoid; }
}
`;

function Inline({ text }) {
  return parseInline(text).map((token, index) => {
    if (token.type === 'strong') return <strong key={index} className="font-semibold text-slate-900">{token.value}</strong>;
    if (token.type === 'code') {
      return <code key={index} className="rounded bg-slate-100 px-1 py-0.5 text-[0.85em] text-slate-800">{token.value}</code>;
    }
    if (token.type === 'link') {
      return <a key={index} href={token.value} className="break-all text-amber-700 underline hover:text-amber-800">{token.value}</a>;
    }
    return <Fragment key={index}>{token.value}</Fragment>;
  });
}

function Block({ block }) {
  switch (block.type) {
    case 'heading':
      if (block.level === 1) return <h1 className="mb-4 text-3xl font-bold text-slate-900 print:text-2xl"><Inline text={block.text} /></h1>;
      if (block.level === 2) return <h2 className="mb-3 mt-8 text-xl font-semibold text-slate-900 print:mt-5"><Inline text={block.text} /></h2>;
      return <h3 className="mb-2 mt-6 text-lg font-medium text-slate-800"><Inline text={block.text} /></h3>;
    case 'rule':
      return <hr className="my-6 border-slate-200 print:my-3" />;
    case 'table':
      return (
        <div className="overflow-x-auto rounded-lg border border-slate-200 print:overflow-visible">
          <table className="min-w-full text-left text-sm print:text-[10px]">
            <thead className="bg-slate-100">
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index} className="px-3 py-2 font-semibold text-slate-700 print:px-2 print:py-1"><Inline text={cell} /></th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-t border-slate-200 align-top">
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="px-3 py-2 text-slate-700 print:px-2 print:py-1"><Inline text={cell} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'list': {
      const ListTag = block.ordered ? 'ol' : 'ul';
      return (
        <ListTag className={`${block.ordered ? 'list-decimal' : 'list-disc'} space-y-2 pl-6 text-slate-700`}>
          {block.items.map((item, index) => <li key={index}><Inline text={item} /></li>)}
        </ListTag>
      );
    }
    default:
      return (
        <p className="my-3 leading-relaxed text-slate-700">
          {block.lines.map((line, index) => (
            <Fragment key={index}>
              {index > 0 && <br />}
              <Inline text={line} />
            </Fragment>
          ))}
        </p>
      );
  }
}

export default function HecvatLite() {
  useEffect(() => {
    const previousTitle = document.title;
    // Browsers use the title as the default "Save as PDF" file name.
    document.title = 'Schoolpilot HECVAT Lite Self-Assessment';
    return () => {
      document.title = previousTitle;
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-8 print:bg-white print:p-0">
      <style>{PRINT_STYLES}</style>

      <div className="mx-auto mb-4 flex max-w-4xl items-center justify-between gap-4 print:hidden">
        <a href="/security" className="text-sm text-slate-600 hover:text-slate-900">
          ← Back to Security
        </a>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
        >
          Print or save as PDF
        </button>
      </div>

      <main className="mx-auto max-w-4xl rounded-lg bg-white p-6 shadow-sm sm:p-10 print:max-w-none print:rounded-none print:p-0 print:shadow-none">
        {BLOCKS.map((block, index) => <Block key={index} block={block} />)}
      </main>
    </div>
  );
}
