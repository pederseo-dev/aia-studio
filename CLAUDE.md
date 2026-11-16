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

- `npm test` and `npm run typecheck` (tsc over JS with JSDoc) must pass before each commit.
- Documents live in `documents/` (ignored by git; never commit it). To try something in the browser, use `prueba_*`
  documents and delete them afterwards.
