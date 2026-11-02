# Síntesis: qué tomamos de Moho y de Rive

> Estado: **propuesta inicial** (2026-10-29). Las decisiones marcadas como *propuesta* hay que
> confirmarlas antes de escribir código. Los detalles y las fuentes están en
> [investigacion/moho-lua.md](investigacion/moho-lua.md) y
> [investigacion/rive-runtime.md](investigacion/rive-runtime.md).

## 1. Lo que aprendimos en una frase

- **Moho** es un buen modelo **para el animador**: huesos con binding sencillo, smart bones
  (un control que reproduce una acción), switch layers y canales tipados en los que cada
  keyframe lleva su propia interpolación. Tiene dos puntos débiles: los IDs enteros dependen
  del orden y parte del significado depende de los nombres.
- **Rive** es un buen modelo **para el runtime**: tipos definidos en *defs* declarativos que
  sirven de fuente única de verdad, actualización incremental con dirty flags y orden de
  dependencias, state machine por capas y data binding con view models tipados. Es binario
  y usa claves numéricas, así que es opaco para una IA.

Ninguno de los dos fue pensado para que un LLM lo edite. Ese es nuestro hueco.

## 2. Decisiones de base (propuesta)

### 2.1 Un esquema declarativo como fuente única de verdad *(de Rive)*

Cada tipo (`bone`, `shape`, `slot`, `param`...) se describe una sola vez en un archivo de
esquema, con sus propiedades, tipos, valor inicial, si es animable y una descripción. De ese
esquema salen:

- la validación del JSON,
- la documentación que se le pasa a la IA (qué puede tocar y con qué rangos),
- los paneles de propiedades del editor,
- los get/set del runtime.

Así se añade un tipo una vez y aparece en los cuatro sitios.

### 2.2 El documento es JSON legible con IDs de texto estables *(lo contrario de ambos)*

- IDs de texto que no cambian (`"head"`, `"mouth_smile"`), nunca índices.
- Jerarquía con `parent: "<id>"` en una lista plana. Es fácil de editar con parches y no
  depende de la posición.
- Las rutas de propiedad son legibles: `bones.head.rotation`.
- El estado del editor (selección, vista, paneles) va **fuera** del documento.

### 2.3 Separar `rig` y `animación` *(de Moho: frame 0 = pose de montaje)*

```jsonc
{
  "format": "aia/0.1",
  "rig": {
    "bones":  [{ "id": "neck", "parent": null, "x": 0, "y": -40, "rotation": 0, "length": 30 }],
    "parts":  [{ "id": "head", "bone": "neck", "svg": "<path d='...'/>" }],
    "slots":  [{ "id": "mouth", "bone": "neck", "options": ["closed", "open", "smile", "O"], "active": "closed" }],
    "params": [{ "id": "happiness", "range": [0, 1], "default": 0 }]
  },
  "drivers":  [{ "param": "happiness", "in": [0, 1], "action": "smile", "out": [0, 1] }],
  "actions":  [{ "id": "smile", "tracks": [] }],
  "animations": [{ "id": "idle", "loop": "loop", "tracks": [] }],
  "stateMachine": { "layers": [] }
}
```

### 2.4 Parámetros y drivers explícitos en vez de smart bones mágicos *(Moho + Rive)*

En Moho, un smart bone se reconoce porque su acción tiene el mismo nombre. Nosotros lo
hacemos explícito: un **param** (`happiness`, `head_turn`, `mouth_open`) tiene un rango, y
los **drivers** dicen qué acción reproduce y en qué tramo. Los params son la interfaz
principal de la IA, igual que los view models de Rive. Sustituyen a los inputs de la state
machine, que Rive ya marcó como deprecados.

### 2.5 Canales tipados con interpolación por keyframe *(de Moho)*

Tipos de canal: `number`, `vec2`, `color`, `bool` y `string` (este último para slots).
Cada keyframe lleva su `interp`. Empezamos con `linear`, `step`, `ease-in-out` y `bezier`, y
dejamos `elastic` y `bounce` para más adelante.

### 2.6 Switch / slot *(Moho switch layer ≈ Rive Solo)*

Un grupo con un único hijo visible, elegido por un canal `string`. Sirve para bocas,
visemas, manos y ojos. Lo copiamos tal cual.

### 2.7 Binding: empezar simple

- **v1**: *layer binding*. Cada parte SVG se pega a un hueso con `<g transform>` y no se
  deforma. Es estilo recortable, funciona perfecto en SVG y alcanza para muchísimo.
- **v2**: pesos por vértice (como máximo 4 huesos, como el skin de Rive). El atributo `d` se
  recalcula en JS.
- **Más adelante**: mallas de imagen en una capa canvas.

### 2.8 Runtime: el modelo manda y el SVG es una proyección *(de Rive)*

- Los setters solo marcan como sucio; un `update()` por frame recalcula en orden de
  dependencias.
- El DOM SVG solo se toca en lo que cambió.
- Un **Renderer abstracto** (SVG primero) deja abierta la puerta a canvas o WebGL si hace
  falta rendimiento.

### 2.9 Una sola API de operaciones para la IA y el editor *(de MohoMCP, pero nativa)*

Toda modificación es una **operación** serializable:

```js
{ "op": "set",    "path": "rig.params.happiness.default", "value": 0.8 }
{ "op": "add",    "type": "bone", "data": { "id": "arm_l", "parent": "torso" } }
{ "op": "key",    "anim": "wave", "path": "bones.arm_l.rotation", "t": 0.5, "value": 40 }
```

- El editor visual emite las mismas operaciones que la IA.
- Las operaciones se aplican **en lotes atómicos**, con undo/redo y validación contra el
  esquema antes de aplicarse.
- Cada lote guarda quién lo hizo (`ai` o `user`). Así la IA ve qué corrigió el usuario y no
  lo pisa.

## 3. Qué evitamos

| Problema en Moho / Rive | Qué hacemos nosotros |
| --- | --- |
| IDs enteros que dependen de la posición | IDs de texto estables |
| Significado escondido en convenciones de nombres | Relaciones explícitas (`drivers`, `bone`) |
| Estado de la UI mezclado con los datos | Documento limpio, estado del editor aparte |
| Formato binario o sin esquema publicado | JSON con esquema versionado (`format: "aia/0.1"`) |
| Scripts con efectos laterales en cada redibujado | Solo operaciones declarativas en la v1 |
| Ciclos de dependencias sin validar | Detección de ciclos al aplicar operaciones |

## 4. Orden de construcción sugerido

1. **Esquema + validador**: los tipos `bone`, `part`, `slot`, `param` y `driver`.
2. **Runtime SVG mínimo**: cargar un documento, resolver huesos y dibujar las partes.
3. **Motor de operaciones**: `set`, `add`, `remove` y `key`, con lotes, undo y origen.
4. **Personaje de prueba**: unos 10 huesos, 4 params y slots de boca y ojos.
5. **Animación + state machine mínima**: `idle`, `talking` y `reacting`.
6. **Editor**: árbol, panel de propiedades generado del esquema y manipulación directa en el
   lienzo.
7. **Puente IA**: el esquema se exporta como descripción de herramientas para el LLM.

## 5. Decisiones confirmadas (2026-11-02)

- **Empezamos construyendo y ajustamos con prueba y error**, por fases ([plan.md](plan.md)). Un primer prototipo
  probó la idea y quedó guardado en la etiqueta de git `prototipo-0`; la base se rehace limpia.
- **Convenciones**: coordenadas como en SVG (Y hacia abajo), ángulos en grados con positivos en sentido horario y
  tiempo en **segundos** (los fps solo sirven para mostrar frames y para el snapping).
- **MCP desde el comienzo.** La IA del usuario (la que ya paga: Claude Desktop, Claude Code, Cursor...) maneja los
  personajes por un servidor MCP local, sin API keys. MCP y editor escriben los mismos archivos usando el mismo motor
  de operaciones, y cada lote queda en el historial con su origen.
- **Editor web estático con Vite** como servidor de desarrollo, JS puro sin framework. Vite aporta la API local para
  guardar y el aviso en vivo cuando un personaje cambia en disco.
- **Controles finos a mano para todo**: lo que puede tocar la IA, el usuario también lo puede retocar en el editor.
- **El personaje define cómo se mueve; la app decide cuándo.** Params, drivers y (más adelante) la state machine son
  datos del personaje. Comportamientos como el parpadeo automático o el lip-sync son código de la app que usa el
  personaje.
- **Lo que dejó el prototipo**: drivers numéricos aditivos con interpolación por tramos y drivers de slot con
  umbrales funcionaron bien para una cara simple. Son un caso particular de `param → acción` (sección 2.4), que es lo
  que se construye en la fase 4.

## 6. Formato de exportación (por definir)

El documento de edición (`personajes/*.json`) está pensado para crear y editar. Para **usar** el personaje en una
app con IA conviene un formato aparte. Propuesta inicial, a validar con el primer caso real:

- **Un solo archivo autocontenido** (`*.aia.json`) con el montaje, los drivers y las animaciones, sin historial ni
  datos del editor, y opcionalmente minificado.
- **Un manifiesto para la IA en tiempo de ejecución**: los params con su descripción y rango, expresiones con nombre
  (`feliz`, `pensando` = combinaciones de params) y estados. A partir de él, el runtime genera la descripción de
  herramientas para el LLM de la app (por ejemplo, `set_expression`, `look_at`), sin que la app tenga que escribirla.
- **El runtime liviano** (`src/runtime/` + `src/core/`) como paquete JS sin dependencias.
- Pendiente: cómo entra el audio (lip-sync por volumen o por visemas) y si conviene exportar también a Lottie o video.

## 7. Preguntas abiertas

- ¿Deformación por pesos (v2) en el corto plazo o el estilo recortable alcanza al principio?
- ¿Personajes generados por la IA desde piezas de una biblioteca, o dibujados por el usuario
  y animados por la IA?
- ¿Hace falta importar `.moho` o `.riv` existentes? Por ahora no; es caro y no es la base.
- Hay que descomprimir un `.moho` real para verificar el esquema de keyframes, que no está
  documentado públicamente.
