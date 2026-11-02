# Formato de personaje `aia/0.1`

Esta guía la leen las personas y también la IA (el MCP la entrega con la herramienta `format_guide`).
El formato todavía cambia: lo vamos ajustando con prueba y error.

## Estructura

```jsonc
{
  "format": "aia/0.1",
  "name": "Prueba",
  "canvas": { "width": 400, "height": 400 },
  "rig": {
    "bones":  [ ... ],   // jerarquía de huesos
    "parts":  [ ... ],   // dibujos SVG pegados a un hueso
    "slots":  [ ... ],   // grupos con varias versiones de un dibujo; se ve una sola
    "params": [ ... ]    // controles de alto nivel que usa la IA
  },
  "drivers": [ ... ]     // cómo cada param mueve huesos, partes y slots
}
```

Cada elemento tiene un `id` estable: minúsculas, números y `_`, empezando con letra (`eye_l`, `mouth`).

## Coordenadas

- El eje Y crece **hacia abajo**, como en SVG.
- `rotation` va en **grados**; los positivos giran en sentido horario.
- La posición de un hueso (`x`, `y`) es **relativa a su padre**. El hueso raíz se mide desde la esquina superior izquierda del canvas.
- El SVG de una parte se dibuja en las coordenadas locales de su hueso: `(0, 0)` es el pivote del hueso.

## bones

```json
{ "id": "head", "parent": "neck", "x": 0, "y": -20, "rotation": 0, "scaleX": 1, "scaleY": 1 }
```

`parent` es `null` en la raíz. `rotation`, `scaleX` y `scaleY` son opcionales (0, 1 y 1). Mover o girar un hueso
arrastra a todos sus hijos y a todo lo que tienen pegado.

## parts

```json
{ "id": "face", "bone": "head", "z": 3, "opacity": 1, "svg": "<ellipse cx='0' cy='-95' rx='80' ry='92' fill='#f2c4a0'/>" }
```

- `svg` es el contenido interno (sin la etiqueta `<svg>`). Conviene usar comillas simples dentro.
- `z` es el orden de dibujo: mayor queda encima. Con el mismo `z`, manda el orden de la lista.
- No se permiten `<script>`, `<foreignObject>`, atributos `on...` ni `javascript:`.

## slots

```json
{ "id": "mouth", "bone": "mouth", "z": 9, "active": "neutral",
  "options": { "neutral": "<path .../>", "smile": "<path .../>", "open": "<path .../>" } }
```

Sirven para bocas, ojos, manos: cosas que cambian de forma en vez de moverse.

## params

```json
{ "id": "happiness", "range": [-1, 1], "default": 0, "description": "Ánimo: -1 triste, 0 neutral, 1 feliz" }
```

Son la interfaz principal para controlar al personaje. La `description` dice qué significa cada extremo.

## drivers

Conectan un param con una propiedad. Hay dos tipos.

**Numérico (suma un desplazamiento):** `target` puede ser `bones.<id>.x|y|rotation|scaleX|scaleY` o `parts.<id>.opacity`.

```json
{ "id": "turn_head", "param": "head_turn", "target": "bones.head.rotation", "in": [-1, 1], "out": [-10, 10] }
```

El valor del param se interpola por tramos entre los puntos de `in` y `out`, y se **suma** al valor del montaje.
Fuera de `in`, se usa el extremo. Con más puntos se hacen curvas: `"in": [-1, 0, 1], "out": [-14, 0, 0]` solo actúa
con valores negativos. Varios drivers sobre la misma propiedad se suman.

**De slot (elige una opción):** `target` es `slots.<id>.active`.

```json
{ "id": "mood_mouth", "param": "happiness", "target": "slots.mouth.active", "steps": [[-1, "sad"], [-0.35, "neutral"], [0.35, "smile"]] }
```

Se elige la última opción cuyo umbral alcanzó el param. Si no alcanzó ninguno, no cambia nada. Los drivers se aplican
en orden, así que uno posterior puede pisar a uno anterior (por ejemplo, `mouth_open` pisa la boca del ánimo).

## Operaciones

Toda modificación es un lote de operaciones con rutas legibles. Dentro de una lista, el segmento de la ruta es el `id`.

```jsonc
{ "op": "set",    "path": "rig.bones.head.rotation", "value": 10 }
{ "op": "add",    "path": "rig.bones", "value": { "id": "hat", "parent": "head", "x": 0, "y": -190 } }
{ "op": "remove", "path": "drivers.blink_r" }
{ "op": "set",    "path": "rig.slots.mouth.options.surprised", "value": "<ellipse rx='10' ry='14' fill='#7a2e3b'/>" }
```

- `set` cambia o crea una propiedad. No reemplaza elementos enteros de una lista: para eso, `remove` y luego `add`.
- `add` agrega al final de una lista (o en `index`).
- `remove` quita un elemento de una lista o una propiedad.
- Un lote es **atómico**: si el resultado no es válido (padre inexistente, ciclo, svg prohibido...), no se aplica nada
  y se devuelve la lista de errores.
- Cada lote queda en el historial con su origen (`ai` o `user`).

## Consejos para la IA

- Antes de editar, mira el **historial**: si el usuario retocó algo a mano, respeta ese cambio y no lo pises.
- Prefiere crear **params con drivers** antes que mover huesos sueltos: un param bien nombrado sirve para siempre.
- Al agregar una parte nueva, primero crea su hueso con el pivote donde debe girar (una ceja gira desde su centro;
  un brazo, desde el hombro).
- Revisa el resultado con `render_svg`, probando valores extremos de los params.
