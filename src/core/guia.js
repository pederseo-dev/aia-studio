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
      const hijosPermitidos = (t.childTypes ? ` (solo puede tener hijos ${t.childTypes.join(', ')})` : t.container ? ' (puede tener hijos)' : '') + (t.requiresParent ? ` (va dentro de ${t.parentTypes.join(' o ')}, nunca en la raíz)` : '');
      return `### \`${t.name}\`${hijosPermitidos}${t.resource ? ' (recurso)' : ''}\n\n${t.description}\n\n${tabla(t.properties)}`;
    })
    .join('\n\n');

  return `# Guía de aia-studio (formato ${FORMATO})

aia-studio es un editor de animación 2D vectorial: personajes, objetos, íconos, escenas o lo que haga falta animar. Un documento es JSON; tú lo modificas con lotes de operaciones
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
  (\`eye_l\`, \`arm_r\`, \`head\`). \`meta\` está reservado (es el \`target\` de las propiedades del documento).
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
| \`move\` | \`{ "op": "move", "target": "eye_l", "parent": "face", "index": 0, "keepPosition": true }\` | Cambia de padre y/o de orden. Sin \`parent\` conserva el actual; \`null\` = raíz. Con \`keepPosition\`, recalcula \`x\`/\`y\` para que quede en el mismo lugar de la pantalla. |
| \`rename\` | \`{ "op": "rename", "target": "eye_l", "id": "left_eye" }\` | Cambia el id y actualiza las referencias. |
| \`duplicate\` | \`{ "op": "duplicate", "target": "arm_l", "id": "arm_r", "suffix": "r", "props": { "x": 110, "scaleX": -1 } }\` | Copia el objeto con todos sus hijos. Los hijos copiados se llaman \`<id>_<suffix>\`. La copia queda justo delante del original. |

\`index\` es la posición entre los hermanos en orden de dibujo: \`0\` = al fondo; sin \`index\` = al frente.
Sin \`keepPosition\`, \`move\` no cambia \`x\`/\`y\` (los valores son relativos al padre, así que el objeto se corre si
el padre nuevo está en otro lugar). Con \`keepPosition: true\` queda donde se veía, como al arrastrarlo en Layers en
el editor (se conserva la posición, no el giro ni la escala). Para huesos usa \`reparent_bone\`.
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

Como en Moho, el esqueleto vive en una **capa de huesos**: un \`skeleton\`. Es un contenedor como \`group\` que tiene
adentro, en orden de dibujo, **el dibujo que el esqueleto mueve** y, aparte, **sus huesos**. Los \`bone\` solo pueden
estar dentro de un \`skeleton\` (los huesos raíz) o de otro \`bone\` del mismo skeleton: nunca en la raíz ni en un
\`group\`. El dibujo no se mete dentro de los huesos: se **enlaza** con la propiedad \`bone\` (de cualquier forma o
grupo), así el orden de dibujo queda libre (un brazo puede ir detrás del torso aunque su hueso sea hijo del torso).

- **Primero el skeleton.** Crea un \`skeleton\` (por ejemplo \`rig\`) y dibuja adentro, o mete el dibujo que ya
  existe con \`move\`. Si el skeleton queda en \`x: 0, y: 0\` sin giro, mover algo adentro no cambia dónde se ve; si
  tiene transformación, recalcula \`x\`/\`y\` al moverlo (como con cualquier grupo).
- **Enlace limitado a su skeleton:** un objeto solo puede enlazarse a huesos del skeleton que lo contiene (el más
  cercano). Lo que está fuera de todo skeleton no se enlaza. Un skeleton puede ir dentro de otro y enlazarse entero
  a un hueso del de afuera (una mano con sus propios huesos, que sigue al antebrazo).
- **Sin enlace no se mueve:** el dibujo de un skeleton que no tiene \`bone\` (ni lo hereda de un grupo) queda quieto
  en las poses. \`get_document\` lo marca como "sin hueso". Para enlazar todo de una vez, \`bind_by_proximity\` pone
  cada pieza sin enlace en el hueso más cercano (por el centro de su caja); después revisa el reparto y corrige con
  \`set\` lo que haya caído mal.
- Los ids son únicos en todo el documento (dibujo, huesos y recursos): nombra los huesos con el sufijo \`_bone\`
  (\`head_bone\`, \`tail_1_bone\`) para que no choquen con los grupos del dibujo.
- **Lo más fácil es crear huesos con \`from\` y \`to\`**: origen (la articulación) y punta, como \`[x, y]\` en
  coordenadas del **documento** (aunque el skeleton esté movido o girado). Se convierten solos a \`x\`, \`y\`,
  \`rotation\` y \`length\` relativos al padre. También sirven en \`set\` (solo \`to\` conserva el origen).
- Lo que se guarda: un hueso nace en su \`x\`/\`y\` (relativo a su hueso padre; un hueso raíz, relativo a su
  skeleton) y apunta según \`rotation\` (0 = derecha, 90 = abajo, -90 = arriba) con largo \`length\`. \`rotation\` y
  \`x\`/\`y\` son **relativos al padre**: el ángulo en pantalla es la suma de la cadena (y del giro del skeleton). Las
  poses usan estos valores relativos. \`get_document\` muestra dónde queda cada hueso en el documento.
- **Cambiar el padre de un hueso:** usa \`reparent_bone\`, no \`move\` (que conserva los valores relativos y corre el
  hueso de lugar): recalcula sus valores para que quede donde estaba en el montaje, y los que le fijan las poses. Con
  el skeleton como padre, queda como hueso raíz. Ojo con las poses que mueven al padre viejo (o a un ancestro que el
  nuevo no comparte) o al padre nuevo: ahí el hueso sí cambia de lugar, porque ahora sigue a otro. La respuesta
  lista esas poses; con \`keep_in_poses: true\` también se ajustan para que quede donde estaba.
- **Montaje:** los valores guardados en los huesos son la pose de reposo. Ubica los huesos sobre el dibujo tal como
  está. **Enlazar no mueve nada**: un objeto con \`"bone": "forearm_l_bone"\` (y todos sus hijos) acompaña a ese hueso
  solo cuando una pose lo mueve. Mover, girar o escalar el skeleton mueve el dibujo y los huesos juntos.
- Enlaza en el nivel más alto que convenga: el grupo \`head\` al hueso \`head_bone\`, y los hijos del grupo lo siguen
  sin enlazarlos uno por uno. Un hijo con su propio \`bone\` sigue al suyo.
- **Partes que se doblan** (cola, brazo flexible, cuello largo): no hace falta partir el dibujo. Un solo \`path\`
  puede seguir a varios huesos **por punto**: cada vértice acepta \`"bone": "tail_2_bone"\` (de su skeleton) y, en una
  pose, se mueve con sus tangentes según ese hueso. \`bind_points\` reparte los vértices entre los huesos más cercanos
  de su skeleton (o de una lista). Los vértices sin \`bone\` siguen al hueso de la forma (o de su grupo). Pon
  vértices cerca de cada articulación para que la curva se doble bien.
- **El enlace por punto es del montaje**, como en Moho: una pose que cambia la forma de un path (\`vertices\` o
  \`d\`) no guarda \`bone\` en sus vértices; al aplicarla, el vértice i sigue al hueso del vértice i del montaje. Por
  eso conviene que la pose tenga los mismos vértices, en el mismo orden. Para cambiar a qué hueso sigue un punto,
  cambia el montaje.
- **Poses:** una \`pose\` es un recurso con nombre que fija valores (absolutos, como en el montaje) sin cambiar el
  montaje: en \`values\`, \`{ id_de_objeto: { propiedad: valor } }\`. Se crea con \`set_pose\` (o con \`apply_ops\`) y
  se mira con \`render_preview\` pasando \`pose\`. \`minAngle\`/\`maxAngle\` de un hueso limitan la rotación en las
  poses. Una pose no se limita a huesos: ver la sección siguiente.
- Los huesos no salen en la imagen del personaje: para revisar dónde quedaron, usa \`render_preview\` con
  \`bones: true\` (y \`pose\`, para verlos posados).

\`\`\`json
[
  { "op": "create", "type": "skeleton", "id": "rig", "index": 0 },
  { "op": "move", "target": "body", "parent": "rig" },
  { "op": "move", "target": "head", "parent": "rig" },
  { "op": "move", "target": "arm_l", "parent": "rig" },
  { "op": "create", "type": "bone", "id": "spine_bone", "parent": "rig", "props": { "from": [300, 420], "to": [300, 300] } },
  { "op": "create", "type": "bone", "id": "neck_bone", "parent": "spine_bone", "props": { "from": [300, 300], "to": [300, 260] } },
  { "op": "create", "type": "bone", "id": "upper_arm_l_bone", "parent": "spine_bone", "props": { "from": [350, 320], "to": [350, 390] } },
  { "op": "set", "target": "body", "props": { "bone": "spine_bone" } },
  { "op": "set", "target": "head", "props": { "bone": "neck_bone" } },
  { "op": "set", "target": "arm_l", "props": { "bone": "upper_arm_l_bone" } },
  { "op": "create", "type": "pose", "id": "wave", "props": { "values": { "upper_arm_l_bone": { "rotation": 45 } } } }
]
\`\`\`

Los tres \`move\` meten el dibujo en \`rig\` (que está en el origen, así que nada cambia de lugar). Con \`from\`/\`to\`,
\`spine_bone\` queda en \`x: 300, y: 420, rotation: -90, length: 120\` (apunta hacia arriba), y \`upper_arm_l_bone\` en
\`x: 100, y: 50, rotation: 180\`: relativo a \`spine_bone\`, que ya está girado -90°, así que en pantalla cuelga hacia
abajo (-90 + 180 = 90°). En la pose \`wave\` queda en -90 + 45 = -45°: levantado hacia arriba y afuera. En vez de los
tres \`set\` de \`bone\` podrías usar \`bind_by_proximity\` con \`skeleton: "rig"\` y revisar lo que eligió.

## Expresiones: poses, params, drivers y switch

Así se controla al personaje desde afuera (la app, otra IA): con **params** de alto nivel (\`happiness\`,
\`head_turn\`, \`viseme\`) en vez de mover piezas sueltas. Como los smart bones de Moho, pero explícito:

1. **Pose**: lo que cambia en una expresión. Puede fijar **cualquier propiedad animable** de cualquier objeto:
   rotación de huesos, \`vertices\` de una boca o una ceja (también acepta \`d\`), \`fill\`, \`opacity\`, \`visible\`, el
   \`active\` de un switch... Para que una forma se **interpole** (morph) entre el montaje y la pose, la pose tiene
   que tener **la misma cantidad de vértices** que el montaje: redibuja la misma línea moviendo los puntos.
2. **Param**: el control. \`kind\` \`number\` (entre \`min\` y \`max\`), \`boolean\` o \`enum\` (\`options\`). Su valor no
   se guarda: lo pone quien usa el personaje.
3. **Driver**: conecta un param con una pose. El tramo \`inMin\`…\`inMax\` del param se vuelve peso \`outMin\`…\`outMax\`
   (0 = nada, 1 = la pose completa). Con un enum, \`equals\` dice con qué opción va la pose.
4. Varias poses activas se **suman** sobre el montaje: los números suman sus diferencias (cabeza girada + feliz),
   colores y vértices se interpolan, y lo que no se interpola (el \`active\` de un switch) lo toma la pose con peso
   ≥ 0.5.

**Switch**: un grupo que muestra un solo hijo, el de \`active\` (o el primero). Para bocas o visemas con dibujos
distintos, mete cada variante en un switch y que cada pose elija una con \`active\`. **\`create_switch_control\`**
arma todo de una vez, como «Create control» en el editor: un param enum con una opción por variante, una pose por
opción y su driver con \`equals\`. Si sacas del switch una variante que una pose elige, el lote falla: quita esa
variante de la pose (\`set_pose\` con \`{ "mouth": {} }\`) o déjala dentro del switch.

El \`initial\` de un param enum y el \`equals\` de sus drivers tienen que ser opciones de \`options\`; en un param
numérico, \`min\` no puede ser mayor que \`max\`.

\`\`\`json
[
  { "op": "create", "type": "param", "id": "happiness", "props": { "min": -1, "max": 1 } },
  { "op": "create", "type": "pose", "id": "happy", "props": { "values": { "mouth_line": { "d": "M-20 0 Q0 14 20 0" }, "brow_l": { "rotation": -8 } } } },
  { "op": "create", "type": "pose", "id": "sad", "props": { "values": { "mouth_line": { "d": "M-20 6 Q0 -8 20 6" }, "brow_l": { "rotation": 12 } } } },
  { "op": "create", "type": "driver", "id": "happiness_happy", "props": { "param": "happiness", "pose": "happy", "inMin": 0, "inMax": 1 } },
  { "op": "create", "type": "driver", "id": "happiness_sad", "props": { "param": "happiness", "pose": "sad", "inMin": 0, "inMax": -1 } },
  { "op": "create", "type": "param", "id": "viseme", "props": { "kind": "enum", "options": ["rest", "a", "o", "m"] } },
  { "op": "create", "type": "pose", "id": "viseme_o", "props": { "values": { "mouth": { "active": "mouth_o" } } } },
  { "op": "create", "type": "driver", "id": "viseme_o_driver", "props": { "param": "viseme", "pose": "viseme_o", "equals": "o" } }
]
\`\`\`

Aquí \`happiness\` va de -1 (triste) a 1 (feliz): de 0 a 1 entra \`happy\` y de 0 a -1 entra \`sad\`. \`mouth_line\`
tiene en el montaje los mismos 2 vértices que en las poses, así que la boca se curva de a poco. Revisa la mezcla con
\`render_preview\` y \`params\` (por ejemplo \`{ "happiness": 0.5, "viseme": "o" }\`); el texto dice qué poses quedaron
activas y con qué peso.

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
5. Si te equivocas, \`undo\` deshace tu último lote (solo los tuyos, nunca los del usuario). Si el usuario cambió
   después alguna de las mismas propiedades, \`undo\` se niega y dice cuáles: corrígelas con un lote nuevo, sin
   pisar su retoque. A él le pasa lo mismo con lo tuyo.
6. Para revisar un detalle chico, \`render_preview\` acepta \`region\` (un recorte del documento) además de \`pose\`.
7. \`delete_document\` borra un documento entero y no se puede deshacer: úsalo solo si el usuario lo pide.
8. No hay importador de SVG para la IA: pasa cada forma como \`d\` de un \`path\` (un path por subtrazado).
`;
}
