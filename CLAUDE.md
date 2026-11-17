# aia-studio

aia-studio is being rebuilt from scratch, in parts. Read [docs/rebuild.md](docs/rebuild.md) first: what is decided,
what is still open and the build plan. Don't build a part whose topic is still open there.

## Language

- **Everything in the project is in English**: the editor UI (HTML, `title`/`aria-label`, menus, notices, help),
  code (identifiers, file names), comments, error messages, command help and the docs in use (`README.md`,
  `docs/rebuild.md`). UI terms follow Rive/Moho (Layers, Assets, Bone, Pose, Setup, Parameters, Switch…).
- **The conversation with the user stays in Spanish.**
- The records of the previous version in `docs/v1/` stay as they were written (partly in Spanish). They are
  references, not the current design.

## Checks

- `npm test` and `npm run typecheck` (tsc over JS with JSDoc) must pass before each commit. The `.githooks/pre-commit`
  hook runs both; enable it once per clone with `git config core.hooksPath .githooks`.
- Documents live in `documents/` (ignored by git; never commit it). To try something in the browser, use `prueba_*`
  documents and delete them afterwards.

## How we work

- **One chat at a time**, working in this folder on the `rebuild` branch, one task after another. No extra sessions,
  worktrees or parallel work unless the user asks. The editor preview runs on **localhost:5174** only.
- `docs/rebuild.md` is the shared memory: decisions, the plan and each step go there, so a new chat can pick up
  without the old conversation.
- **Agents** (`.claude/agents/`), used when closing a part, not for everyday edits:
  - `architecture`: does the architecture fit the project's size and the decisions (layers, one operations engine,
    the schema as the source, dead code, over-engineering).
  - `auditor`: bugs and edge cases with a failure scenario, plus the project's rules.
  - `ai-tester`: an outside AI with only the `aia` CLI builds something and reports what confused it, and the
    editor ↔ AI parity; its report goes to `docs/ai-tests/`.
