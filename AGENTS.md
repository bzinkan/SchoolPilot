# AGENTS.md

All agent guidance for this repository lives in [CLAUDE.md](./CLAUDE.md).

That file covers the project overview, repository structure, development
commands, architecture notes, environment variables, secrets hygiene, CI,
school lifecycle/inquiry rules, and deployment procedures. It applies to any
coding agent working in this repo, not just Claude Code — read it before making
changes.

Important boundary: SchoolPilot deploys the API and web app only. The
ClassPilot Chrome extension is released separately from the `ClassPilot` repo
through a versioned Chrome Web Store upload.

ClassPilot Teacher Dashboard boundary: teacher classroom actions must use the
server-enforced command contract documented in `CLAUDE.md`. Do not expose
device IDs in teacher-facing API/UI flows, and never treat missing targets as a
class-wide or school-wide broadcast.

ClassPilot Rosters boundary: the Rosters tab is not a student-to-device
assignment surface. Student roster work uses school student records; Chromebook
status work uses extension/Chromebook records. Do not reintroduce `deviceId`
as part of student roster create/edit flows.
