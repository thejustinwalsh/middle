<!-- AGENT-QUEUE-STATE v1 -->
<!-- generated: 2026-05-14T09:15:00Z · run: 7f3a9c21 · interval: 15m -->
<!-- owners: recommender=full-body, dispatcher=in-flight,rate-limits,slot-usage -->

## Ready to dispatch

| Rank | Epic | Adapter | Sub-issues | Reason |
| --- | --- | --- | --- | --- |
| 1 | #42 Recommender workflow | claude | 6 | `unblocks dogfooding`; all blockers cleared |
| 2 | #60 CodexAdapter | codex | 4 | second adapter for parity testing |
| 3 | #54 Dashboard | claude | 6 | operator visibility; no code deps on in-flight work |

## Needs human input

- **#7 ready for review** — PR #69 open, all 5 sub-issues verified · [link](https://github.com/thejustinwalsh/middle/pull/69)
- **#38 ambiguous criteria** — acceptance criteria do not specify a retry budget · [link](https://github.com/thejustinwalsh/middle/issues/38)

## Blocked

- **#48** waiting on #42 · auto-dispatch needs the recommender to populate Ready
- **#66** waiting on `upstream bunqueue release` · retention cron API lands in bunqueue 2.8

## In-flight

- **#64** · claude · sub-issue 2/5 · last heartbeat 42s ago · [tmux: middle-epic-64]

## Excluded

- **#3** assigned to human — maintainer is hand-tuning the recommender prompt
- **#59** out of scope — webview-bun windowed mode deferred past v1

## Rate limits

- claude: AVAILABLE
- codex: RATE LIMITED until 2026-05-14T10:30:00Z (in 1h 15m)
- github: 4612/5000 req/hr · resets in 27m

## Slot usage

- claude: 1/2
- codex: 0/1
- total: 1/3
- global: 1/4

<!-- /AGENT-QUEUE-STATE -->