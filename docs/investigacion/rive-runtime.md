# Investigación: cómo está construido Rive por dentro

> Objetivo: extraer del código abierto de Rive (runtime C++, runtimes web y documentación) las ideas útiles para el modelo de datos JSON y el runtime SVG de **aia-studio**, un editor de personajes 2D pensado para que un LLM los manipule y un humano los corrija.
>
> Fecha de la investigación: 2026-10-29.
>
> **Convención:** **[V]** = verificado leyendo código o documentación oficial (con ruta en Fuentes). **[I]** = inferencia u opinión nuestra.

---

## 0. Resumen ejecutivo

- **Una sola fuente de verdad declarativa.** [V] Todo el modelo de objetos de Rive (cerca de 400 tipos: artboard, nodos, formas, vértices, huesos, constraints, animaciones, máquinas de estado, data binding, texto, layout, scripting...) se describe en archivos JSON (`dev/defs/**.json`). Un generador en Dart (`dev/core_generator`) produce a partir de ellos las clases base C++ (`include/rive/generated/*_base.hpp`), el registro `CoreRegistry` (fábrica por `typeKey`, setters/getters genéricos por `propertyKey`) y las variantes del editor. Cada tipo tiene una **clave numérica estable** (`typeKey`), y cada propiedad tiene otra (`propertyKey`) **única en todo el sistema**. Esa unicidad global es lo que permite animar, serializar y bindear "cualquier propiedad" con el mismo mecanismo.
- **Formato `.riv`.** [V] Es binario little-endian: cabecera `RIVE` + versión mayor/menor + fileId + una tabla de contenidos (ToC) que da a cada propiedad no "baseline" un tipo de respaldo de 2 bits. Así un runtime viejo puede **saltar propiedades desconocidas**. Los objetos van en una lista plana `typeKey (varuint), [propertyKey, valor]*, 0`. La jerarquía se expresa con `parentId`, un **índice dentro del artboard**, no con anidación.
- **Runtime con grafo de dependencias.** [V] Hay una inicialización en fases (`onAddedDirty` → `onAddedClean` → `buildDependencies` → orden topológico). Cada componente recibe un `graphOrder`. Los cambios marcan **dirty flags** (bitmask `ComponentDirt`), y `updateComponents()` recorre el orden topológico actualizando solo lo sucio, con reinicio si algo de "más arriba" se ensucia.
- **Animación = mezcla de valores sobre propiedades por clave.** [V] `LinearAnimation → KeyedObject(objectId) → KeyedProperty(propertyKey) → KeyFrame(frame, valor, interpolación)`. Aplicar una animación escribe `valor = actual·(1−mix) + clave·mix`. Las máquinas de estado y los blend states se reducen a llamar a `apply` con distintos `mix`.
- **State machine.** [V] Tiene capas independientes. Cada capa evalúa primero las transiciones del estado **Any** y luego las del estado actual (condiciones con AND, exit time, duración de mezcla), con un máximo de 100 cambios por frame. Los **inputs** (bool/number/trigger) están **deprecados**: Rive recomienda ahora **Data Binding** (View Models tipados, bidireccionales, observables).
- **Render.** [V] El runtime dibuja contra un `Renderer` abstracto muy pequeño (`save/restore/transform/drawPath/clipPath/drawImage/drawImageMesh/modulateOpacity`). En web usa el **Rive Renderer** sobre WebGL2, o Canvas2D. Nunca usa DOM ni SVG. [I] Para aia-studio el SVG es viable si mantenemos el **modelo como fuente de verdad** y el DOM SVG como una **proyección** que se actualiza de forma incremental. No conviene reproducir el pipeline de Rive (skinning y meshes los haríamos en JS y emitiríamos `d` de paths).
- **Recomendación central.** [I] Copiar el patrón "defs declarativos → código, validadores y documentación para el LLM". Usar **IDs y nombres de propiedad legibles** en lugar de enteros. Mantener la lista plana con `parent`. Mantener las dirty flags y el orden topológico. Usar data binding (View Model) como API principal de control. Simplificar los tipos de vértice, las constraints y los listeners.

---

## 1. El formato `.riv`

### 1.1 Primitivas y cabecera [V]

Fuentes: documentación "Rive format" e `include/rive/runtime_header.hpp`, `src/file.cpp`.

| Campo | Codificación | Notas |
|---|---|---|
| Fingerprint | 4 bytes `0x52 0x49 0x56 0x45` ("RIVE") | Comprobación rápida. |
| Major version | varuint (LEB128) | Actualmente **7**. Si no coincide con la del runtime: `ImportResult::unsupportedVersion`. |
| Minor version | varuint | Compatible dentro de la misma major. En el runtime solo se usa para diagnóstico. |
| File ID | varuint (64 bits) | Identifica la exportación. Puede ser 0. |
| ToC | lista de varuint `propertyKey` terminada en `0`, seguida de un array de bits | 2 bits por clave. Se leen palabras `uint32`, pero solo se usan los 8 bits bajos de cada una (4 claves por palabra). |

Tipos de respaldo en la ToC: `0 = uint/bool`, `1 = string`, `2 = float`, `3 = color`. Los strings son un varuint de longitud seguido de bytes UTF-8. Los floats son IEEE754 de 32 bits. El color es un `uint32` ARGB. [V para los tipos. Lo de ARGB es una inferencia por la API web, que usa `0xFF000000`.]

**Propiedades "baseline".** [V] Las propiedades que existen desde la última major **no se listan** en la ToC, porque todo runtime de esa major las conoce. Solo aparecen las añadidas en minors posteriores.

### 1.2 Serialización de objetos [V]

```
objeto   := typeKey:varuint  propiedad*  0
propiedad:= propertyKey:varuint  valor(según tipo de la propiedad)
```

Ejemplo de la documentación: un `Node` (typeKey 2) con x=100, y=22 se serializa como `2, 13, 100.0f, 14, 22.0f, 0`.

- **Las propiedades con valor por defecto no se escriben.** El generador define `initialValue` / `initialValueRuntime`. [V que existen los defaults. Que el exportador omita los valores por defecto es una inferencia [I], coherente con el formato.]
- **El contexto da la pertenencia.** Los objetos llegan en orden: el Artboard, luego todos sus componentes. Después `LinearAnimation`, seguida de sus `KeyedObject`, cada uno con sus `KeyedProperty`, cada una con sus `KeyFrame`. Luego `StateMachine`, `Layer`, estados, transiciones, condiciones... El lector mantiene una **ImportStack**: ciertos tipos empujan un "importer" (`ArtboardImporter`, `LinearAnimationImporter`, `KeyedObjectImporter`, `KeyedPropertyImporter`, `StateMachineImporter`, `LayerStateImporter`, `StateTransitionImporter`, importers de assets y de view models...). Los objetos siguientes se adjuntan al importer más reciente de su tipo. Al final se hace `importStack.resolve()`.
- **La jerarquía de la escena** no depende del orden de lectura: cada `Component` tiene `parentId`, un **índice del objeto dentro del artboard** (el artboard es el 0). En runtime, `Artboard::resolve(id)` es literalmente `m_Objects[id]`.

### 1.3 Compatibilidad hacia adelante [V]

- **Tipo desconocido.** `CoreRegistry::makeCoreInstance` devuelve `nullptr`. Sus propiedades se consumen igualmente y se inserta un "objeto nulo" en la ImportStack para no desalinear los índices. La importación continúa.
- **Propiedad desconocida.** Si el objeto no la deserializa, se busca su tipo primero en el registro y después en la ToC, y se salta el valor. Solo si la clave no aparece en ninguno de los dos el archivo se marca como `malformed`.
- **Comportamiento desconocido.** "Unsupported features are treated as no-ops." Ejemplo en el código: una condición de transición cuyo input es de un tipo desconocido (`nullptr`) se evalúa como `true`, para no bloquear la máquina.
- Las **majors no son compatibles entre sí**: un runtime 7 rechaza un archivo 6.

### 1.4 Defs y generación de código [V]

Ruta: `dev/defs/` (en el commit `845a82a…` del repo público. En `main`, desde el commit `d4fe102…` del 2026-08-25, la carpeta ya no está publicada: `configuration.dart` indica que el generador lee los defs canónicos del `dev/defs/` de la raíz del monorepo interno). La estructura es una carpeta por dominio: `animation/`, `bones/`, `constraints/`, `shapes/`, `shapes/paint/`, `text/`, `data_bind/`, `viewmodel/`, `layout/`, `assets/`, `scripted/`, `inputs/`, `semantic/`...

Forma de un def (ejemplo real, `transform_component.json`, abreviado):

```json
{
  "name": "TransformComponent",
  "key": { "int": 38, "string": "transformcomponent" },
  "abstract": true,
  "extends": "world_transform_component.json",
  "properties": {
    "rotation": { "type": "double", "initialValue": "0", "animates": true,
                  "key": { "int": 15, "string": "r" } },
    "scaleX":   { "type": "double", "initialValue": "1", "animates": true,
                  "group": "scale", "key": { "int": 16, "string": "sx" } }
  }
}
```

Campos a nivel de **tipo** (`definition.dart`): `name`, `key{int,string}`, `extends` (herencia simple por ruta de archivo), `abstract`, `runtime` (false = solo editor), `editorOnly`, `isMixin` / `mixin(s)`, `properties`.

Campos a nivel de **propiedad** (`property.dart`): `type` (double, uint, uint8/16, bool, String, Color, Id, List<Id>, FractionalIndex, Bytes...), `typeRuntime` (tipo en runtime, p. ej. `Id → uint`), `initialValue` / `initialValueRuntime`, `animates`, `interpolates`, `bindable`, `group`, `runtime`, `coop` (se sincroniza en la colaboración del editor), `editorOnly`, `description`, `nullable`, `virtual` / `pureVirtual`, `overrideGet/Set`, `passthrough` (+ `passthroughForBitmask`, `passthroughBit`, `passthroughBitWidth`: propiedades lógicas empaquetadas en bits de otra), `encoded`, `sidecar`.

Qué genera:
- `<nombre>_base.hpp/.cpp` con `static const uint16_t typeKey`, constantes `xPropertyKey = 13`, campos `m_X`, setters que **retornan si el valor no cambia**, asignan, llaman al hook virtual `xChanged()` y a `notifyPropertyChanged(key)`, además de `deserialize(propertyKey, reader)` (un switch que delega en el padre) y `copy()`.
- `<nombre>.hpp`, solo si no existe: es la clase concreta escrita a mano que hereda de la base. **Separa lo generado de lo manual.**
- `core_registry.hpp`: `makeCoreInstance(typeKey)`, `setDouble/getDouble/setUint/setColor/...(object, propertyKey, value)`, `propertyFieldId(key)`, `objectSupportsProperty`, `isInterpolatableUint`, etc. **Las animaciones y el data binding usan esta reflexión por clave**, no código específico de cada tipo.
- Validaciones: typeKeys duplicados, propertyKeys duplicados (globalmente), claves < 3 reservadas, coherencia de los bitmasks.

Otros detalles: los defs mezclan propiedades de runtime y de editor (p. ej. `LinearAnimation.playhead`, `viewStart`, `expandedComponents` llevan `runtime:false`). El mismo esquema sirve al editor, al runtime y a la colaboración.

---

## 2. Modelo de objetos

### 2.1 Jerarquía de clases (parcial) [V]

```
Core
└─ Component (10)              name, parentId, (editor: childOrder, tagIds, flags, dependentIds)
   └─ ContainerComponent
      └─ WorldTransformComponent (91)   opacity
         └─ TransformComponent (38, abstract)  rotation(15), scaleX(16), scaleY(17)
            ├─ Node (2)                x(13), y(14)  (+ propiedades computadas bindables: worldX, width...)
            │  ├─ Drawable (13, abstract)  blendModeValue(23), drawableFlags
            │  │   ├─ Shape            (contiene Paths y ShapePaints)
            │  │   ├─ Image, Text, NestedArtboard, ...
            │  ├─ Solo (147)           activeComponentId(296)
            │  └─ LayoutComponent → Artboard (1)  originX/Y, defaultStateMachineId, viewModelId
            └─ SkeletalComponent → Bone (40) length(89) → RootBone (x,y propias)
```

- **Path**: `Path` (abstract) → `PointsPath` (vértices libres) y `ParametricPath` (`Rectangle`, `Ellipse`, `Polygon`, `Star`, `Triangle`). También existe `ListPath`.
- **Vértices** (`shapes/`): `PathVertex` → `StraightVertex` (x, y, **radius** = redondeo de esquina) y `CubicVertex` → `CubicMirroredVertex` (rotación + distancia, simétrico), `CubicAsymmetricVertex` (rotación común, distancias distintas), `CubicDetachedVertex` (inRotation/inDistance/outRotation/outDistance, keys 84–87). **Los tangentes se guardan en polares** (ángulo + distancia), lo que facilita animarlos.
- **Paint** (`shapes/paint/`): `ShapePaint` → `Fill` (fillRule) y `Stroke` (thickness, cap, join, transformAffectsStroke). El "color" de un paint es un hijo: `SolidColor`, `LinearGradient` (startX/Y, endX/Y, opacity; key 22) o `RadialGradient`, con `GradientStop` como hijos (color, position). Efectos: `TrimPath`, `Dash`/`DashPath`, `Feather`, `GroupEffect`/`TargetEffect`. **Un Shape puede tener N fills y N strokes**, apilados en el orden de sus hijos.
- **Huesos** (`bones/`): `Bone`, `RootBone`, `Skin` (hijo del path o mesh deformable), `Tendon` (key 44: `boneId` + matriz de bind `xx,yx,xy,yy,tx,ty`), `Weight` (key 45: `values` y `indices` como **uint32 que empaquetan 4 bytes**: 4 huesos por vértice, peso/255) y `CubicWeight` (pesos separados para in/out de un vértice cúbico).
- **Constraints** (`constraints/`): `Constraint` (strength) → `TargetedConstraint` (targetId) → `IKConstraint` (invertDirection, parentBoneCount), `DistanceConstraint`, `FollowPathConstraint`, `TransformConstraint`, y `TransformComponentConstraint` (copyFactor, min/max, offset, doesCopy, espacios de origen y destino) → `TranslationConstraint`, `RotationConstraint`, `ScaleConstraint`. Además hay `DraggableConstraint` y `scrolling/`. **Las constraints son hijos del objeto restringido.**
- **Mesh**: `Mesh` (hijo de una `Image`, con triángulos en `Bytes`) y `MeshVertex` (x, y, u, v; keys 215/216), deformable por Skin.
- **Texto** (`text/`): `Text`, `TextValueRun` (trozos de texto con estilo), `TextStyle` (+axis/feature/paint), modificadores (`TextModifierRange`, `TextVariationModifier`, `TextFollowPathModifier`) y `TextInput*`.
- **NestedArtboard**: referencia a otro artboard del archivo (`artboardId`), con hijos `NestedStateMachine` / `NestedSimpleAnimation` / `NestedRemapAnimation` e inputs anidados. Se instancia y se dibuja con el `worldTransform` del host. Con data binding se puede **cambiar el artboard en runtime** (propiedad artboard de un view model).
- **Solo** [V]: un Node con `activeComponentId`. Los hijos "opción" que no son el activo se **colapsan** (`ComponentDirt::Collapsed`: quedan fuera del ciclo de update y no se dibujan). Los hijos que no son opción (constraints, clipping...) heredan el estado del Solo. Se puede cambiar por id, índice o nombre (lo usa el data binding). Es exactamente el "switch" de sprites o expresiones de cara.
- Otros: `ClippingShape`, `DrawRules`/`DrawTarget` (reordenar el dibujo en runtime), `Event`/`OpenUrlEvent`/`AudioEvent`, `CustomProperty*`, `LayoutComponent` (usa **Yoga** internamente, bajo `WITH_RIVE_LAYOUT`), `ScriptedObject`.

### 2.2 Padres, hijos e inicialización [V]

`Artboard::initialize()` (en `src/artboard.cpp`) recorre `m_Objects` en varias pasadas:

1. **`onAddedDirty(context)`**: cada objeto resuelve sus referencias por id (p. ej. un Node busca a su padre con `parentId`). No puede asumir que el abuelo ya esté resuelto.
2. **`onAddedClean`**: ya todo está resuelto, así que se pueden recorrer cadenas (p. ej. un Path busca el Shape ancestro y se registra, el IK construye su cadena de huesos y el Skin se registra en su Skinnable).
3. **`buildDependencies()`**: cada componente declara de qué depende (`addDependent`). Un hijo depende de su padre, un Skin depende de sus huesos, una constraint de su target, etc.
4. **`sortDependencies()`**: `DependencySorter` hace un **orden topológico** y asigna `m_GraphOrder` a cada componente. Las instancias reutilizan el orden calculado en el artboard fuente.
5. Construcción de draw targets y `sortDrawOrder()`: una **lista doblemente enlazada de drawables**, con proxies de clip y máscaras.

### 2.3 Dirty flags y ciclo de update [V]

`ComponentDirt` (en `include/rive/component_dirt.hpp`) es un bitmask: `Collapsed`, `Dependents`, `Components` (se activa siempre que hay cualquier otra suciedad), `DrawOrder`, `Path`/`TextShape`/`Skin` (comparten el bit 4), `Vertices`, `Transform`, `WorldTransform`, `RenderOpacity`, `Paint`, `Stops`, `LayoutStyle`, `Bindings`, `NSlicer`/`BindingsTarget`, `ScriptUpdate`, `Clipping`.

```cpp
// esencia de Artboard::updateComponents()
while (hasDirt(Components) && step < 100) {
  m_Dirt &= ~Components;
  for (i = 0; i < m_DependencyOrder.size(); i++) {
    m_DirtDepth = i;
    auto d = component->m_Dirt;  if (d == None || collapsed) continue;
    component->m_Dirt = None;
    component->update(d);
    if (m_DirtDepth < i) break;   // alguien ensució algo anterior → reiniciar
  }
}
```

Y en `onComponentDirty`: `if (component->graphOrder() < m_DirtDepth) m_DirtDepth = component->graphOrder();`.

Un setter generado llama a `xChanged()`, que hace por ejemplo `markTransformDirty()`. Eso propaga la suciedad a los dependientes (`WorldTransform` en los hijos) y avisa al artboard. **Nada se recalcula en el setter. Todo se difiere al `update` ordenado.** Así varias escrituras en el mismo frame (animación + binding + constraint) cuestan una sola actualización.

---

## 3. Animación

### 3.1 Estructura [V]

| Objeto | key | Propiedades runtime |
|---|---|---|
| `LinearAnimation` | 31 | `name`, `fps`(56, def. 60), `duration`(57, **en frames**), `speed`(58), `loopValue`(59), `workStart`/`workEnd`/`enableWorkArea`, `quantize` |
| `KeyedObject` | 25 | `objectId`(51): índice del componente en el artboard |
| `KeyedProperty` | 26 | `propertyKey`: la **clave global de la propiedad animada** (p. ej. 13 = x) |
| `KeyFrame` (abstract) | 29 | `frame`(67) en frames |
| `InterpolatingKeyFrame` | 170 | `interpolationType`(68: 0 hold, 1 linear, 2 cubic…), `interpolatorId`(69) |
| `KeyFrameDouble/Color/Bool/Id/Uint/String/Int/Callback` | – | `value` |
| `CubicEaseInterpolator`, `CubicValueInterpolator` | – | x1, y1, x2, y2 (como cubic-bezier de CSS) |
| `ElasticInterpolator` | 174 | `easingValue` (in/out/inOut), `amplitude`, `period` |

Los interpoladores son **objetos compartidos** referenciados por id desde los keyframes (y desde las transiciones).

### 3.2 Aplicación y mix [V]

- `LinearAnimation::apply(artboard, time, mix)`: opcionalmente cuantiza (`floor(t·fps)/fps`) y llama a `apply` en cada KeyedObject, que resuelve el objeto y aplica cada KeyedProperty.
- `KeyedProperty::apply`: hace una **búsqueda binaria** del keyframe. Antes del primero aplica el primero. Después del último mantiene el último. Entre dos keyframes: si `interpolationType == 0` (hold) aplica el anterior, y si no, `applyInterpolation`.
- `KeyFrameDouble`: `f = (t − t0)/(t1 − t0)`, `v = interpolator ? interpolator.transform(from, to, f) : from + (to−from)·f`, y luego **`prop = prop·(1−mix) + v·mix`** (con `mix == 1` asigna directamente). Todo se hace por reflexión: `CoreRegistry::setDouble(object, propertyKey, …)`.
- Cubic: tabla de muestras + hasta 4 iteraciones de **Newton-Raphson** (pendiente mínima 0.001) con bisección de respaldo (precisión 1e-7, máx. 10 iteraciones). Es el algoritmo clásico de `cubic-bezier`.
- Bools, ids y uints mantienen su valor por defecto (sin interpolar) salvo que el def diga `interpolates: true`.

### 3.3 Loop modes [V]

`enum Loop { oneShot = 0, loop = 1, pingPong = 2 }`. `LinearAnimationInstance::advance(dt)` hace `t += dt·speed·direction` y trabaja en frames dentro de `[start, end]` (work area o duración):
- **oneShot**: clampa al borde, marca `didLoop` y guarda el tiempo sobrante (`spilledTime`, que se usa para encadenar estados sin perder tiempo).
- **loop**: `fmod`.
- **pingPong**: refleja e invierte la dirección (con soporte para varios rebotes en un frame).
- Los **eventos y callbacks** con clave se reportan por el intervalo recorrido, también al cruzar el loop.

---

## 4. State Machine y Data Binding

### 4.1 Objetos [V]

- `StateMachine` → `inputs` (`StateMachineBool`, `StateMachineNumber`, `StateMachineTrigger`), `layers` (`StateMachineLayer`), `listeners` (`StateMachineListener`, key 654, `targetId` + acciones).
- Estados (`LayerState`): `EntryState`, `ExitState`, `AnyState`, `AnimationState` (animationId), `BlendState1D` (con input o con propiedad de view model) + `BlendAnimation1D` (value), `BlendStateDirect` + `BlendAnimationDirect` (cada animación con su propio input de mezcla).
- `StateTransition` (key 65): `stateToId`, `flags` (Disabled, DurationIsPercentage, EnableExitTime, ExitTimeIsPercentage, PauseOnExit, EnableEarlyExit, ...), `duration` (ms o %), `exitTime`, `interpolationType`/`interpolatorId` (curva de la mezcla) y `randomWeight`. Condiciones hijas: `TransitionBoolCondition`, `TransitionNumberCondition` (op ==, !=, <=, <, >=, >; value), `TransitionTriggerCondition`, condiciones sobre view model, artboard o focus, y `ScriptedTransitionCondition`.
- Listeners: tipos de puntero (down, up, enter, exit, move, click...) y acciones `ListenerBoolChange`, `ListenerNumberChange`, `ListenerTriggerChange`, `ListenerViewModelChange`, `ListenerFireEvent`, `ListenerAlignTarget` (arrastrar) y `ScriptedListenerAction`.
- **Inputs deprecados.** La documentación dice literalmente "DEPRECATED: Use Data Binding instead of Inputs". Se mantienen solo por compatibilidad.

### 4.2 Avance por frame [V]

`StateMachineInstance::advance(dt, newFrame)`:
1. Procesa eventos de foco y semánticos y aplica los eventos reportados en el frame anterior (`applyEvents` → notifica a los listeners).
2. `updateDataBinds()`.
3. Para cada capa, `layer.advance(dt)`:
   - Avanza el estado actual y la mezcla (`mix = clamp(mix + dt/mixTime)`). Si el estado anterior sigue mezclándose, también lo avanza.
   - `apply()`: escribe el estado saliente con `interp(mixFrom)` y el entrante con `interp(mix)`. Lo hace sobre las mismas propiedades, así que el resultado es un crossfade.
   - Bucle `updateState()`: primero `tryChangeState(AnyState)` y luego `tryChangeState(current)`. Se toma la **primera transición permitida en orden** (o una aleatoria ponderada si la capa tiene el flag Random). `allowed()`: deshabilitada → no; **todas las condiciones (AND)**; si hay exit time y el tiempo no llegó → `waitingForExit`. Al cambiar, el nuevo estado arranca con el tiempo sobrante del anterior.
   - Límite: **100 iteraciones** por frame. Si se superan, se registra un error (protege de ciclos).
   - Optimización: una capa "asentada" (sin transiciones posibles y sin cambios de valores) deja de evaluarse hasta que algo relevante cambia (`unsettleLayers`).
4. `advanceDataBinds(dt)`.
5. `input->advanced()` para todos los inputs: aquí se **reinician los triggers** (duran un frame de evaluación).
6. Devuelve si hace falta seguir avanzando (`needsAdvance`). Con eso el host puede **dormir** cuando nada se mueve.

Los nested artboards se avanzan aparte (`advanceAndApply` → `AdvanceNested`).

**Blend 1D** [V]: busca (binaria) los dos `BlendAnimation1D` que rodean el valor, `mix = (v − from)/(to − from)` y aplica `from` con `1−mix` y `to` con `mix`.

**Pointer events** [V]: se transforma el punto al espacio del artboard, se hace hit-test de los componentes "hit" en orden de dibujo (lo que devuelve `hitOpaque` bloquea lo de debajo), fase de captura y propagación a nested artboards.

### 4.3 Data Binding / View Models [V]

- **ViewModel** = esquema tipado (number, string, boolean, color, enum, trigger, list, image, font, artboard, view model anidado). **ViewModelInstance** = valores concretos. El Artboard tiene `viewModelId` y puede tener una instancia por defecto.
- Los **DataBind** se adjuntan a la propiedad de un objeto (en el archivo, un DataBind se adjunta "al último objeto no-DataBind leído"). Pueden ser source→target, target→source o bidireccionales, y pueden pasar por **Data Converters** (cadenas de conversión, también scriptables). Las suciedades `Bindings`/`BindingsTarget` integran esto en el ciclo de update.
- API web (`@rive-app/*`):
  ```js
  const r = new rive.Rive({ src, canvas, stateMachine: "SM", autoBind: true, onLoad() {
    const vmi = r.viewModelInstance;
    vmi.number("Mood/happiness").value = 0.8;   // rutas con "/"
    vmi.trigger("blink").trigger();
    vmi.enum("expression").value = "smile";
    vmi.number("Mood/happiness").on(e => console.log(e.data));
  }});
  ```
- Las propiedades del view model son observables (polling y listeners). Los inputs solo admiten polling. Los bindings **no dependen de la jerarquía**: se puede reorganizar la escena sin romper el código de la app.

### 4.4 Scripting (2025-2026) [V]

Scripting en **Luau** dentro del editor y del runtime (VM Luau en el runtime C++, y en 2026 se añadió un "wasm script execution lane"). Usa "protocolos" con scaffolding tipado: Node (dibujo propio), Converter (data binding), Layout, PathEffect y Test, además de condiciones de transición y acciones de listener scriptadas. El editor incluye un **agente de IA** que genera scripts y view models con diffs que el usuario acepta o rechaza. Esto valida nuestra tesis de "IA propone, humano revisa".

---

## 5. Pipeline de render

### 5.1 Renderer abstracto [V]

`include/rive/renderer.hpp`:
- `RenderPath` (`addRenderPath`, `addRawPath`, fillRule), `RenderPaint` (style fill/stroke, color, thickness, join, cap, blendMode, shader), `RenderShader` (gradientes), `RenderImage`, `RenderBuffer` (vértices e índices para meshes).
- `Renderer`: `save()`, `restore()`, `transform(Mat2D)`, `drawPath(path, paint)`, `clipPath(path)`, `drawImage`, `drawImageMesh`, `modulateOpacity`.
- Los objetos de render se crean a través de una `Factory` (cada backend implementa la suya).

El runtime **construye la geometría en CPU** (`Path::buildPath` → `RawPath` con move, line y cubic, incluido el redondeo de esquinas de `StraightVertex.radius` y la deformación por skin o mesh) y solo entrega al backend paths ya transformados, paints e imágenes. El orden de dibujo es la lista enlazada de drawables, con proxies de clip.

### 5.2 Backends y por qué no SVG/DOM [V + I]

- [V] Al principio usaban Skia y Canvas2D. Los dejaron por la inconsistencia entre plataformas ("a feature missing from one renderer would not work on every backend"). El **Rive Renderer** (open source) es un rasterizador vectorial para GPU que reduce los paths antialiasados a parches de triángulos. Sobre él construyen feathering, blurs y glows.
- [V] Paquetes web: `@rive-app/webgl2` (recomendado: Rive Renderer, feathering, máxima fidelidad con el editor), `@rive-app/canvas` (Canvas2D del navegador, sin feathering, blend modes nativos, sin límite de contextos), `canvas-lite` (sin texto, layout, audio ni scripting) y `canvas-single` (wasm embebido). `webgl` está deprecado.
- [I] Por qué no SVG/DOM: (1) cada frame cambian cientos de propiedades, y mutar atributos del DOM cuesta estilo, layout y repintado; (2) skinning y mesh deforman vértices por frame, algo que SVG no hace de forma nativa; (3) necesitan un render idéntico en iOS, Android, Unity, Unreal y web, y SVG solo existe en el navegador; (4) las imágenes con malla deformada (`drawImageMesh`) no tienen equivalente en SVG.

### 5.3 Implicaciones para aia-studio con SVG [I]

- **Ventajas de SVG para nuestro caso**: inspección en devtools, selección y hit-test nativos, accesibilidad, edición manual de nodos, exportación trivial, CSS. Para personajes de decenas o pocos cientos de partes, el rendimiento es aceptable si:
  - Se **escribe solo lo sucio** (dirty flags → actualizar `transform` en el `<g>` y `d` en el `<path>` solo cuando cambian).
  - Se usan **transforms jerárquicos con `<g transform>`** para el FK. Así el navegador compone las matrices, y solo calculamos matrices mundiales cuando algo las necesita (IK, constraints, skinning).
  - Skinning: se calcula en JS (igual que `Weight::deform`: 4 influencias, matriz mezclada) y se emite el `d` resultante en coordenadas del Skin. Es caro si hay muchos vértices: hay que limitar el número de vértices y huesos por pieza.
  - Las mallas de imagen no se pueden hacer bien en SVG. Alternativas: imágenes rígidas por hueso (cut-out), o una capa `<canvas>`/WebGL opcional solo para meshes.
  - Batch por `requestAnimationFrame`. Evitar filtros SVG animados (son caros). El orden de dibujo es el orden del DOM: reordenar con `insertBefore` solo cuando cambia `DrawOrder`.
- Diseñar el runtime con un **Renderer abstracto** propio (`SvgRenderer` primero, `CanvasRenderer` posible después) para no atar el modelo al DOM.

---

## 6. Lecciones y recomendaciones para aia-studio

### 6.1 Copiar

1. **Defs declarativos como fuente única de verdad** [I, inspirado en lo verificado]. Un `schema/defs/*.json` (o TS) por tipo con `name`, `extends`, `abstract`, y por propiedad `type`, `default`, `animatable`, `bindable`, `min/max`, `enum`, `description` y `runtime/editorOnly`. Desde ahí se generan: tipos TS, validadores (JSON Schema/Zod), la **documentación para el prompt del LLM**, los inspectores del editor (campos de UI), los setters con dirty-marking y la tabla de reflexión `get/set(obj, prop)` para animación y binding.
2. **Reflexión por nombre de propiedad.** Las animaciones, los bindings y la API de la IA operan sobre `(objectId, propertyPath)`, nunca con código específico de cada tipo.
3. **Lista plana con `parent`** en lugar de árbol anidado. Facilita los diffs, los parches JSON (`{op:"set", id, prop, value}`), el reparenting y la estabilidad frente a ediciones del LLM. El árbol se reconstruye en la carga.
4. **Inicialización en fases** (resolver referencias → validar → construir dependencias → orden topológico) y **dirty flags + update en orden topológico**. Los setters nunca recalculan: solo ensucian.
5. **Animación = KeyedObject/KeyedProperty/KeyFrame + mezcla lineal con `mix`**. Interpoladores como objetos reutilizables (cubic-bezier compatible con CSS, elastic). Loop modes oneShot/loop/pingPong. Tiempo sobrante para encadenar estados.
6. **Data binding (View Model) como API pública principal**, por encima de los inputs: un esquema tipado ("mood", "expression" enum, "lookAt" x/y, "talking" bool, triggers "blink"/"wave") que la IA y la app manipulan sin conocer la jerarquía.
7. **Solo** para expresiones, bocas, manos y ropa intercambiable (un hijo activo, el resto colapsado y sin actualizar).
8. **Tolerancia hacia adelante**: ignorar (y conservar al guardar) tipos y propiedades desconocidos. Las condiciones sobre inputs inexistentes se evalúan como no-op o true. Versionado `major.minor` del formato.
9. **Límites de seguridad**: un máximo de cambios de estado por frame y un máximo de pasadas de update (100 en Rive). Es crítico si un LLM genera grafos con ciclos.
10. **Tangentes en polares** (ángulo + distancia) para vértices cúbicos: hacen más naturales tanto la animación como la edición por IA.

### 6.2 Simplificar

- **IDs**: usar ids de string estables y legibles (`"arm_l"`, `"head/eye_r"`) en vez de índices. Rive usa índices porque optimiza bytes. A nosotros nos importan los diffs y la robustez ante inserciones. Se puede compilar a índices internamente.
- **Formato**: JSON legible, con valores por defecto omitidos (como Rive) y **sin** ToC binaria. Si hace falta compacidad, se puede añadir más tarde un empaquetado binario generado desde los mismos defs.
- **Vértices**: `{x, y, radius?}` y `{x, y, in:{angle,dist}, out:{angle,dist}, mode:"mirrored"|"asymmetric"|"detached"}`. Un solo tipo con un campo `mode` en vez de 4 clases.
- **Constraints**: empezar por IK de 1-2 huesos (analítico, ley de cosenos, con `invertDirection` y `strength`), `lookAt`/rotation, y translation/scale con min/max. Dejar para más adelante FollowPath, Distance, Draggable y Scrolling.
- **Pesos**: Rive empaqueta 4 índices y 4 pesos en dos uint32. Nosotros: `weights: [[boneId, w], ...]` (máx. 4) por vértice, normalizado en la carga.
- **State machine**: capas + estados (animation, blend1D, any/entry/exit) + transiciones con condiciones sobre propiedades del view model. Los listeners se pueden reducir al principio a "pointerDown/Up/Enter/Exit sobre id → set propiedad/trigger".
- **Draw order**: el orden del DOM (orden de los hijos) más un `zIndex` animable opcional, en lugar de DrawRules/DrawTargets.
- No incluir layout (Yoga), texto avanzado, scripting ni audio en la v1.

### 6.3 Evitar

- **Claves numéricas mágicas en el formato que edita el LLM**: los LLM se equivocan con enteros opacos (13 = x). Usar nombres. Las claves numéricas, como mucho, para un formato binario derivado.
- **Mezclar estado de editor en el modelo de runtime** sin marcarlo (Rive lo resuelve con `runtime:false`). Nosotros: separar `editor:{...}` (colapsados, guías, selección) del documento del personaje, o marcarlo en los defs.
- **Recalcular en los setters** o depender del orden de llamadas: todo debe ir al update ordenado.
- **Depender de la anidación de la serialización para la pertenencia** (Rive usa el "contexto" del stream, frágil para ediciones parciales). En JSON, que cada keyframe o transición referencie a su padre por id, o anidarlos explícitamente dentro de su animación o estado.
- **Ciclos de dependencias sin detectar** (p. ej. una constraint cuyo target depende del restringido): validar el grafo en la carga y reportar el error a la IA en un formato legible.
- **Hacer del DOM SVG la fuente de verdad**: debe ser una vista. Las ediciones manuales en el editor deben pasar por la misma API de parches que usa la IA, para tener deshacer/rehacer, validación e historial unificados.

---

## 7. Tabla "concepto Rive → equivalente propuesto en aia-studio"

| Concepto Rive | Qué es (Rive) | Equivalente propuesto aia-studio |
|---|---|---|
| `dev/defs/*.json` + core_generator | Esquema declarativo → código C++/Dart | `schema/defs/*.json` → tipos TS, validador, docs para LLM, UI de inspector, tabla de reflexión |
| typeKey / propertyKey (enteros globales) | Identidad de tipo/propiedad en binario | `type: "Shape"`, nombres de propiedad (`"x"`, `"rotation"`) y rutas (`"fills.0.color"`) |
| `.riv` binario + ToC | Formato compacto, compatible hacia adelante | `.aia.json` legible con `formatVersion: "1.0"`, omitiendo valores por defecto y conservando campos desconocidos |
| `parentId` (índice) | Jerarquía plana | `parent: "id-string"` en una lista plana `objects[]` |
| Artboard | Lienzo raíz / escena | `Character` (o `Stage`) con `width/height/origin` |
| Node / TransformComponent | Grupo con x, y, rotation, scale, opacity | `Group` → `<g transform>` |
| Shape + PointsPath + vertices | Forma vectorial editable | `Shape` con `paths[]`, `vertices[]` (straight/cubic polar) → `<path d>` |
| ParametricPath (Rectangle, Ellipse…) | Primitivas paramétricas | `Rect`, `Ellipse` → `<rect>`/`<ellipse>` o `d` generado |
| Fill / Stroke + SolidColor / Gradient / GradientStop | Pinturas apiladas | `fills[]`, `strokes[]` → `fill`/`stroke`, `<linearGradient>`/`<radialGradient>` en `<defs>` |
| Bone / RootBone | Huesos FK | `Bone` (length) → `<g>` anidado (visible solo en el editor) |
| Skin / Tendon / Weight | Deformación por huesos | `skin: { bones:[{id, bind}], weights por vértice }`, calculado en JS → `d` |
| IK / Rotation / Translation / Scale constraints | Restricciones | `constraints[]` en el nodo: `ik`, `lookAt`, `copyRotation`, `limit` (subset) |
| Mesh / MeshVertex | Imagen deformable | v2: imágenes rígidas por hueso. Mesh solo en una capa canvas opcional |
| Image / ImageAsset | Bitmap | `Image` → `<image href>`. Assets en `assets[]` |
| Text / TextValueRun / TextStyle | Texto rico | `Text` → `<text>`/`<tspan>` (subset) |
| NestedArtboard | Componente reutilizable | `Instance` de otro `Character`/prefab (p. ej. accesorios) → `<use>` o subárbol |
| Solo | Un hijo activo | `Switch` con `active` (animable/bindable) → `display:none` en los demás |
| LinearAnimation (fps, duration, loop, speed, workArea) | Timeline | `Animation { fps, duration, loop: "once"\|"loop"\|"pingpong", speed }` |
| KeyedObject / KeyedProperty / KeyFrame | Pistas por objeto/propiedad | `tracks: [{ target:"arm_l", prop:"rotation", keys:[{t, v, ease}] }]` |
| Cubic / Elastic interpolator | Curvas compartidas | `ease: "cubic(…)"` o referencia a `easings{}` con nombre |
| mix (blend de animaciones) | Mezcla lineal de valores | Igual: `apply(anim, t, mix)` sobre el modelo, antes del render |
| StateMachine / Layer / State / Transition / Condition | Lógica de estados | `StateMachine { layers:[{ states, transitions:[{from,to,when,duration,exitTime}] }] }` |
| AnyState / Entry / Exit | Estados especiales | `"*"` (any), `entry`, `exit` |
| BlendState1D / Direct | Mezcla paramétrica | `blend1d { param, points:[{value, anim}] }` y `blendDirect` |
| Inputs (bool/number/trigger) — deprecados | Control antiguo | No usar. Reemplazar por View Model |
| ViewModel / ViewModelInstance / DataBind / Converter | Datos tipados y bindings | `model { mood:number, expression:enum, blink:trigger, lookAt:{x,y} }` + `bindings[{source, target, convert?}]` |
| Listeners / Events | Interacción / notificaciones | `on: [{ pointer:"down", target:"btn", do:{set:"…"} }]`, `events` emitidos hacia el host |
| ComponentDirt + graphOrder + updateComponents | Update incremental ordenado | `dirty` bitmask + orden topológico + `update()` por frame |
| Renderer abstracto | Backends GPU/Canvas | `Renderer` con `SvgRenderer` (v1) y `CanvasRenderer` (opcional) |
| Scripting Luau + agente IA | Extensibilidad | API de parches JSON (`set/add/remove/reparent/key`) como "scripting" de la IA. Sin código arbitrario en v1 |

---

## 8. Fuentes

Repositorio `rive-app/rive-runtime` (los defs se leyeron en el commit `845a82a9b67136e0b37272170504659a8ab4ca67`, del 2026-08-21, porque en `main` ya no está `dev/defs/`):

- https://github.com/rive-app/rive-runtime
- Listado de defs: https://api.github.com/repos/rive-app/rive-runtime/contents/dev/defs?ref=845a82a9b67136e0b37272170504659a8ab4ca67
- Historial de `dev/defs`: https://api.github.com/repos/rive-app/rive-runtime/commits?path=dev/defs
- `dev/defs/component.json`, `node.json`, `transform_component.json`, `world_transform_component.json`, `drawable.json`, `artboard.json`, `solo.json`
- `dev/defs/animation/keyframe.json`, `interpolating_keyframe.json`, `linear_animation.json`, `keyed_object.json`, `elastic_interpolator.json`, `state_transition.json`, `state_machine_listener.json` (y el listado del directorio `animation/`)
- `dev/defs/bones/bone.json`, `tendon.json`, `weight.json` (y el listado de `bones/`)
- `dev/defs/constraints/ik_constraint.json`, `transform_component_constraint.json` (y el listado de `constraints/`)
- `dev/defs/shapes/cubic_detached_vertex.json`, `mesh_vertex.json`, `paint/stroke.json`, `paint/linear_gradient.json` (y los listados de `shapes/`, `shapes/paint/`, `text/`)
  - Base raw: `https://raw.githubusercontent.com/rive-app/rive-runtime/845a82a9b67136e0b37272170504659a8ab4ca67/dev/defs/...`
- Generador: `dev/generate_core.sh`, `dev/core_generator/lib/main.dart`, `dev/core_generator/lib/src/configuration.dart`, `definition.dart`, `property.dart`
- Código generado: `include/rive/generated/node_base.hpp`
- Runtime: `src/file.cpp`, `include/rive/runtime_header.hpp`, `src/artboard.cpp`, `include/rive/component_dirt.hpp`, `include/rive/renderer.hpp`, `include/rive/layout_component.hpp`, `src/solo.cpp`, `src/nested_artboard.cpp`
- Formas y huesos: `src/shapes/path.cpp`, `src/shapes/vertex.cpp`, `src/bones/skin.cpp`, `src/bones/weight.cpp`, `src/constraints/ik_constraint.cpp`
- Animación: `src/animation/linear_animation.cpp`, `linear_animation_instance.cpp`, `keyed_property.cpp`, `keyframe_double.cpp`, `cubic_interpolator.cpp`, `cubic_interpolator_solver.cpp`, `include/rive/animation/loop.hpp`
- State machine: `src/animation/state_machine_instance.cpp`, `state_transition.cpp`, `transition_number_condition.cpp`, `blend_state_1d_instance.cpp`
  - Base raw: `https://raw.githubusercontent.com/rive-app/rive-runtime/main/...`

Documentación y blog de Rive:
- Formato: https://rive.app/docs/runtimes/advanced-topic/format
- Canvas vs WebGL2 (paquetes web): https://rive.app/docs/runtimes/web/canvas-vs-webgl
- Data binding (editor): https://rive.app/docs/editor/data-binding/overview
- Data binding (web): https://rive.app/docs/runtimes/web/data-binding
- Data binding (C++): https://rive.app/docs/runtimes/cpp/data-binding
- State machine: https://rive.app/docs/editor/state-machine/state-machine
- Inputs (deprecados): https://rive.app/docs/editor/state-machine/inputs
- Layouts: https://rive.app/docs/editor/layouts/layouts-overview
- Scripting: https://rive.app/docs/scripting · https://rive.app/blog/scripting-is-live-in-rive · https://rive.app/blog/why-scripting-runs-on-luau
- Rive Renderer: https://rive.app/blog/rive-renderer-now-open-source-and-available-on-all-platforms

Notas de verificación:
- No se clonó el repositorio. Los archivos se leyeron vía `raw.githubusercontent.com` y la API de GitHub, con un extractor que resume contenido largo. Los números de clave y los nombres de los defs citados salen directamente de los JSON. Los fragmentos de C++ son extractos breves o paráfrasis.
- No se pudo verificar: los valores exactos del enum `KeyframeInterpolation` (lo de 0 hold / 1 linear / 2 cubic es [I], coherente con `interpolationType == 0 → hold` del código y con el default `1 = linear` de las transiciones), el algoritmo interno de `DependencySorter` (que sea un DFS topológico es [I]) y la codificación del color como ARGB en el binario ([I]).
