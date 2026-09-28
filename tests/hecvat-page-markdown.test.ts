import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  parseInline,
  parseMarkdownBlocks,
  type MarkdownBlock,
} from "../schoolpilot-app/src/pages/legal/markdownBlocks.js";

type Block<T extends MarkdownBlock["type"]> = Extract<MarkdownBlock, { type: T }>;

const hecvat = readFileSync(new URL("../docs/HECVAT-LITE.md", import.meta.url), "utf8");

describe("public HECVAT page rendering", () => {
  const blocks = parseMarkdownBlocks(hecvat);
  const tables = blocks.filter((block): block is Block<"table"> => block.type === "table");

  it("renders each numbered section as one well-formed table", () => {
    const sections = blocks.filter(
      (block): block is Block<"heading"> =>
        block.type === "heading" && block.level === 2 && /^Section \d+ /.test(block.text),
    );

    assert.equal(sections.length, 11);
    assert.equal(tables.length, 11);
    for (const table of tables) {
      for (const row of table.rows) assert.equal(row.length, table.header.length, row.join(" | "));
    }
    const paragraphLines = blocks
      .filter((block): block is Block<"paragraph"> => block.type === "paragraph")
      .flatMap((block) => block.lines);
    assert.ok(paragraphLines.every((line) => !line.startsWith("|")));
  });

  it("keeps answers in their own cells", () => {
    const lockout = tables.flatMap((table) => table.rows).find((row) => row[0] === "3.8");

    assert.deepEqual(lockout?.slice(0, 3), ["3.8", "Account lockout after failed attempts?", "**Yes**"]);
  });

  it("turns bold, code and bare links into tokens without trailing punctuation", () => {
    assert.deepEqual(parseInline("**Yes** see `docs/WISP.md` at https://school-pilot.net/privacy."), [
      { type: "strong", value: "Yes" },
      { type: "text", value: " see " },
      { type: "code", value: "docs/WISP.md" },
      { type: "text", value: " at " },
      { type: "link", value: "https://school-pilot.net/privacy" },
      { type: "text", value: "." },
    ]);
  });
});
