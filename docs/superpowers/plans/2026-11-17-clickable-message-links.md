# Clickable Message Links Implementation Plan

> **For agentic workers:** Use disjoint teacher-web and extension ownership, TDD, then independent review. Steps use checkbox syntax for tracking.

**Goal:** Clicking a web address in ClassPilot messages opens it normally without copy/paste.

**Architecture:** Pure URL tokenization feeds escaped React text/anchors on the web and a shared text-node/anchor helper in the extension. Server payloads and browsing policies stay authoritative.

**Tech Stack:** React/Vite, JavaScript, Chrome MV3, node:test, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-17-clickable-message-links-design.md`.

## Global constraints

- Only HTTP(S) and www. web links; www. uses HTTPS. No credentialed or executable URLs.
- Preserve message text, whitespace, URL query/fragment and surrounding punctuation; no HTML interpretation.
- Open only on user activation, in a new tab with noopener/noreferrer; existing filters continue applying.
- No message storage, authorization, chat lifecycle or command-contract change.
- Keep 3.0.7 immutable; package 3.0.8 separately. No Store upload or feature activation.

## Review focus

1. A Classroom URL with query parameters stays complete despite visual wrapping.
2. Multiple links, newlines and balanced parentheses retain surrounding prose.
3. HTML, script/data/file URLs and credentials cannot become executable markup.
4. Tab/Enter and mouse clicks open a new tab without an opener; chat stays usable.
5. Student links remain blocked when Focus/Flight Paths forbid their destination.

### Task 1: Teacher web

**Files:** `lib/messageLinks.js`, `components/MessageText.jsx`, `components/ChatThread.jsx`, message parser/native chat tests under `schoolpilot-app/scripts`.

**Interface:** `splitMessageLinks(value)` returns `{text, href}` segments, with `href: null` for plain text. Renderer uses `<a target="_blank" rel="noopener noreferrer">` only for validated links. Shared literal fixtures define parsing expectations for both repositories.

- [x] Write parser and real message-view tests; capture RED for missing links/query handling/safe text.
- [x] Implement the pure helper and shared bubble renderer so transcripts inherit it.
- [x] Verify native click/keyboard/new-tab behavior, text safety and message lifecycle regressions; run frontend lint/build and required dashboard gates.

### Task 2: Student extension

**Files:** shared message DOM helper, content chat/modal, popup, manifest/recovery load order, release guards and real-Chrome message tests in ClassPilot.

- [ ] Read current main guidance and create an isolated task worktree; preserve primary user work.
- [ ] Run new behavioral tests RED, implement the shared DOM helper and all three consumers, then run GREEN.
- [ ] Test live/modal/popup links, query strings, escaped HTML, user-only activation, filtering and content-script recovery.
- [ ] Prepare version 3.0.8, run complete required extension checks and canonical packaging, inspect the ZIP, and preserve 3.0.7 hashes.

### Task 3: Review and release

- [ ] Independent review of web/extension behavior and URL safety; resolve material findings.
- [ ] Commit/push, confirm CI and merge both repositories; guarded SchoolPilot deployment from clean green main.
- [ ] Save 3.0.8 under ClassPilot/dist, preserve receipts and old artifacts, verify serving web assets and remove only task branches/worktrees. No Store upload.
