# aia-studio

## Language

- **Everything in the project is in English**: the editor UI (HTML, `title`/`aria-label`, menus, notices, help, history
  notes the user sees), code (identifiers, file names), comments, error messages, the schema (`description` and
  `help`), the AI guide (`src/core/guide.js`), MCP tool descriptions and responses, and the docs in use
  (`README.md`, `docs/plan.md`, `docs/sintesis.md`, `docs/decision-animacion.md`). UI terms follow Rive/Moho (Layers,
  Assets, Bone, Pose, Setup, Parameters, Switch…).
- **The conversation with the user stays in Spanish.**
- Historical records stay as they were written, in Spanish: `docs/auditorias.md`, `docs/pruebas-ia/`,
  `docs/investigacion/`. New entries in them can be written in English.
- Schema: `description` is the long text for the AI guide; `help` is the short help the inspector shows. Every new type
  and property carries both (a test requires it).

## Checks

- `npm test` and `npm run typecheck` (tsc over JS with JSDoc) must pass before each commit.
- Documents live in `documents/` (ignored by git; never commit it). To try something in the browser, use `prueba_*`
  documents and delete them afterwards.
- `git config blame.ignoreRevsFile .git-blame-ignore-revs` skips the mechanical rename commits in `git blame`.
