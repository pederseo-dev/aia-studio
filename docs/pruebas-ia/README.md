# Pruebas con IA

Cada fase del [plan](../plan.md) se cierra dándole a una IA, por MCP, una lista fija de tareas en lenguaje natural.
Sirve para ver qué partes del formato o de las herramientas la confunden y corregirlas antes de seguir.

## Cómo correr una prueba

1. Arrancar el editor (`npm run dev`) para ver los cambios en vivo.
2. Abrir una conversación nueva en el cliente (Claude Desktop, Claude Code...) con el MCP `aia-studio` conectado.
3. Pasarle las tareas de `fase-N.md` **una por una, tal cual están escritas**, sin pistas extra.
4. Anotar el resultado en la tabla del mismo archivo.

## Qué se anota por corrida

| Campo | Qué es |
| --- | --- |
| Fecha | Día de la corrida |
| Cliente y modelo | Por ejemplo, Claude Desktop con Opus 5.5 |
| Logradas | Tareas completas sin ayuda, sobre el total |
| Rechazos | Lotes que el validador rechazó (la IA se corrigió o no) |
| Correcciones a mano | Cosas que hubo que arreglar en el editor |
| Notas | Qué la confundió y qué cambiaríamos (formato, nombres, descripción de herramientas) |

## Plantilla para `fase-N.md`

```markdown
# Fase N: <título>

## Tareas

1. ...
2. ...

## Resultados

| Fecha | Cliente y modelo | Logradas | Rechazos | Correcciones a mano | Notas |
| --- | --- | --- | --- | --- | --- |
```
