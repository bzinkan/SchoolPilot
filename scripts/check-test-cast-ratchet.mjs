#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const baseline = JSON.parse(readFileSync(join(root, "tests", "unsafe-cast-baseline.json"), "utf8"));
const counts = { asAny: 0, asUnknownAs: 0, tsIgnore: 0, tsExpectError: 0 };
const patterns = {
  asAny: /\bas any\b/g,
  asUnknownAs: /\bas unknown as\b/g,
  tsIgnore: /@ts-ignore\b/g,
  tsExpectError: /@ts-expect-error\b/g,
};

function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) scan(path);
    else if (/\.ts$/.test(entry.name)) {
      const source = readFileSync(path, "utf8");
      for (const [name, pattern] of Object.entries(patterns)) {
        counts[name] += (source.match(pattern) || []).length;
      }
    }
  }
}
scan(join(root, "tests"));

const increases = Object.keys(counts).filter((name) => counts[name] > baseline[name]);
if (increases.length > 0) {
  for (const name of increases) {
    process.stderr.write(`Unsafe test cast ratchet increased: ${name} ${baseline[name]} -> ${counts[name]}\n`);
  }
  process.exit(1);
}
process.stdout.write(`Unsafe test cast ratchet OK: ${JSON.stringify(counts)}\n`);
