# Updates

## 2026-08-06 — add prepare script for git installs
Git installs (npm/bun from github:dested/video-to-prompt) got no dist because
only prepublishOnly built; `prepare` now runs the build on install. Lets
consumers (bx) drop their self-healing in-place builds eventually.
Touched: package.json, updates.md

## 2026-08-06 — extract video-to-prompt from Handback
Ported the distill pipeline out of handback/src/lib/capture into a standalone public library:
upload/auth/pending stripped, Transcriber/Polisher plug points added, report wording moved to
ReportOptions. Typecheck + build green; repo created at dested/video-to-prompt.
Touched: everything (initial commit)
