// Guía del formato para la IA, generada desde el esquema: si se agrega un tipo o una propiedad, la guía se actualiza
// sola.

import { FORMATO } from './formato.js';

function rango(p) {
  if (p.type === 'enum') return p.values.join(' \\| ');
  if (p.type === 'ref' && p.refTypes) return `id de ${p.refTypes.join(' o ')}`;
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
    .map((t) => {
      const hijosPermitidos = t.childTypes ? ` (solo puede tener hijos ${t.childTypes.join(', ')})` : t.container ? ' (puede tener hijos)' : '';
      return `### \`${t.name}\`${hijosPermitidos}${t.resource ? ' (recurso)' : ''}\n\n${t.description}\n\n${tabla(t.properties)}`;
    })
    .join('\n\n');

  return `# Guía de aia-studio (formato ${FORMATO})

aia-studio es un editor de personajes 2D. Un documento es JSON; tú lo modificas con lotes de operaciones
(\`apply_ops\`) y el usuario lo ve en vivo en el editor, donde también puede retocar a mano.

## Convenciones

- Coordenadas como en SVG: origen arriba a la izquierda, **Y crece hacia abajo**. Unidades en px.
- Ángulos en **grados**; positivo = sentido horario.
- Cada objeto se dibuja en el sistema de coordenadas de su padre: \`x\`/\`y\` son relativas al padre.
- Las formas (\`rect\`, \`ellipse\`) están **centradas** en su \`x\`/\`y\`, salvo que \`originX\`/\`originY\` (fracciones de
  0 a 1) pongan el pivote en otro punto: \`originY: 1\` = pivote en el borde de abajo.
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
- **Izquierda y derecha son las del personaje**, como en cualquier rig: en un personaje de frente, \`arm_l\` es el
  brazo que el espectador ve a su derecha. Usa los sufijos \`_l\` y \`_r\`.
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
| \`duplicate\` | \`{ "op": "duplicate", "target": "arm_l", "id": "arm_r", "suffix": "r", "props": { "x": 110, "scaleX": -1 } }\` | Copia el objeto con todos sus hijos. Los hijos copiados se llaman \`<id>_<suffix>\`. La copia queda justo delante del original. |

\`index\` es la posición entre los hermanos en orden de dibujo: \`0\` = al fondo; sin \`index\` = al frente.
\`move\` no cambia \`x\`/\`y\`: si cambias de padre, recalcula la posición si quieres que el objeto quede en el mismo lugar.
Para copiar un documento entero, usa \`create_document\` con \`copy_from\`.

## Formas libres (\`path\`)

Lo más cómodo es pasar un trazado SVG en \`d\` (un solo subtrazado, cualquier comando: M L H V C S Q T A Z) y el
editor lo convierte a vértices:

\`\`\`json
{ "op": "create", "type": "path", "id": "ear_l", "parent": "head", "props": { "d": "M-60 -150 C-80 -220 -20 -200 -30 -150 Z", "fill": "#3a2a4d" } }
\`\`\`

Las coordenadas de \`d\` y de los vértices son **relativas al path**: su \`x\`/\`y\` es el pivote. Para que el path gire
desde un punto concreto, pon ese punto en \`x\`/\`y\` y dibuja alrededor de (0, 0).

Lo que se guarda es \`vertices\` (y \`closed\`). Cada vértice tiene \`x\`, \`y\` y, si es curvo, sus tangentes en
polares (ángulo en grados con Y hacia abajo: 0 = derecha, 90 = abajo; distancia en px):

| Vértice | Forma |
| --- | --- |
| Recto | \`{ "x": 0, "y": 0 }\`, con \`"radius": 8\` para redondear la esquina |
| Curva suave simétrica | \`{ "x": 0, "y": 0, "mode": "mirrored", "angle": 0, "dist": 20 }\` |
| Curva suave con largos distintos | \`{ "x": 0, "y": 0, "mode": "asymmetric", "angle": 0, "inDist": 10, "outDist": 30 }\` |
| Pico (tangentes independientes) | \`{ "x": 0, "y": 0, "mode": "detached", "inAngle": 200, "inDist": 15, "outAngle": -20, "outDist": 15 }\` |

\`angle\`/\`outAngle\` es la dirección de la tangente que sale hacia el vértice siguiente; la de entrada apunta hacia
el anterior (en mirrored y asymmetric es \`angle + 180\`). Para retocar un vértice suelto puedes leer \`vertices\`,
cambiar ese elemento y reenviar la lista completa con \`set\`.

## Estilos y degradados (recursos)

\`style\`, \`linear_gradient\` y \`radial_gradient\` son **recursos**: van en la raíz, no se dibujan y las formas los
usan por id.

- **Estilo compartido:** crea un \`style\` (por ejemplo \`skin\` con \`fill\` y \`stroke\`) y pon \`"style": "skin"\` en
  las formas. Las propiedades que la forma no tenga propias salen del estilo; cambiar el estilo cambia todas a la
  vez. Úsalo para la paleta del personaje: piel, pelo, ropa, contorno.
- **Degradado:** crea un \`linear_gradient\` o \`radial_gradient\` con sus \`stops\` y pon su id en \`fillGradient\` de
  la forma (o del estilo). Sus coordenadas van de 0 a 1 sobre la caja de la forma.

\`\`\`json
[
  { "op": "create", "type": "linear_gradient", "id": "fur_shade", "props": { "stops": [{ "offset": 0, "color": "#f5a142" }, { "offset": 1, "color": "#c86b1e" }] } },
  { "op": "create", "type": "style", "id": "fur", "props": { "fillGradient": "fur_shade", "stroke": "#4a2a10", "strokeWidth": 3 } },
  { "op": "set", "target": "body", "props": { "style": "fur" } }
]
\`\`\`

## Huesos y poses

El esqueleto va **aparte del dibujo**, como en Moho: los \`bone\` solo tienen huesos como hijos, y el dibujo no se
mete dentro de ellos sino que se **enlaza** con la propiedad \`bone\` (de cualquier forma o grupo). Así el orden de
dibujo queda libre (un brazo puede ir detrás del torso aunque su hueso sea hijo del torso).

- Un hueso nace en su \`x\`/\`y\` (relativo a su hueso padre; el hueso raíz, relativo al documento) y apunta según
  \`rotation\` (0 = derecha, 90 = abajo, -90 = arriba) con largo \`length\`. Para encadenar, el hijo va en la punta del
  padre: \`x: <length del padre>, y: 0\`. Su \`rotation\` (y su \`x\`/\`y\`) son **relativos al hueso padre**: el ángulo
  en pantalla es la suma de los ángulos de la cadena. \`get_document\` muestra dónde queda cada hueso en el documento.
- **Montaje:** los valores guardados en los huesos son la pose de reposo. Ubica los huesos sobre el dibujo tal como
  está. **Enlazar no mueve nada**: un objeto con \`"bone": "forearm_l"\` (y todos sus hijos) acompaña a ese hueso
  solo cuando una pose lo mueve.
- Enlaza en el nivel más alto que convenga: el grupo \`head\` al hueso \`head\`, y los hijos del grupo lo siguen sin
  enlazarlos uno por uno. Un hijo con su propio \`bone\` sigue al suyo.
- **Poses:** una \`pose\` es un recurso con nombre que fija valores de algunos huesos (absolutos, como en el
  montaje) sin cambiar el montaje. Se crea con \`set_pose\` (o con \`apply_ops\`) y se mira con
  \`render_preview\` pasando \`pose\`. \`minAngle\`/\`maxAngle\` de un hueso limitan la rotación en las poses.
- Los huesos no salen en la imagen del personaje: para revisar dónde quedaron, usa \`render_preview\` con
  \`bones: true\` (y \`pose\`, para verlos posados).

\`\`\`json
[
  { "op": "create", "type": "bone", "id": "spine", "props": { "x": 300, "y": 420, "rotation": -90, "length": 120 } },
  { "op": "create", "type": "bone", "id": "neck", "parent": "spine", "props": { "x": 120, "length": 40 } },
  { "op": "create", "type": "bone", "id": "upper_arm_l", "parent": "spine", "props": { "x": 100, "y": 50, "rotation": 180, "length": 70 } },
  { "op": "set", "target": "head", "props": { "bone": "neck" } },
  { "op": "set", "target": "arm_l", "props": { "bone": "upper_arm_l" } },
  { "op": "create", "type": "pose", "id": "wave", "props": { "bones": { "upper_arm_l": { "rotation": 45 } } } }
]
\`\`\`

Aquí \`spine\` apunta hacia arriba (-90°). \`upper_arm_l\` nace a la derecha del espectador (en el marco de \`spine\`,
\`y\` positiva cae a la derecha) y cuelga hacia abajo: -90 + 180 = 90° en pantalla. En la pose \`wave\` queda en
-90 + 45 = -45°: levantado hacia arriba y afuera.

## Tipos

### \`meta\` (propiedades del documento, se cambian con \`target: "meta"\`)

${tabla(esquema.meta.properties)}

${tipos}

## Cómo trabajar bien

1. **Mira el historial** (\`get_history\`, con \`origin: "user"\` para ver solo lo del usuario) antes de editar un
   documento existente. Esas entradas son retoques a mano: respétalos y no los pises.
2. **Usa grupos como articulaciones.** El \`x\`/\`y\` de un grupo es su pivote: para que una cabeza gire desde el
   cuello, pon el grupo \`head\` en el cuello y dibuja la cara con \`y\` negativa dentro del grupo.
3. **Mira el resultado** con \`render_preview\` después de cada cambio importante.
4. **Prefiere pocos lotes grandes** con una nota clara (\`note\`): cada lote es un paso de deshacer para el usuario.
5. Si te equivocas, \`undo\` deshace tu último lote (solo los tuyos, nunca los del usuario).
6. Para revisar un detalle chico, \`render_preview\` acepta \`region\` (un recorte del documento) además de \`pose\`.
`;
}
