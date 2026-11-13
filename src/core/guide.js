// Format guide for the AI, generated from the schema: if a type or a property is added, the guide updates itself.

import { CURVE_DESCRIPTIONS } from './curves.js';
import { FORMAT } from './format.js';

function range(p) {
  if (p.type === 'enum') return p.values.join(' \\| ');
  if (p.type === 'ref' && p.refTypes) return `id de ${p.refTypes.join(' o ')}`;
  if (p.type === 'asset') return 'archivo de assets/';
  if (p.min == null && p.max == null) return '';
  return `${p.min ?? '−∞'} … ${p.max ?? '∞'}`;
}

function table(properties) {
  const rows = Object.entries(properties).map(([name, p]) => {
    const kind = p.type + (p.nullable ? ' o null' : '') + (p.integer ? ' (entero)' : '');
    return `| \`${name}\` | ${kind} | \`${JSON.stringify(p.default)}\` | ${range(p)} | ${p.description ?? ''} |`;
  });
  return ['| Propiedad | Tipo | Por defecto | Rango | Descripción |', '| --- | --- | --- | --- | --- |', ...rows].join('\n');
}

export function guideForAI(schema) {
  const types = [...schema.types.values()]
    .map((t) => {
      const allowedChildren = (t.childTypes ? ` (solo puede tener hijos ${t.childTypes.join(', ')})` : t.container ? ' (puede tener hijos)' : '') + (t.requiresParent ? ` (va dentro de ${t.parentTypes.join(' o ')}, nunca en la raíz)` : '');
      return `### \`${t.name}\`${allowedChildren}${t.resource ? ' (recurso)' : ''}\n\n${t.description}\n\n${table(t.properties)}`;
    })
    .join('\n\n');

  return `# Guía de aia-studio (formato ${FORMAT})

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
  "format": "${FORMAT}",
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

## Imágenes (\`image\`)

Una capa \`image\` dibuja un archivo PNG, JPG, WebP o SVG (el SVG entero, sin poder editar sus formas; para formas
editables, el usuario tiene Import SVG en el editor). El archivo vive en la carpeta \`assets/\` del documento y \`src\`
es su nombre.

- **Agregar:** \`add_image\` con \`path\` (ruta absoluta de un archivo que te indicó el usuario) o \`url\`. Copia el
  archivo a \`assets/\` y crea la capa centrada en el lienzo, de su tamaño natural (achicada si no entra), o donde y del
  tamaño que digas (\`x\`, \`y\`, \`width\` o \`height\`; con uno solo, el otro va en proporción). Devuelve la vista previa.
- **Reusar un archivo** que ya está en \`assets/\` (por ejemplo, la misma imagen dos veces): \`create\` con \`apply_ops\` y
  su \`src\`. Un \`src\` que no está en \`assets/\` se acepta pero no se dibuja, y apply_ops avisa.
- Se comporta como cualquier capa: está centrada en \`x\`/\`y\` (\`originX\`/\`originY\` mueven el pivote), va dentro de
  grupos, switches y skeletons, se pega a un hueso con \`bone\` y en poses y clips se animan su posición, giro, escala,
  \`opacity\`, \`visible\`, \`width\` y \`height\`. \`width\`/\`height\` la estiran: para no deformarla, cámbialos en
  proporción o usa \`scaleX\`/\`scaleY\`.
- Para cambiar de imagen en una animación (bocas, ojos dibujados), pon una \`image\` por variante dentro de un
  \`switch\`.
- Deshacer quita la capa, pero el archivo queda en \`assets/\`.
- En \`render_preview\` una imagen WebP sale como un recuadro gris con una cruz (en su lugar y tamaño): esa vista
  no sabe dibujar WebP. El usuario la ve bien. PNG, JPG y SVG se ven tal cual.

\`\`\`json
[
  { "op": "create", "type": "image", "id": "sun_copy", "props": { "src": "sun.png", "x": 600, "y": 120, "width": 80, "height": 80, "opacity": 0.6 } }
]
\`\`\`

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

**Switch**: un grupo que muestra un solo hijo, el de \`active\` (o el primero, si es null), como la switch layer de
Moho. Se crea con \`create\` y \`type: "switch"\`, y cada variante es un hijo suyo (\`parent\`). Para elegir cuál se ve,
\`set\` con \`{ "active": "<hijo>" }\`: es lo mismo que hace el usuario con el menú ▾ del switch en Layers o con el
selector de la barra de opciones. En una pose: \`set_pose\` con \`{ "<switch>": { "active": "<hijo>" } }\`. Si un param
tiene que elegir la variante (bocas, visemas), arma tú las piezas: un param enum, una pose por opción que fija
\`active\` y un driver con \`equals\` para cada una, como en el ejemplo de abajo. Si sacas del switch una variante que una pose elige, el lote falla: antes saca
de la pose solo el \`active\` del switch con \`set_pose\` y \`remove: ["mouth.active"]\` (no con \`{ "mouth": {} }\`, que
sacaría de la pose todo lo de \`mouth\`, por ejemplo su \`x\`), o deja la variante dentro del switch. \`remove\` sirve
para sacar cualquier propiedad suelta de una pose.

El \`initial\` de un param enum y el \`equals\` de sus drivers tienen que ser opciones de \`options\`; en un param
numérico, \`min\` no puede ser mayor que \`max\`. Para quitar o renombrar una opción que un driver usa, cambia su
\`equals\` (o borra el driver) **en el mismo lote** que el \`set\` de \`options\`. \`get_document\` dice en cada switch
qué params eligen su variante (los que tienen drivers hacia poses que fijan su \`active\`).

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

## Animación: clips con keyframes

El editor tiene tres modos: **Design** (dibujo y rig), **Animate** (una timeline de escena para exportar a video,
Lottie o SVG) y **Puppet** (el muñeco listo para que una app o su IA lo manejen en vivo: params, poses y clips
cortos que se disparan, uno por botón). Los dos últimos usan el mismo recurso, \`animation\` (un clip), con
\`usage\` \`animate\` o \`puppet\`.

- **Pistas** (\`tracks\`): \`{ id_de_objeto: { propiedad: [ { "t": 0, "value": 0 }, { "t": 0.4, "value": -60, "ease": "ease-out" } ] } }\`,
  con la misma forma que \`values\` de una pose: valores **absolutos**, como en el montaje. Cualquier propiedad
  animable sirve: huesos, \`fill\`, \`opacity\`, el \`active\` de un switch, \`vertices\` (o \`d\`) con la misma cantidad
  de puntos para un morph. **Solo en un clip de Puppet**, un **param** también tiene pista: \`{ "happiness": { "value": [...] } }\`,
  y sus drivers suman la pose (un clip «laugh» puede llevar \`happiness\` a 1 en vez de repetir la cara feliz).
- **Una escena de Animate no tiene params ni drivers:** se ve el montaje con sus keyframes, nada más (como se exporta).
  Las poses y los params son del muñeco; en una escena, una expresión se copia como keyframes (\`set_keys\` con
  \`pose\`) y una variante se elige keyando el \`active\` del switch (\`values: { "mouth": { "active": "mouth_o" } }\`).
- \`t\` en segundos, de 0 a \`duration\`. Antes del primer keyframe vale el primero; después del último, el último; una
  propiedad sin pista vale lo del montaje. Por eso, **keya el estado inicial en \`t = 0\`** (por ejemplo la boca normal):
  si el primer keyframe de la boca está en 1 s con «a», el clip muestra «a» desde 0. \`loop\`: \`once\`, \`loop\` (vuelve a empezar: pon en \`t = duration\` los
  mismos valores que en 0 para que no salte) o \`pingpong\`.
- Para **empezar y terminar en reposo**, un momento con \`setup: true\` pone el montaje en todo lo que el clip anima (y,
  en Puppet, los params en su valor inicial), sin copiar valores a mano.
- **Ojo con los params (Puppet):** animar un param mueve **todas** las poses de sus drivers, también las que hizo el
  usuario (\`happiness\` puede mover \`happy\` y además \`mirando_arriba\`). \`set_keys\` y \`render_preview\` listan, por
  cada param animado, qué poses mueve y qué objetos toca cada una: léelo antes de dar el clip por bueno. Si una de
  ellas mueve también algo que el clip anima (un hueso), los dos se suman; revísalo con la tira de cuadros.
- \`set_keys\` solo cambia las pistas que nombras: las demás, también los retoques del usuario, quedan como estaban, y
  \`undo\` va por pista. Un momento con solo \`t\` y \`ease\` cambia la curva de los keyframes que ya hay en ese tiempo.
  Para alargar un clip basta con \`duration\`.
- \`ease\` va en el keyframe y vale para el tramo que **sale** de él. Curvas con nombre:
${CURVE_DESCRIPTIONS.map(([name, meaning]) => `  - \`${name}\`: ${meaning}.`).join('\n')}
  O \`[x1, y1, x2, y2]\` (cubic-bezier de CSS) si ninguna sirve. Prefiere una con nombre antes que adivinar números: para
  «vuelve de golpe al final del tramo», \`ease-in-expo\`; para «llega y rebota un poco», \`ease-out-back\`. El \`active\` de
  un switch, los booleanos y los textos cambian de golpe.
- Orden en un clip de **Puppet**: montaje → clip en ese tiempo → los drivers suman sus poses encima (los params del
  clip pisan a los de afuera). En una escena de Animate no hay drivers: solo montaje → clip.
  Los **números se suman** (un hueso keyado en 10 con un driver activo que le suma 30 se ve en 40; \`set_keys\` y
  \`render_preview\` lo avisan). Lo que **no se suma** (el \`active\` de un switch, colores, vértices, booleanos) lo
  decide la pista del clip si la tiene; si no, los drivers.
- **Si un param elige la variante** (visemas, bocas, ojos): en un clip de **Puppet**, anima el **param**
  (\`params: { "viseme": "o" }\`) y no el \`active\` del switch; así el clip usa las mismas piezas que la app y se combina
  con sus drivers (un param enum siempre tiene una opción activa: sus drivers están siempre en juego). En una
  **escena**, keya el \`active\` (\`values: { "mouth": { "active": "mouth_o" } }\`) o copia la pose con \`pose\`.
- **Cómo armarlo:** \`set_keys\` piensa en **momentos**: «en t = 0.3, el brazo así y la boca así» (\`values\`, como en
  \`set_pose\`), «en t = 0.6, la pose \`happy\`» (\`pose\`, copia sus valores; con \`only: ["eye_l", "eye_r", "mouth"]\` solo
  esa parte, con \`except: ["tail_bone"]\` todo menos eso) o, solo en un clip de Puppet, params (\`params\`): los params son
  del muñeco y una escena de Animate no los anima (keya los valores, o copia la pose con \`pose\`). Crea el clip si no
  existe. Si una escena tiene pistas de params (un clip que pasó de Puppet a Animate), quítalas con \`set_keys\` y
  \`remove\` o con \`delete_keys\` y \`targets\`. \`delete_keys\` quita keyframes y \`move_keys\` los mueve en el tiempo (con su valor y su curva).
  Un número de \`values\` puede ser **relativo al montaje**: \`{ "head_bone": { "rotation": "+=14" } }\` es 14° más que en
  el montaje (\`"-=0.3"\` resta); se guarda el valor absoluto. Revisa el
  movimiento con \`render_preview\` y \`animation\` + \`times\` (una tira de cuadros en una sola imagen) o \`time\` (un
  cuadro). \`get_document\` lista cada pista de un clip con sus keyframes (\`t = valor curva\`), para leerlo sin el JSON.
  En un documento con muchos clips, \`get_document\` con \`json: false\` y \`clips: ["wave"]\` da el árbol con las pistas
  de solo esos clips (si la respuesta es muy grande, el JSON queda afuera solo). Las respuestas de \`apply_ops\` y
  \`undo\` muestran los clips resumidos, sin sus pistas.
- **Cambiar el ritmo:** \`scale_time\` estira o comprime en proporción todos los keyframes y la duración, en un solo paso
  de deshacer (\`duration: 1\` deja el clip en 1 s; \`factor: 0.5\`, el doble de rápido; con \`from\` y \`to\`, solo ese
  tramo, y lo de después se corre). No muevas los momentos de a uno con \`move_keys\` para eso.
- \`duration\` en \`set_keys\` no puede quedar más corta que los keyframes: para acortar el clip con todo adentro, usa
  \`scale_time\`; para cortar el final, borra antes los últimos keyframes.
- Para Puppet, escribe \`description\` (qué hace el clip, en pocas palabras): la IA de la app la lee para elegir cuándo
  dispararlo. Los clips de puppet suelen ser cortos (parpadeo 0.2 s, saludo 1–1.5 s, reposo en loop 2–4 s).

## Puppet en vivo

Una app (o su IA) maneja el muñeco con tres verbos: \`play(clip)\`, \`set(param, valor)\` y \`stop(clip)\`. No hay state
machine: la app decide qué toca. Cómo suena cada clip de Puppet lo dice el clip:

- **Base o gesto** sale del \`loop\`: un clip en \`loop\`/\`pingpong\` (reposo, escuchando, pensando, hablando) es **la
  base**: \`play\` la cambia con un fundido cruzado y se queda sonando. Un clip \`once\` (saludo, asentir, sorpresa) es
  un **gesto**: entra **encima** de la base, pisa **solo las pistas que tiene** y sale solo al final. Por eso un gesto
  no debe keyar lo que no le toca (un saludo que keya la boca tapa la boca de «hablando»).
- \`fade\`: segundos del fundido al entrar y salir (0.2 por defecto; 0 para el parpadeo). Un gesto empieza a salir
  \`fade\` segundos antes de su final.
- \`next\` (clip \`once\`): qué se dispara cuando empieza a salir. Encadena: \`start_talking\` → \`talking\`,
  \`surprised\` → \`idle\`. Si \`next\` es un clip en loop, pasa a ser la base.
- \`auto\`: lo que el muñeco hace solo, sin que la app lo pida: \`repeat\` (cada \`repeat_min\`…\`repeat_max\` s al azar:
  el parpadeo) o \`always\` (en loop siempre: la respiración). Van encima de los gestos. La app no los dispara.
- \`blend: "additive"\`: el clip **suma** su diferencia con el montaje en vez de pisar (la respiración con \`scaleY\`
  1.02 suma 0.02 a lo que haya). Solo los números se suman.
- **Params:** el valor lo pone la app con \`set\`. Si un clip anima ese param, gana el clip mientras suena y, al salir,
  vuelve suave al valor de la app. Escribe la \`description\` de cada param (qué controla y qué hacen sus extremos,
  por ejemplo «-1 looks at the viewer, 1 looks away»): la app la lee.
- **Una base que anima un param se lo quita a la app** mientras suena, o sea casi siempre. Anima en una base solo lo
  que es parte de ese estado (\`viseme\` en «hablando»); deja expresiones como \`happiness\` para la app o para gestos.
- **Los ángulos se mezclan como números.** El fundido entre bases (o al entrar un gesto) interpola \`rotation\`: un
  brazo en 140 cuando el montaje lo tiene en -178 da casi una vuelta entera, aunque en pantalla se vea parecido.
  Escribe los ángulos cerca de los del montaje (-220 en vez de 140; \`"+=n"\` ayuda). \`set_keys\` avisa cuando una
  rotación de un clip de Puppet queda a más de 180° del montaje.
- **\`next\` reemplaza la base** si es un clip en loop: un gesto con \`next: "idle"\` disparado durante «hablando»
  deja al personaje en reposo. Úsalo para reacciones que cambian de estado; un gesto sin \`next\` vuelve solo a la base que
  había.
- **Parpadeo automático:** si ya había un parpadeo keyado dentro de una base (\`idle\`), sácalo al crear el auto
  \`repeat\` (si no, parpadea dos veces). Un clip \`auto\` ya no lo dispara la app: si la app también necesita un
  parpadeo a pedido, deja otro clip \`once\`. La primera vez suena al azar entre \`repeat_min\` y \`repeat_max\`
  segundos desde que arranca.
- \`fade\` se come el final de un gesto: el gesto empieza a salir \`fade\` segundos antes de terminar. Con un fade largo,
  alarga el clip o deja quieto el final. En un clip \`once\` el fundido no pasa de la mitad de lo que dura (si no, el
  gesto nunca llegaría a verse entero). Un clip \`auto: "always"\` suena siempre en loop aunque su \`loop\` diga \`once\`.
- \`stop\` con un clip que no suena no hace nada; con un id que no existe o un clip \`auto\`, da error. Con Live
  encendido en el editor, la persona no edita a mano, pero tus cambios por MCP (y deshacer) se aplican y el muñeco
  sigue con el documento nuevo.

Todo esto se pone con \`set_keys\` (\`fade\`, \`next\`, \`blend\`, \`auto\`, \`repeat_min\`, \`repeat_max\`) o con \`apply_ops\`.
Para ver cómo lo verá la app, \`render_preview\` con \`live\`: un guion \`[{ "t": 0, "play": "idle" }, { "t": 1, "play":
"wave" }, { "t": 1.2, "set": { "happiness": 1 } }]\`. Por defecto la tira llega hasta que termina el último gesto
disparado (cada 0.25 s, como mucho 24 cuadros); \`until\` dice hasta cuándo y \`times\` elige los cuadros. El texto dice
qué suena en cada cuadro y con qué peso, y cuándo sonó cada auto \`repeat\` (un parpadeo suele caer entre cuadros). El
azar usa una semilla fija (el mismo guion da la misma tira) y \`auto: false\` apaga las capas auto para comparar. Al terminar un Puppet, lee **\`get_manifest\`**: es lo que recibe la IA de la app (params con qué poses
mueven, clips con su descripción, lo automático). Una descripción vacía o un param que no mueve nada ahí es un
problema para la app.

## Tipos

### \`meta\` (propiedades del documento, se cambian con \`target: "meta"\`)

${table(schema.meta.properties)}

${types}

## Cómo trabajar bien

1. **Mira el historial** (\`get_history\`, con \`origin: "user"\` para ver solo lo del usuario) antes de editar un
   documento existente. Esas entradas son retoques a mano: respétalos y no los pises.
2. **Usa grupos como articulaciones.** El \`x\`/\`y\` de un grupo es su pivote: para que una cabeza gire desde el
   cuello, pon el grupo \`head\` en el cuello y dibuja la cara con \`y\` negativa dentro del grupo.
3. **Mira el resultado** con \`render_preview\` después de cada cambio importante.
4. **Prefiere pocos lotes grandes** con una nota clara (\`note\`): cada lote es un paso de deshacer para el usuario.
5. Si te equivocas, \`undo\` deshace tu último lote (solo los tuyos, nunca los del usuario). Si el usuario cambió
   después alguna de las mismas propiedades, \`undo\` se niega y dice cuáles: corrígelas con un lote nuevo, sin
   pisar su retoque. A él le pasa lo mismo con lo tuyo. En una pose la unidad es cada objeto y propiedad
   (\`values.mouth.active\`), no la pose entera: si el usuario retocó otro objeto de la misma pose, tu \`undo\` deshace
   solo lo tuyo y deja lo suyo.
6. Para revisar un detalle chico, \`render_preview\` acepta \`region\` (un recorte del documento) además de \`pose\`.
7. \`delete_document\` borra un documento entero y no se puede deshacer: úsalo solo si el usuario lo pide.
8. No hay importador de SVG para la IA: pasa cada forma como \`d\` de un \`path\` (un path por subtrazado).
`;
}
