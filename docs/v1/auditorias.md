# Auditorías

Registro de las auditorías del agente `auditor` (`.claude/agents/auditor.md`). Cada auditoría revisa lo que cambió
desde el último commit auditado; al terminar se agrega una fila acá.

| Fecha | Rango auditado | Hallazgos | Arreglos | Notas |
| --- | --- | --- | --- | --- |
| 2026-11-04 | `main..1997421` (proyecto completo) | 4 importantes, 7 menores, 4 huecos de paridad | `40df396..02e9a50` | Primera auditoría: unos 7 minutos, porque cubrió todo el proyecto. |
| 2026-11-05 | `1997421..1224bc3` (17 commits) | 2 importantes, 5 menores, 1 hueco de paridad | `d335c48..e4768d0` | Incremental: unos 4 minutos. Sin restos de `create_switch_control`; los arreglos de la primera quedaron cerrados. |
| 2026-11-05 | `1224bc3..493d2a7` (12 commits, fase 5) | 4 importantes, 6 menores, 6 huecos de paridad | `b8e8ad3..c21ce2d` | Incremental. El núcleo de clips respeta la decisión; fallas en el borde del loop, autokey con drivers y drivers que tapan pistas del clip. |
| 2026-11-06 | `493d2a7..6538a4d` (14 commits: arreglos fase 5, timeline, params solo en Puppet) | 2 importantes, 6 menores, 3 huecos de paridad | `a832d75..3d01d7f` | Arreglos de la fase 5 cerrados. Restos de «params en Animate» en guía, esquema, MCP y docs; drivers que suman en escenas sin control. |
| 2026-11-11 | `ff58500..b16abcb` (7 commits, fase 6: Puppet en vivo) | 2 graves, 4 medias, 7 menores, 5 huecos de paridad | `e602421` | Fundido cruzado que dejaba asomar el montaje y `auto: always` que sonaba una vez. Paridad: «AI view» (manifiesto) y «Stop all» en el editor; `auto: false` del preview queda solo en el MCP. |
| 2026-11-13 | `42ed7cf..178bdc1` (41 commits: Puppet UI, architecture stages 1-2, images as a layer, lock, translation to English) | 1 important, 7 minor, 5 parity gaps | `af86941` | The translation broke no contract (schema, MCP tools, routes, history, legacy migration). The lock did not cover bones, Bind Points points or the arrows; add_image left orphan files. Parity: replace image, assets list with sizes and the user's locks now in the MCP. The uncommitted "craft guide" section in docs/plan.md (another session) is left as is: Spanish, old paths. |
