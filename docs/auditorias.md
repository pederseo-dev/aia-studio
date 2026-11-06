# Auditorías

Registro de las auditorías del agente `auditor` (`.claude/agents/auditor.md`). Cada auditoría revisa lo que cambió
desde el último commit auditado; al terminar se agrega una fila acá.

| Fecha | Rango auditado | Hallazgos | Arreglos | Notas |
| --- | --- | --- | --- | --- |
| 2026-11-04 | `main..1997421` (proyecto completo) | 4 importantes, 7 menores, 4 huecos de paridad | `40df396..02e9a50` | Primera auditoría: unos 7 minutos, porque cubrió todo el proyecto. |
| 2026-11-05 | `1997421..1224bc3` (17 commits) | 2 importantes, 5 menores, 1 hueco de paridad | `d335c48..e4768d0` | Incremental: unos 4 minutos. Sin restos de `create_switch_control`; los arreglos de la primera quedaron cerrados. |
| 2026-11-05 | `1224bc3..493d2a7` (12 commits, fase 5) | 4 importantes, 6 menores, 6 huecos de paridad | `b8e8ad3..c21ce2d` | Incremental. El núcleo de clips respeta la decisión; fallas en el borde del loop, autokey con drivers y drivers que tapan pistas del clip. |
| 2026-11-06 | `493d2a7..6538a4d` (14 commits: arreglos fase 5, timeline, params solo en Puppet) | 2 importantes, 6 menores, 3 huecos de paridad | `a832d75..3d01d7f` | Arreglos de la fase 5 cerrados. Restos de «params en Animate» en guía, esquema, MCP y docs; drivers que suman en escenas sin control. |
