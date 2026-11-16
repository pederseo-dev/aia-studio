# Moho por dentro: API Lua, modelo de objetos y formato de archivo

> Investigación para **aia-studio** (editor/runtime de personajes 2D en HTML/CSS/JS/SVG, manipulable por LLM vía JSON + API).
> Fecha: 2026-10-29. Fuente principal: mohoscripting.com (documentación **no oficial** de la API Lua de Moho), el manual de Lost Marble, el foro lostmarble.com y el proyecto MohoMCP.

**Convención de fiabilidad usada en todo el documento:**

- **[V]** Verificado: aparece explícitamente en una fuente consultada (ver sección Fuentes).
- **[I]** Inferido: conocimiento comunitario, deducción a partir de nombres de API o experiencia general. No se ha confirmado en una fuente primaria durante esta investigación.

---

## 0. Resumen ejecutivo

1. **Todo es un documento con un árbol de capas tipadas** [V]. `MohoDoc` contiene capas (`MohoLayer`) de 12 tipos (`LT_VECTOR`, `LT_IMAGE`, `LT_GROUP`, `LT_BONE`, `LT_SWITCH`, `LT_PARTICLE`, `LT_NOTE`, `LT_3D`, `LT_AUDIO`, `LT_PATCH`, `LT_TEXT`…). Las capas contenedoras (Group, Bone, Switch, Particle) heredan de `GroupLayer`. **El esqueleto no es una capa aparte: es una propiedad de la BoneLayer**, que también es un grupo. Las capas hijas de una BoneLayer se deforman con sus huesos.
2. **Todo lo animable es un "canal" tipado** [V] (`AnimVal`, `AnimVec2`, `AnimVec3`, `AnimColor`, `AnimBool`, `AnimString`, todos derivados de `AnimChannel`). Un canal guarda keyframes (`when` → valor) con un `InterpSetting` por keyframe: modo, `val1`/`val2`, `hold`, `interval` (animar "a dos"), `tags` (color).
3. **Hay 12 modos de interpolación** [V]: linear, smooth, ease, step, noisy, cycle, pose (referencia a una acción), ease in, ease out, bezier, bounce, elastic.
4. **El frame 0 es la pose de reposo/setup** [V]. Lo que se edita en el frame 0 es el "modelo"; los keyframes de frames ≥ 1 son la animación. Borrar keys devuelve el estado del frame 0.
5. **Las acciones son sub-pistas con nombre dentro de cada canal** [V]: `AnimChannel:ActionByName(name)` devuelve el canal de la acción. Una acción se inserta en la línea de tiempo **por copia** o **por referencia** (`InsertAction` / `InsertActionByReference`). Una *Smart Bone Action* es una acción con el **mismo nombre que un hueso**, y es la rotación de ese hueso la que la "reproduce" [V, por tutoriales y foro].
6. **Huesos = transformación local + jerarquía por ID entero** [V]: `fParent` (−1 = raíz), `fLength`, `fStrength`, canales `fAnimPos`/`fAnimAngle`/`fAnimScale`, `fAnimParent` (re-parentado animable), restricciones de ángulo min/max, controladores de ángulo/posición/escala desde otro hueso (con factor y retardo), IK con objetivo, bloqueo y "ignorado por IK", flips animables `fFlipH`/`fFlipV`, y dinámica de muelle por canal.
7. **Binding de puntos: tres modelos** [V]: flexi (todo hueso influye en todo punto, cae con la distancia), región (radio de influencia por hueso, ajustado con "Bone Strength"), y manual (cada punto ligado a **un solo** hueso: `M_Point.fParent`). Además, **layer binding**: toda una capa pegada rígidamente a un hueso (`SetLayerParentBone`). No hay pesos multi-hueso explícitos por punto en la API.
8. **La geometría vectorial es un grafo de puntos compartidos** [V]: `M_Mesh` tiene puntos, curvas (secuencias de puntos con curvatura y manejadores Bézier por punto) y shapes (relleno/contorno definidos como listas de aristas `curveID+segmentID`). Los puntos se "sueldan" (weld) y varias curvas pasan por el mismo punto.
9. **El formato `.moho` es un ZIP con un JSON** (`Project.mohoproj`) y una miniatura JPG [V, foro]. El JSON es minificado, ignora propiedades desconocidas (compatibilidad hacia atrás) y tiene cabecera, ajustes del proyecto, estilos, layer comps, cámara, marcadores y la lista recursiva `"layers"` [V]. El esquema exacto de keyframes en JSON **no está documentado públicamente** [V: ausencia confirmada].
10. **Scripts**: tools (eventos de ratón/teclado + UI), menu/button scripts (`Run`), layer scripts embebidos (`LayerScript(moho)`, se ejecutan **en cada redibujado** del layer, sin crear keyframes) [V]. Ya existe un puente LLM↔Moho (MohoMCP) que usa IPC por ficheros y polling desde callbacks de UI [V].
11. **Lección central para aia-studio**: copiar el modelo "canal tipado + keyframes con interpolación por key + acciones con nombre + frame 0 = rest pose"; **evitar** los IDs enteros posicionales (frágiles para un LLM), el binding por distancia implícita (opaco) y el estado de selección/temporal mezclado con datos persistentes.

---

## 1. Modelo de objetos de la API Lua

### 1.1 Módulos y punto de entrada [V]

- Módulo `MOHO`: interfaz directa con la aplicación (clases, constantes `LT_*`, `INTERP_*`, `CHANNEL_*`, binding, funciones utilitarias como `MOHO.NewKeyframe`, `MOHO.Redraw`, `MOHO.Localize`).
- Módulo `LM`: utilidades (vectores `LM.Vector2`, matrices, UI `LM.GUI`).
- Lua 5.2 en Moho 12–13.5; **Lua 5.4 en Moho 14** [V, foro].
- Todo script recibe un objeto `moho` (`ScriptInterface`), que da contexto:
  - `moho.document` (MohoDoc), `moho.layer` (capa seleccionada), `moho.frame`, `moho.layerFrame` (frame relativo al inicio de la capa), `moho.drawingLayer`, `moho.drawingFrame`, `moho.view`.
  - Atajos: `moho:Skeleton()`, `moho:Mesh()`, `moho:SetCurFrame(f)`, `moho:CreateShape(...)`, `moho:CreateNewLayer(type)`, `moho:DeleteLayer(l)`, `moho:PlaceLayerInGroup(...)`, `moho:LoadDocument(path)`, `moho:FileSave()`, `moho:NewKeyframe(channel)`.

### 1.2 Jerarquía de clases

```
ScriptInterface ("moho")
└── MohoDoc
    ├── estilos (M_Style), layer comps (LayerComp), fTimelineMarkers (AnimString)
    ├── cámara: fCameraTrack (AnimVec3), fCameraZoom, fCameraRoll (AnimVal), fCameraPanTilt (AnimVec2)
    └── capas raíz: MohoLayer[]
        MohoLayer (base)
        ├── MeshLayer (LT_VECTOR) ── Mesh() → M_Mesh
        ├── ImageLayer (LT_IMAGE)
        ├── AudioLayer, NoteLayer, Mesh3DLayer, (Text, Patch)
        └── GroupLayer (LT_GROUP)  ── Layer(i), CountLayers(), LayerByName()
            ├── BoneLayer (LT_BONE) ── Skeleton() → M_Skeleton ── Bone(i) → M_Bone
            ├── SwitchLayer (LT_SWITCH) ── SwitchValues() → AnimString
            └── ParticleLayer (LT_PARTICLE)

M_Mesh ── Point(i) → M_Point ; Curve(i) → M_Curve ; Shape(i) → M_Shape ; Group(i) → M_PointGroup
AnimChannel ── AnimVal | AnimVec2 | AnimVec3 | AnimColor | AnimBool | AnimString
            └── InterpSetting por keyframe
```

[V] para clases y relaciones (mohoscripting.com). [I] la ubicación exacta de TextLayer/PatchLayer en la herencia (existen las constantes `LT_TEXT`=11 y `LT_PATCH`=10, pero no páginas de clase propias).

### 1.3 MohoDoc [V]

- Capas: `CountLayers`, `Layer(id)`, `LayerByName`, `LayerByAbsoluteID` / `LayerAbsoluteID` (índice plano en todo el árbol), `DuplicateLayer`.
- Tiempo: `Fps()`, `StartFrame()`, `EndFrame()`, `AnimDuration()`.
- Tamaño: `Width()`, `Height()`, `SetShape(w,h)`.
- Estilos compartidos: `AddStyle(name)`, `Style(name)`, `StyleByID(id)`. Los estilos se identifican **por ID interno, no por nombre** [V, foro].
- Undo: `PrepUndo(layer, shallow)`, `PrepMultiUndo()`, `Undo()`, `Redo()`; `SetDirty()` marca el documento como modificado.
- Layer comps (combinaciones de visibilidad de capas para render).

### 1.4 MohoLayer [V]

- Identidad: `Name()`, `UUID()` (identificador estable), `LayerType()`.
- Transformación (todos canales animables): `fTranslation`, `fScale`, `fShear` (AnimVec3), `fRotationX/Y/Z` (AnimVal), `fFlipH`, `fFlipV` (AnimBool), `fAlpha` (AnimVal), `fVisibility` (AnimBool). Además `Origin()` (pivote, no animable).
- Matrices calculadas: `GetLayerTransform`, `GetFullTransform`, `GetParentTransform`, `GetParentBoneTransform`.
- Huesos: `ControllingSkeleton()`, `ControllingBoneLayer()`, `LayerParentBone()` / `SetLayerParentBone(id)` (layer binding), "Flexi-bone subset" (restringir qué huesos influyen en la capa).
- Seguir curva: `SetFollowingCurve(layer, curve, start%, bendWithCurve)`.
- Máscaras: `MaskingMode()`, `SetMaskingMode()`.
- Acciones: `CountActions`, `ActionName`, `ActivateAction`, `InsertAction`, `DeleteAction`, `IsSmartBoneAction`, `BlendActions`.
- Script embebido: `LayerScript`, `SetLayerScript(path)`, `ScriptData()` (almacén de datos del script).
- Referencias entre documentos: `IsReferencedLayer`, `UpdateReferencedLayer(syncOptions)`, `BreakLayerReference`.
- Flags de UI: visible, locked, edit-only ("no renderizar"), render-only.

### 1.5 M_Skeleton y M_Bone [V]

`M_Skeleton`: lista plana de huesos indexada por entero.

- `AddBone(frame)`, `Bone(id)`, `BoneByName(name)`, `BoneID(bone)`, `DeleteBone(id, recursivo)`, `CountBones()`.
- Jerarquía: `CountBoneChildren`, `GetFirstChildBone`, `IsBoneParent`, `IsBoneChild`.
- IK: `IKAngleSolver(boneID, target, iter, allowTwoBoneShortcut, allowStretching)`, `IsBoneIKChild`, `TargetOfBone(id, frame)`, `TargetOfBoneChain`.
- `FlipBone(id, horizontal)`: espeja un hueso en frame 0 con sus hijos y animación.
- `LockBone(id, frame)` / `UnlockBone`.
- Grupos de huesos (13.5.2+): `AddGroup`, `GroupForBone`.
- `fBindingMode`: modo de auto-binding (`FLEXI_BINDING`=1, `REGION_BINDING`=2).
- `UpdateBoneMatrix(id)`; cada hueso expone `fRestMatrix`, `fMovedMatrix`, `fPtMatrix`.

`M_Bone` (propiedades más relevantes):

| Grupo | Propiedades |
|---|---|
| Jerarquía y forma | `fParent` (int, −1 = sin padre), `fLength`, `fOffset`, `fName`, `Tags()` (color) |
| Estado actual evaluado | `fPos`, `fAngle`, `fScale` |
| Canales animados | `fAnimPos` (Vec2), `fAnimAngle`, `fAnimScale`, `fAnimParent` (padre animable), `fTargetBone` (objetivo IK animable), `fFlipH`, `fFlipV` (AnimBool) |
| Influencia | `fStrength` (fuerza/radio de región) |
| Restricciones | `fConstraints` (bool), `fMinConstraint`, `fMaxConstraint` (ángulo), `fFixedAngle` ("ángulo independiente": no hereda la rotación del padre) |
| Controladores | `fAngleControlParent` + `fAngleControlScale` + `fAngleControlDelay`; idem `Pos…` (escala Vec2) y `Scale…` |
| IK | `fIKGlobalAngle`, `fIKLock` (AnimBool), `fIKParentTarget` (AnimVec2), `fIgnoredByIK`, `fMaxAutoScaling` (estiramiento IK máximo) |
| Escalado | `fScalingMode` (0 manual, 1 bidimensional, 2 squash & stretch), `fSquashStretchScaling` |
| Dinámica | `fBoneDynamics` (AnimBool); desde Moho 14 por canal: `fAngleDynamics`, `fPosDynamics`, `fScaleDynamics` con `…DampingForce`, `…SpringForce`, `…TorqueForce`; viento/gravedad en la BoneLayer |
| Física (Box2D-like) | `fPhysicsRadius`, `fPhysicsTorque`, `fPhysicsMotorSpeed`… |
| Pesos 14.0+ | `PosWeight()`, `AngleWeight()`, `ScaleWeight()` (mezcla de influencia de transformaciones; semántica exacta [I]) |
| Temporales/UI | `fSelected`, `fHidden`, `fShy`, `fTemp*` |

### 1.6 Geometría vectorial: M_Mesh, M_Point, M_Curve, M_Shape [V]

- **M_Mesh**: contenedor de puntos, curvas, shapes y grupos de puntos. Creación: `AddLonePoint`, `AppendPoint` (encadena al anterior), `AddPoint`; `WeldPoints` fusiona puntos. Shapes: `ShapeByName`, `RaiseShape`/`LowerShape` (orden z), `CombineShapes`.
- **M_Point**: `fAnimPos` (AnimVec2), `fPos` (actual), `fParent` (hueso ligado: −1 sin binding manual, −2 flexi), `fWidth` (AnimVal, grosor variable del trazo en ese punto), `fColor`/`fColorStrength`/`fOpacity` (por punto, v11/14.3). Varias curvas pueden pasar por un punto (`CountCurves`, `Curve(i)`).
- **M_Curve**: secuencia ordenada de puntos; `fClosed`; curvatura animable por punto (`Curvature(id)` → AnimVal); manejadores Bézier (`GetControlHandle`, `GetOffset`, `GetWeight`, v12+); segmentos que se pueden apagar (`SetSegmentOn`); `fStartPercent`/`fEndPercent` animables (efecto "trazo que se dibuja").
- **M_Shape**: relleno y/o contorno definido como **lista de aristas** (`AddEdge(curveID, segID)`); `fMyStyle` (estilo propio) + `fInheritedStyle` (estilo compartido); `fHasFill`, `fHasOutline`; `fComboMode` (operaciones booleanas, v14).

Idea clave: la topología (qué puntos forman qué curvas) es estática; lo que se anima son **posiciones de puntos, curvaturas, anchos y estilos**. Por eso la interpolación entre dibujos de una Switch layer exige el **mismo número de puntos** [V, manual].

### 1.7 Canales de animación: AnimChannel, subtipos e InterpSetting [V]

Tipos (`ChannelType()` → `CHANNEL_*`): `VAL` (1), `VEC2` (2), `COLOR` (3), `BOOL` (4), `STRING` (5), `VEC3` (6).

Operaciones sobre keyframes: `AddKey(when)`, `SetValue(when, v)` / `GetValue(when)` (en subclases), `HasKey`, `DeleteKey`, `CountKeys`, `GetKeyWhen(id)`, `SetKeyWhen(id, when)`, `GetClosestKeyID(when)`, `Duration()` (último key), `Clear`, `ClearAfter/Before`, `StoreValue()`, `Reset(when)` (igualar al frame 0), `MakeKeyframesConsistent()`.

Interpolación por keyframe: `SetKeyInterp(when, mode, val1, val2)` o con un objeto `InterpSetting`:

| Campo | Significado |
|---|---|
| `interpMode` | uno de los `INTERP_*` |
| `val1`, `val2` | parámetros dependientes del modo (noisy: amplitud y frecuencia; cycle: frame relativo y absoluto de retorno; pose: índice de la acción) |
| `hold` | frames que se mantiene el valor anterior antes de interpolar |
| `interval` | 1 = cada frame, 2 = "a dos", 3 = "a tres"… (stepping estilo animación limitada) |
| `stagger` | (v10) |
| `tags` | color del keyframe (organización visual) |

Modos: `LINEAR`(0), `SMOOTH`(1), `EASE`(2), `STEP`(3), `NOISY`(4), `CYCLE`(5, con variante aditiva `SetAdditiveCycle`), `POSE`(6, referencia a una acción), `EASE_IN`(7), `EASE_OUT`(8), `BEZIER`(9), `BOUNCE`(10), `ELASTIC`(11).

Acciones dentro del canal (v12+): `CountActions`, `Action(id)`, `ActionByName(name)` (devuelve el sub-canal de esa acción), `ActivateAction(name)`, `InsertAction(name, when)`, `InsertActionByReference(name, when)`, `Mute(b)`.

Ejemplo ilustrativo (estilo de la API; no copiado de documentación):

```lua
-- Poner un keyframe de rotación en un hueso en el frame 24 con ease
local skel = moho:Skeleton()
local bone = skel:BoneByName("brazo_izq")
moho.document:PrepUndo(moho.layer)
bone.fAnimAngle:SetValue(24, math.rad(45))
bone.fAnimAngle:SetKeyInterp(24, MOHO.INTERP_EASE, 0, 0)
moho:NewKeyframe(CHANNEL_BONE)   -- refrescar la timeline (código de canal: [I])
moho.document:SetDirty()
```

---

## 2. Cómo funcionan por dentro

### 2.1 Huesos

- **Jerarquía** [V]: cada hueso guarda el ID entero de su padre (`fParent`). El padre puede cambiar a lo largo del tiempo (`fAnimParent`), lo que permite que un objeto pase de una mano a otra.
- **Transformación** [V/I]: cada hueso tiene posición, ángulo y escala locales animables, más una longitud fija. La matriz final (`fMovedMatrix`) se obtiene componiendo la del padre con la local [I, estándar]; `fRestMatrix` es la del frame 0; `fPtMatrix` es la que se aplica a los puntos [V], presumiblemente `moved × rest⁻¹` [I].
- **Ángulo independiente** (`fFixedAngle`) [V]: el hueso sigue la posición del padre pero no su rotación (útil para cabezas, manos que mantienen orientación).
- **Fuerza / región** (`fStrength`) [V]: en modo región define el radio de influencia; se ajusta con la herramienta "Bone Strength". Los puntos fuera de todas las regiones siguen al hueso más cercano [V, manual].
- **Binding de puntos** [V]:
  - *Flexi*: por defecto; todos los huesos influyen en todos los puntos y la influencia cae con la distancia. Puede provocar "temblores" lejanos. Se puede restringir el conjunto de huesos por capa (flexi-bone subset).
  - *Región*: como flexi pero con radio de corte por hueso.
  - *Manual / point binding*: cada punto sigue a **un único** hueso (`M_Point.fParent`). Laborioso, deforma mal en articulaciones; no sirve para deformar imágenes.
  - Las ImageLayer también se deforman con binding automático (se mallan) [V].
- **Layer binding** [V]: la capa entera se pega rígidamente a un hueso (props, switch de bocas pegado al hueso de la cabeza). No deforma; y si se liga así un grupo, sus hijas no pueden usar binding de huesos [V, foro].
- **IK** [V/I]: la API expone objetivos (`fTargetBone` animable), bloqueo (`fIKLock`), huesos ignorados por IK, estiramiento automático máximo y un solver por ángulos (`IKAngleSolver`) con atajo analítico para cadenas de dos huesos. [I] En la interacción, arrastrar un hueso hijo arrastra la cadena hacia arriba hasta la raíz o hasta un hueso bloqueado; el resultado se guarda como ángulos (FK), es decir, **el IK es una herramienta de pose, salvo cuando hay un hueso objetivo**, que se resuelve en cada frame.
- **Constraints** [V]: límites de ángulo min/max; controladores que copian ángulo/posición/escala de otro hueso multiplicados por un factor y con retardo en frames (overlap barato); squash & stretch automático.
- **Bone flip** [V]: `fFlipH` ("end flip", invierte a lo largo del hueso) y `fFlipV` ("side flip", espejo lateral) son **AnimBool**, es decir se pueden keyframear para girar un personaje. `FlipBone` en el esqueleto aplica el espejo en el frame 0. `ParentalFlipFactor()` indica si un ancestro está volteado [V, sin descripción detallada].
- **Dinámica** [V]: muelle amortiguado por hueso (spring, damping, torque); desde v14 separado para ángulo, posición y escala; gravedad y viento con turbulencia en la BoneLayer. [I] Se simula a partir del movimiento del padre, por lo que su resultado depende del historial de frames (no es una función pura del frame).

### 2.2 Smart Bones y acciones

- **Acción** [V]: animación con nombre, guardada como sub-pista dentro de cada canal implicado. Se edita entrando en la acción (la timeline cambia de color) y se sale volviendo a "Mainline". Usos:
  - Insertarla en la línea principal **como copia** (los keys se pegan) o **como referencia** (se vincula; cambios posteriores en la acción se propagan) [V, API].
  - Keyframes `INTERP_POSE` que apuntan a una acción por índice [V].
  - *Morph*: acción de un solo frame; se mezclan con el panel Morph [V, foro]. `BlendActions` en la API [V].
- **Smart Bone Action** [V, tutoriales/foro]: una acción con **el mismo nombre que un hueso**. Al rotar ese hueso en la línea principal, la acción se "reproduce" en proporción. Puede contener cualquier cosa keyframeable (puntos, curvaturas, visibilidad, otros huesos, switch). Un hueso admite hasta **dos acciones** (una por sentido; convención de nombre "`hueso 2`" para el sentido contrario) [V, tutorial + foro]. Se suele limitar el hueso con constraints de ángulo.
  - Mecanismo de mapeo ángulo→frame [I, ampliamente asumido pero no documentado en las fuentes consultadas]: dentro de la acción, el propio hueso se rota entre el frame 0 (reposo) y el último frame; en la línea principal, Moho invierte esa curva de ángulo para saber qué frame de la acción mostrar. Por eso la comunidad recomienda **interpolación lineal en las acciones** (para que la relación sea predecible y la suavidad la ponga la línea principal) y **muchos frames** (≥ 100) para evitar escalonado [V, tutorial].
  - *Smart Bone Dial*: el mismo mecanismo con un hueso fuera del esqueleto usado como control de UI [V, foro]. Limitación: solo interpola por las poses intermedias realmente animadas en la acción, no "salta" entre poses [V, foro].
  - Cadenas: un smart bone puede mover otros smart bones (rigs de control tipo joystick) [V, tutorial].

### 2.3 Switch layers [V]

- Grupo donde **solo un hijo es visible** a la vez. El valor es un canal `AnimString` (`SwitchValues()`) con el **nombre** del hijo activo en cada keyframe (step implícito).
- Uso típico: bocas/visemas (`ContainsVisemes`, `PhonemeToViseme`), manos, ojos; también como "frame-by-frame layer" (`SetFBFLayer`, v12).
- "Interpolate sub-layers": si todos los hijos son vectores con el mismo número de puntos, se interpola la geometría entre ellos.
- Puede alimentarse con un archivo de datos de lip-sync (`SetSourceFile`, p. ej. de Papagayo).

### 2.4 Patch layers [V parcial / I]

- Existen como tipo propio (`LT_PATCH` = 10) [V].
- Función: dentro de un grupo, oculta el contorno en la unión de dos piezas vectoriales (por ejemplo brazo y torso en capas separadas) para que se lean como una sola forma [V, foro].
- Limitaciones citadas: la zona del parche es **circular** y hay problemas de previsualización dentro de máscaras [V, foro]. [I] Funciona re-dibujando, dentro de su región, el relleno de la capa inferior por encima del trazo de la superior.
- La alternativa recomendada por usuarios avanzados son máscaras con capas duplicadas [V, foro].

### 2.5 "Capas de interpolación" y deformadores

- Interpolación entre dibujos: Switch con "interpolate sub-layers" [V].
- Smart Warp (v13.5+/v14): una capa vectorial puede marcarse como *warp layer* (malla de deformación) de otra capa (`MarkAsWarpLayer`, `SetWarpLayer`) [V]. "Curver" (v14) deforma a lo largo de una curva [V].
- Curve following: una capa sigue una curva de otra capa con porcentaje animable y opción de rotar/curvarse [V].

---

## 3. Sistema de animación

- **Frame 0 = setup** [V]: guarda la pose y forma originales. Editar en frame 0 cambia el modelo; editar en frames ≥ 1 crea keyframes. Los keyframes aparecen en la timeline desde el frame 1.
- **Canales** [V]: toda propiedad animable es un canal tipado. Hay canales por capa (transformación, alpha, visibilidad, flips), por hueso (pos/ángulo/escala/padre/objetivo/IK lock/flips), por punto (posición, ancho, color, opacidad), por curva (curvatura por punto, start/end %), por switch (string), por documento (cámara, marcadores). `MohoLayer:GetChannelInfo` / `MohoLayerChannel` permiten enumerarlos con `channelID`, `name`, `subChannelCount` (un canal "puntos" agrupa N sub-canales), `selectionBased` y `separableDimensions` (v12: X/Y separables) [V].
- **Keyframe** [V]: `(when, valor, InterpSetting)`. La interpolación pertenece al keyframe (afecta al tramo que sale de él [I, convención habitual]).
- **Timeline** [V]: frames enteros, `Fps`, `StartFrame`/`EndFrame`. Cada capa tiene un desplazamiento temporal propio (`moho.layerFrame` vs `moho.frame`, `DocToLayerFrame`).
- **Evaluación de un frame** [I, reconstruido a partir de la API y del comportamiento documentado]:
  1. Para cada canal, evaluar su valor en el frame de la capa (aplicando hold/interval/modo; `POSE` y `CYCLE` leen de acciones o de frames anteriores).
  2. Mezclar acciones insertadas por referencia y smart bone actions (cuyo "tiempo" depende del ángulo evaluado del hueso de control).
  3. Resolver el esqueleto: controladores entre huesos, objetivos IK, constraints, dinámica (que depende de frames anteriores), y calcular matrices.
  4. Deformar puntos (flexi/región/manual) con `fPtMatrix`; aplicar layer binding y transformación de capa (padre → hijo).
  5. Switch: elegir hijo visible; warp/curver; render con estilos, máscaras y patch.
  6. Ejecutar layer scripts embebidos (pueden alterar valores en este punto, sin crear keyframes) [V: corren en cada redibujado].

---

## 4. Formato de archivo

| Formato | Contenido | Fiabilidad |
|---|---|---|
| `.moho` (Moho 12+) | ZIP con `Project.mohoproj` (JSON minificado) + `preview.jpg` opcional | [V, foro y fileinfo] |
| `.mohoproj` | JSON del proyecto; Moho lo abre directamente y también `ScriptInterface:LoadDocument` | [V, foro] |
| `.anime` / `.animeproj` (Anime Studio 11) | Mismo esquema: ZIP + JSON. Fue el primer formato JSON | [V, foro de Lost Marble, post del desarrollador] |
| `.anme` (antiguo) | Formato textual previo; foros reportan que Moho 14 aún los abre | [V, foro] |
| `.mohoexport`, etc. | Formatos auxiliares | [no investigado] |

Estructura del JSON (según la descripción del formato de AS11, que el foro dice que no ha cambiado drásticamente) [V]:

1. Cabecera: versión del formato, fecha de creación, comentario.
2. Ajustes del proyecto: frame inicial/final, color de fondo, FPS, resolución.
3. Miniatura opcional.
4. Estilos y layer comps.
5. Metadatos del documento.
6. Cámara del documento y marcadores de la timeline.
7. Lista de capas `"layers"` (la parte más grande); recursiva en group/switch/bone (`"layers"` anidado).

Claves vistas en fuentes [V]: `"layers"`, `"type"`, `"name"`, `"origin"`, `"visible"`, `"image_path"`, `"audio_path"`. Tipos complejos serializados: Point, PointGroup, Curve, Shape, Bone, Skeleton, Mesh, Mesh3D, Face3D, Style; estilos de pincel/relleno con prefijo `SS_` (p. ej. `SS_Gradient`). Los valores animables tienen un tipo (Vec2, Color, String…) y guardan keyframes con instante e interpolación [V], pero **el nombre exacto de las claves de keyframes no está documentado públicamente**; hay que extraer un archivo real para confirmarlo.

Decisiones de diseño explícitas del formato [V]: JSON elegido para que versiones antiguas **ignoren propiedades desconocidas** (compatibilidad hacia atrás); rutas externas a imágenes/audio como strings (hay scripts Python oficiales para listarlas/reescribirlas); archivos corruptos suelen ser por llaves de cierre faltantes.

---

## 5. Tipos de scripts y automatización [V]

| Tipo | Ubicación | Punto de entrada | Uso |
|---|---|---|---|
| Tool script | carpeta `scripts/tool` | `OnMouseDown/Moved/Up`, `OnKeyDown/Up`, `DoLayout` (barra de opciones), `HandleMessage`, `DrawMe` (overlay), `IsEnabled`, `IsRelevant`, `LoadPrefs/SavePrefs` | Herramientas interactivas en el canvas |
| Menu / button script | carpeta `scripts/menu` (subcarpetas = submenús) | `Run(moho)`, `UILabel`, `IsEnabled` | Operaciones batch, diálogos (`LM_SimpleDialog`) |
| Layer script (embebido) | asignado en Layer Settings → "Embedded script file" | `LayerScript(moho)` | Se ejecuta en **cada redibujado** de la capa; puede modificar valores sin crear keys (expresiones, drivers, rigs procedurales). Patrón: inicializar si `moho.frame == 0` |
| Utilidades | `scripts/utility` | módulos Lua compartidos | Librerías comunes |
| Python externo | fuera de Moho | lee/escribe el JSON | Reescribir rutas, inspección |

Convenciones [V]: prefijo único de autor por script/global (`XX_NombreScript`), evitar globales genéricos, usar `PrepUndo` antes de modificar, `SetDirty` después.

Qué se puede automatizar [V/I]: crear y reordenar capas, construir esqueletos y vectores, keyframear cualquier canal, cambiar interpolaciones, crear e insertar acciones, cambiar switches (lip-sync), exportar/renderizar, procesar lotes de archivos (`LoadDocument`). Lo que **no** es trivial [V, MohoMCP]: Moho solo ejecuta callbacks Lua cuando repinta la UI; no hay servidor/API remota nativa. MohoMCP lo resuelve con IPC por archivos JSON (`req_<id>.json` / `resp_<id>.json`) y un proceso que fuerza repintados ~4 veces por segundo, exponiendo 26 herramientas (lectura de árbol de capas, huesos, keys; escritura de transformaciones, keys, interpolación, visibilidad; render a PNG; `batch_execute` de hasta 50 operaciones).

---

## 6. Lecciones y recomendaciones para aia-studio

### 6.1 Qué copiar

1. **Canal tipado como unidad universal de animación.** Tipos: `number`, `vec2`, `color`, `bool`, `string` (enum). Una sola función de evaluación por tipo. El LLM solo necesita aprender un patrón.
2. **Interpolación por keyframe**, no por canal, con un set pequeño: `linear`, `step`, `ease` (`easeIn`, `easeOut`, `easeInOut`), `bezier` (con manejadores), más dos de Moho muy útiles para animación 2D: `hold` (frames de espera) y `interval` ("animar a dos").
3. **Frame 0 = rest pose / setup** separado de la animación. En JSON: `rig` (estático) vs `animations` (keys). Facilita "reset", retargeting y que el usuario corrija el modelo sin romper clips.
4. **Acciones con nombre reutilizables** que se insertan por **referencia** (no por copia) en una timeline principal, y se mezclan con pesos.
5. **Smart bones como "drivers" explícitos**: en vez de la convención de nombre, un objeto `driver` que mapea el valor de un canal de control (ángulo de un hueso, slider) a la posición temporal de una acción (`input range → action time`), con curva lineal por defecto. Es el concepto más potente de Moho para rigs de caras/giros de cabeza y es perfecto para un LLM ("pon `cabeza_giro` a 0.7").
6. **Switch layer** como grupo con un canal `string` que elige el hijo visible (bocas, manos, ojos, frame-by-frame). Ideal para lip-sync generado por IA.
7. **Huesos con ángulo independiente, límites de ángulo, controladores con factor y retardo, flips animables y parent animable.** Son baratos de implementar y cubren mucho.
8. **Layer binding** (pegar una capa/grupo SVG a un hueso) como mecanismo principal en SVG: es solo una `transform` heredada, rendimiento excelente.
9. **Compatibilidad hacia delante**: el runtime debe ignorar claves desconocidas, y el JSON debe llevar `formatVersion`.
10. **Puente IA por operaciones batch** como en MohoMCP, pero nativo: API JS en proceso con `batch([...ops])` transaccional y con undo.

### 6.2 Qué simplificar

1. **Deformación de puntos**: en lugar de flexi/región/manual, usar **pesos explícitos** por punto (`[{bone, w}]`, máx. 2–4) o, mejor para SVG, **binding de capa rígido + shape keys / morphs** (acciones de un frame que mueven puntos de un path). Evita el binding implícito por distancia, que es opaco para un LLM y para el usuario.
2. **IK**: solo cadenas de 2 huesos analíticas (brazo/pierna) con objetivo y dirección de codo; sin solver iterativo general.
3. **Dinámica**: opcional, como "secundaria" con muelle amortiguado por hueso, calculada de forma determinista (simulando desde el inicio del clip o con caché), porque depende del historial.
4. **Geometría**: no replicar el grafo de puntos soldados/aristas de Moho. Cada forma = un `path` SVG con lista de vértices (y manejadores) con ID estable; morphs/interpolación exigen igual número de vértices (como Moho). Estilos compartidos por referencia a ID.
5. **Modos de interpolación exóticos** (noisy, bounce, elastic, cycle): implementarlos como **modificadores** de canal (`loop`, `noise`) en lugar de modos de keyframe.

### 6.3 Qué evitar

1. **IDs enteros posicionales** (`fParent = 3`, `Bone(id)`, `Layer(id)`): se rompen al borrar/reordenar y son confusos para un LLM. Usar IDs string estables y legibles (`"brazo_izq"`), con `uuid` opcional (Moho mismo añadió `UUID()` a las capas).
2. **Semántica por convención de nombres** (smart action = acción con el mismo nombre que el hueso; "nombre 2" para el sentido contrario). Hacerlo explícito en datos.
3. **Mezclar estado de UI y datos persistentes** (`fSelected`, `fTemp*`, `fShy`, `tags` de color en los mismos objetos). Separar `editorState` del documento.
4. **Scripts embebidos ejecutados en cada redibujado con efectos laterales**: si se permite lógica, que sean expresiones puras (`value = f(otros canales, t)`) evaluadas en orden topológico, serializables en JSON y seguras (sin `eval` libre).
5. **Valores evaluados guardados junto a los canales** (`fPos` vs `fAnimPos`): en el JSON solo guardar los canales; el estado evaluado vive en el runtime.
6. **JSON minificado y sin esquema publicado**: publicar un JSON Schema versionado, formateado de forma estable (orden de claves determinista) para diffs y para que el LLM edite con parches.

### 6.4 Esqueleto de JSON sugerido (ilustrativo)

```json
{
  "formatVersion": "0.1",
  "meta": { "fps": 24, "size": [1080, 1080], "start": 1, "end": 96 },
  "styles": { "piel": { "fill": "#f2c9a0", "stroke": "#3a2a1a", "strokeWidth": 2 } },
  "rig": {
    "bones": [
      { "id": "torso", "parent": null, "pos": [0, 0], "angle": 90, "length": 120 },
      { "id": "cabeza", "parent": "torso", "pos": [0, 120], "angle": 0, "length": 60,
        "independentAngle": true, "limits": { "angle": [-30, 30] } },
      { "id": "ctrl_giro", "parent": null, "role": "control", "limits": { "angle": [-90, 90] } }
    ],
    "layers": [
      { "id": "cuerpo", "type": "group", "bone": "torso", "children": [
        { "id": "boca", "type": "switch", "bone": "cabeza", "value": "neutral",
          "children": [ { "id": "neutral", "type": "path", "d": "..." },
                        { "id": "A", "type": "path", "d": "..." } ] }
      ] }
    ],
    "drivers": [
      { "id": "giro_cabeza", "input": "bones.ctrl_giro.angle", "inputRange": [-90, 90],
        "action": "giro_cabeza", "actionRange": [0, 1] }
    ]
  },
  "actions": {
    "giro_cabeza": { "duration": 1, "tracks": {
      "layers.cara.points.nariz": { "type": "vec2",
        "keys": [ { "t": 0, "v": [-20, 0], "interp": "linear" }, { "t": 1, "v": [20, 0] } ] } } }
  },
  "timeline": {
    "tracks": {
      "bones.cabeza.angle": { "type": "number",
        "keys": [ { "t": 1, "v": 0, "interp": "easeInOut" }, { "t": 24, "v": 15, "hold": 2 } ] },
      "layers.boca.value": { "type": "string", "keys": [ { "t": 1, "v": "neutral" }, { "t": 12, "v": "A" } ] }
    },
    "clips": [ { "action": "parpadeo", "start": 30, "mode": "reference", "weight": 1 } ]
  }
}
```

Puntos clave del esqueleto: rutas de canal como strings (`bones.cabeza.angle`) para que un LLM pueda dirigir cualquier propiedad; rig y animación separados; drivers explícitos; switches con valor string.

---

## 7. Tabla: concepto Moho → equivalente propuesto en aia-studio

| Concepto Moho | Qué es en Moho | Equivalente propuesto en aia-studio |
|---|---|---|
| `MohoDoc` | Documento: capas, estilos, fps, rango, cámara | `document` raíz con `meta`, `styles`, `rig`, `actions`, `timeline`, `camera` |
| `MohoLayer` + `LT_*` | Capa tipada con transformación animable | Nodo `layer` con `type` (`group`, `path`, `image`, `switch`, `text`) y `transform` |
| `GroupLayer` | Contenedor | `<g>` SVG; `type: "group"` |
| `BoneLayer` | Grupo + esqueleto; sus hijas se deforman | `rig.bones` global por personaje; capas referencian un hueso (`"bone"`) |
| `MeshLayer` / `M_Mesh` | Grafo de puntos/curvas/shapes | `type: "path"` con vértices con ID (o `d` SVG) y estilo por referencia |
| `M_Point` (+ `fParent`) | Punto animable, ligado a 0/1 hueso | Vértice `{id, pos, handles}`; pesos opcionales `[{bone, w}]` (fase 2) |
| `M_Curve` curvatura / handles | Suavidad por punto, Bézier | Manejadores explícitos por vértice |
| `M_Shape` + `M_Style` | Relleno/contorno con estilo propio o heredado | Atributos SVG + `styleRef` a `styles` |
| `ImageLayer` | Bitmap, deformable por huesos | `<image>` ligado rígido a un hueso (deformación por malla: no en v1) |
| `SwitchLayer` + `AnimString` | Un hijo visible, elegido por string | `type: "switch"`, canal `string` `value` |
| Switch "interpolate sub-layers" | Morph entre dibujos con mismos puntos | Morph de path con igual número de vértices |
| `PatchLayer` | Oculta costuras entre piezas | Máscaras/`clipPath` o capa duplicada; no implementar como tipo propio en v1 |
| `ParticleLayer` | Emisor de copias | Fuera de alcance v1 (efecto opcional) |
| `M_Skeleton` | Lista plana de huesos por índice | `rig.bones[]` con `id` string y `parent` por id |
| `M_Bone` pos/ángulo/escala/longitud | Transformación local + longitud | `pos`, `angle`, `scale`, `length` |
| `fAnimParent` | Padre animable | Canal `string` `bones.X.parent` (fase 2) |
| `fFixedAngle` | No hereda rotación del padre | `independentAngle: true` |
| `fMin/MaxConstraint` | Límites de ángulo | `limits.angle: [min, max]` |
| `fAngle/Pos/ScaleControlParent` + scale + delay | Copiar transformación de otro hueso | `constraints: [{type:"copyRotation", source, factor, delayFrames}]` |
| IK (`fTargetBone`, `fIKLock`) | Objetivos y bloqueos | `ik: {chain:[a,b], target, bendDirection}` (2 huesos analítico) |
| `fFlipH` / `fFlipV` | Flip animable de hueso | Canales `bool` `flipX`/`flipY` en huesos y capas |
| Dinámica de huesos | Muelle por canal | `secondary: {stiffness, damping}` opcional, determinista |
| Flexi / región / point binding | Binding por distancia o manual | Binding rígido de capa (v1) + pesos explícitos o morphs (v2) |
| Layer binding | Capa pegada a un hueso | `layer.bone = "id"` → `transform` heredada |
| `AnimChannel` y subtipos | Canal tipado con keys | `track {type, keys[]}` dirigido por ruta string |
| `InterpSetting` (mode, val1, val2, hold, interval) | Interpolación por key | `key {t, v, interp, bezier?, hold?, interval?}` |
| `INTERP_CYCLE`, `NOISY` | Modos especiales | Modificadores de pista `loop`, `noise` |
| Frame 0 | Pose de setup | `rig` (estado base) separado de `timeline` |
| Acción | Sub-pista con nombre en cada canal | `actions[nombre].tracks` |
| `InsertAction` / `ByReference` | Copiar o referenciar acción | `timeline.clips[{action, start, mode:"reference"|"bake", weight}]` |
| Morph (acción de 1 frame) | Pose blendable | `pose` / shape key con peso animable |
| Smart Bone Action / Dial | Rotación de hueso reproduce acción | `drivers[{input, inputRange, action, actionRange}]` explícitos |
| `LayerScript` | Lua en cada redibujado | Expresiones puras declarativas (`expr`) evaluadas en orden; sin efectos laterales |
| Tool / menu scripts | Extensiones de UI y batch | API JS (`aia.apply(ops)`) + plugins de editor |
| `PrepUndo` / `SetDirty` | Undo manual | Toda operación pasa por un log de comandos con undo automático |
| `UUID()` de capa | ID estable | `id` string obligatorio y único en todos los objetos |
| `.moho` = ZIP + `Project.mohoproj` JSON + preview | Contenedor | `.aia` = ZIP opcional con `project.json` + `assets/` + `preview.png`; JSON plano también válido |
| Ignorar propiedades desconocidas | Compatibilidad | `formatVersion` + JSON Schema publicado + migraciones |
| MohoMCP (IPC por ficheros, batch ≤ 50 ops) | Puente LLM externo | API nativa en proceso, transaccional, con validación por esquema |

---

## 8. Fuentes

Documentación de la API Lua (no oficial, mohoscripting.com):

- Índice y módulo MOHO: https://mohoscripting.com/ — https://mohoscripting.com/modules/moho
- MohoDoc: https://mohoscripting.com/classes/mohodoc
- MohoLayer: https://mohoscripting.com/classes/moholayer
- MohoLayerChannel: https://mohoscripting.com/classes/moholayerchannel
- BoneLayer: https://mohoscripting.com/classes/bonelayer
- MeshLayer: https://mohoscripting.com/classes/meshlayer
- SwitchLayer: https://mohoscripting.com/classes/switchlayer
- M_Skeleton: https://mohoscripting.com/classes/m-skeleton
- M_Bone: https://mohoscripting.com/classes/m-bone
- M_Mesh: https://mohoscripting.com/classes/m-mesh
- M_Point: https://mohoscripting.com/classes/m-point
- M_Curve: https://mohoscripting.com/classes/m-curve
- M_Shape: https://mohoscripting.com/classes/m-shape
- AnimChannel: https://mohoscripting.com/classes/animchannel
- InterpSetting: https://mohoscripting.com/classes/interpsetting
- ScriptInterface: https://mohoscripting.com/classes/scriptinterface
- Estructura de scripts: https://mohoscripting.com/script_structure
- Convenciones: https://mohoscripting.com/scripting-conventions

Manual de Moho (Lost Marble):

- Animación (frame 0, keyframes): https://www.lostmarble.com/moho/manual/animation.html
- Tutorial 3.1, binding de huesos: https://www.lostmarble.com/moho/manual/tut03/01
- Capas vectoriales: https://www.lostmarble.com/moho/manual/vector_layers.html
- Switch layers: https://www.lostmarble.com/moho/manual/switch_layers.html
- Manual de tutoriales 13.5 (PDF): https://lostmarble.com/manual/13.5/Moho%20Tutorial%20Manual.pdf

Foro lostmarble.com y otros:

- Formato de documento AS11 (ZIP + JSON, secciones): https://lostmarble.net/forum/viewtopic.php?p=155931
- Abrir .moho con un editor de texto: https://lostmarble.net/forum/viewtopic.php?t=35643
- Error "Failed to parse JSON document": https://lostmarble.net/forum/viewtopic.php?t=34890
- Editar archivos .moho: https://www.lostmarble.com/forum/viewtopic.php?p=173914
- Smart Action vs Smart Bone Dial: https://lostmarble.net/forum/viewtopic.php?t=35634
- Arreglar una smart bone action (nombre = hueso): https://lostmarble.net/forum/viewtopic.php?t=36005
- Patch layers (equivalente al Auto Patch de Toon Boom): https://www.lostmarble.com/forum/viewtopic.php?p=214813
- Embedded scripts (`LayerScript`): https://lostmarble.com/forum/viewtopic.php?p=11000
- Tutorial Smart Bones (Designs by Nikolai): https://designsbynikolai.com/2026/04/07/part-12-38-basic-smart-bones-learning-moho-from-beginner-to-expert/
- Consejos sobre smart bone actions (Lester Banks): https://lesterbanks.com/?p=49659
- MohoMCP (puente MCP ↔ Moho vía Lua): https://cdn.jsdelivr.net/gh/Kveto/MohoMCP@master/README.md
- Extensión .mohoproj: https://fileinfo.com/extension/mohoproj — .moho: https://fileinfo.com/extension/moho

Nota: no se encontraron repositorios públicos de A. Evseeva en GitHub mediante búsqueda; sus scripts suelen distribuirse vía el foro de Lost Marble y mohoscripts.com. El esquema exacto de claves de keyframes dentro de `Project.mohoproj` no está documentado públicamente: para confirmarlo hay que descomprimir un `.moho` real y formatear el JSON.
