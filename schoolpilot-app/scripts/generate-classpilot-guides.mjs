import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  adminGuideMarkdown,
  guideIndexMarkdown,
  teacherGuideMarkdown,
} from "./classpilot-guide-markdown.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = path.resolve(appRoot, "..", "docs");

await Promise.all([
  writeFile(path.join(docsRoot, "CLASSPILOT_USER_GUIDE.md"), guideIndexMarkdown, "utf8"),
  writeFile(path.join(docsRoot, "CLASSPILOT_TEACHER_GUIDE.md"), teacherGuideMarkdown, "utf8"),
  writeFile(path.join(docsRoot, "CLASSPILOT_ADMIN_GUIDE.md"), adminGuideMarkdown, "utf8"),
]);

console.log("Generated ClassPilot guide exports from the in-app source.");
