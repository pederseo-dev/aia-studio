// Guía del formato para la IA, generada desde el esquema: si se agrega un tipo o una propiedad, la guía se actualiza
// sola.

import { FORMATO } from './formato.js';

function rango(p) {
  if (p.type === 'enum') return p.values.join(' \\| ');
  if (p.min == null && p.max == null) return '';
  return `${p.min ?? '−∞'} … ${p.max ?? '∞'}`;
}

function tabla(propiedades) {
  const filas = Object.entries(propiedades).map(([nombre, p]) => {
    const tipo = p.type + (p.nullable ? ' o null' : '') + (p.integer ? ' (entero)' : '');
    return `| \`${nombre}\` | ${tipo} | \`${JSON.stringify(p.default)}\` | ${rango(p)} | ${p.description ?? ''} |`;
  });
  return ['| Propiedad | Tipo | Por defecto | Rango | Descripción |', '| --- | --- | --- | --- | --- |', ...filas].join('\n');
}

export function guiaParaIA(esquema) {
  const tipos = [...esquema.tipos.values()]
    .map((t) => `### \`${t.name}\`${t.container ? ' (puede tener hijos)' : ''}\n\n${t.description}\n\n${tabla(t.properties)}`)
    .join('\n\n');

  return `# Guía de aia-studio (formato ${FORMATO})

aia-studio es un editor de personajes 2D. Un documento es JSON; tú lo modificas con lotes de operaciones
(\`apply_ops\`) y el usuario lo ve en vivo en el editor, donde también puede retocar a mano.

## Convenciones

- Coordenadas como en SVG: origen arriba a la izquierda, **Y crece hacia abajo**. Unidades en px.
- Ángulos en **grados**; positivo = sentido horario.
- Cada objeto se dibuja en el sistema de coordenadas de su padre: \`x\`/\`y\` son relativas al padre.
- Las formas (\`rect\`, \`ellipse\`) están **centradas** en su \`x\`/\`y\`.
- Orden de dibujo: entre hermanos, los últimos de la lista quedan **encima**.

## Documento

\`\`\`json
{
  "format": "${FORMATO}",
  "meta": { "name": "Robot", "width": 600, "height": 600 },
  "objects": [
    { "id": "head", "type": "group", "parent": null, "x": 300, "y": 220 },
    { "id": "face", "type": "rect", "parent": "head", "y": -60, "width": 140, "height": 120, "cornerRadius": 20, "fill": "#9fb4c7" }
  ]
}
\`\`\`

- \`objects\` es una **lista plana**: la jerarquía se arma con \`parent\` (null = raíz).
- \`id\`: minúsculas, números y \`_\`, empezando con letra. Único en el documento. Usa nombres que digan qué es
  (\`eye_l\`, \`arm_r\`, \`head\`).
- Las propiedades que no aparecen usan su valor por defecto. Solo se guarda lo que cambia.

## Operaciones

Se envían en lotes. Un lote es **atómico**: si algo falla, no se aplica nada y recibes la lista de errores para
corregir y reintentar.

| Operación | Forma | Qué hace |
| --- | --- | --- |
| \`create\` | \`{ "op": "create", "type": "rect", "id": "eye_l", "parent": "head", "props": { ... }, "index": 0 }\` | Crea un objeto. \`parent\` e \`index\` son opcionales. |
| \`set\` | \`{ "op": "set", "target": "eye_l", "props": { "x": 10, "fill": "#ffffff" } }\` | Cambia propiedades. \`target: "meta"\` cambia el documento. |
| \`unset\` | \`{ "op": "unset", "target": "eye_l", "props": ["x"] }\` | Vuelve propiedades a su valor por defecto. |
| \`delete\` | \`{ "op": "delete", "target": "head" }\` | Borra el objeto **y todos sus hijos**. |
| \`move\` | \`{ "op": "move", "target": "eye_l", "parent": "face", "index": 0 }\` | Cambia de padre y/o de orden. Sin \`parent\` conserva el actual; \`null\` = raíz. |
| \`rename\` | \`{ "op": "rename", "target": "eye_l", "id": "left_eye" }\` | Cambia el id y actualiza las referencias. |

\`index\` es la posición entre los hermanos en orden de dibujo: \`0\` = al fondo; sin \`index\` = al frente.

## Tipos

### \`meta\` (propiedades del documento, se cambian con \`target: "meta"\`)

${tabla(esquema.meta.properties)}

${tipos}

## Cómo trabajar bien

1. **Mira el historial** (\`get_history\`) antes de editar un documento existente. Las entradas con origen \`user\`
   son retoques a mano: respétalos y no los pises.
2. **Usa grupos como articulaciones.** El \`x\`/\`y\` de un grupo es su pivote: para que una cabeza gire desde el
   cuello, pon el grupo \`head\` en el cuello y dibuja la cara con \`y\` negativa dentro del grupo.
3. **Mira el resultado** con \`render_preview\` después de cada cambio importante.
4. **Prefiere pocos lotes grandes** con una nota clara (\`note\`): cada lote es un paso de deshacer para el usuario.
5. Si te equivocas, \`undo\` deshace tu último lote (solo los tuyos, nunca los del usuario).
`;
}
