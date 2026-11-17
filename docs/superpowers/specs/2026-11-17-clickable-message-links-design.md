# Clickable message links

Make pasted web addresses clickable in teacher conversations/history and the student's chat, message modal and extension popup. Ordinary links open a new tab with no opener or referrer. Existing Focus, Flight Path and school restrictions still decide whether a destination is allowed; a message does not grant browsing permission.

Use plain-text URL tokenization and real anchor elements rather than Markdown/HTML message input. Recognize explicit HTTP(S) URLs and www. addresses, preserve visible message text, whitespace, query strings and fragments, and leave surrounding prose punctuation outside the link. Reject credentials and non-web schemes. Keep stored/transmitted messages unchanged. No automatic opening, fetching, previews, tracking or permission changes.

Preserve terminal punctuation in a query or fragment because it may be meaningful URL data (for example a factorial query ending in `!`). Explicit enclosing quotes/brackets identify outside prose. Unquoted query punctuation is intentionally kept rather than guessed away. Internal apostrophes and balanced URL parentheses remain part of the URL; matching enclosing straight/curly quotes do not.

The teacher view uses a small React renderer shared by live chat and transcripts. The extension uses a single DOM helper in its three message surfaces, with the helper included in normal and recovery injection paths. Literal fixtures and native browser tests pin equivalent parsing, safe text, keyboard/new-tab behavior and continued filtering.

This is a small presentation change. The sensible alternative, rendering Markdown/HTML, adds an input format and unnecessary injection risk; retaining copy/paste does not satisfy the request. No new runtime dependency is needed. These implementation choices are the agent's defaults for the user's explicit clickable-link request.

Preserve canonical 3.0.7 ZIP/tag/source. Prepare a separately versioned 3.0.8 package under ClassPilot/dist. SchoolPilot deploys only the API/web application; no Store upload or school capability activation is part of this change.
