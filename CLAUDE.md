# aia-studio

## Idioma

- **La interfaz del editor va toda en inglés**: textos del HTML, `title`/`aria-label`, menús, avisos, ayudas, notas del historial que ve el usuario. Se usan los términos de Rive/Moho (Layers, Assets, Bone, Pose, Setup, Parameters, Switch…).
- El código (identificadores), los comentarios y la documentación de `docs/` siguen en español.
- La conversación con el usuario es en español.
- **Mensajes de error del núcleo (`src/core/`) y del servidor (`servidor/`, `mcp/`): en inglés.** Llegan tal cual
  al aviso del editor y a la IA, que los entiende igual. Los nuevos se escriben en inglés; muchos viejos siguen en
  español (validación, operaciones, esquema, trazado, `sugerir`) y se traducen al tocarlos, junto con las pruebas
  que los buscan.
- Las notas del historial (las por defecto de `servidor/almacen.js` y las que pone el MCP) van en inglés: el usuario
  las ve. El texto de las respuestas del MCP, que solo lee la IA, puede seguir en español.
- Esquema: `description` (español) es para la guía de la IA; `help` (inglés) es la ayuda que muestra el inspector.
  Todo tipo y propiedad nuevos llevan las dos (una prueba lo exige).
