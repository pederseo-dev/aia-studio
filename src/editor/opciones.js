// Barra de opciones sobre el lienzo (como la de Moho): dice qué se puede hacer con la herramienta y lo seleccionado,
// y ofrece como botones las acciones que tienen atajo. Así no hace falta saberse los atajos para descubrir qué sigue.

import { buscar } from '../core/documento.js';
import { leer } from '../core/esquema.js';
import { huesoDe, repartirEntreHuesos } from '../core/esqueleto.js';
import { avisar, ejecutar, esquema, estado, fijar, seleccionar, seleccionarVarios, suscribir } from './estado.js';
import { elegirVariante, opsDePose, varianteDe, variantesAMostrar } from './huesos.js';

/**
 * `acciones`: lo que vive en main.js y la barra también ofrece (agrupar, enlazar la selección, borrar...).
 */
export function montarOpciones(raiz, acciones) {
  suscribir((c) => {
    if (['doc', 'seleccion', 'herramienta', 'pose', 'params', 'edicion', 'vertice', 'enlazando', 'id'].some((k) => k in c)) dibujar();
  });

  const boton = (texto, titulo, alHacerClic, clase = '') => {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: texto, title: titulo, className: clase });
    b.addEventListener('click', alHacerClic);
    return b;
  };
  const texto = (html) => Object.assign(document.createElement('span'), { className: 'texto', innerHTML: html });
  const codigo = (id) => `<b>${id}</b>`;

  function dibujar() {
    const doc = estado.doc;
    raiz.hidden = !doc;
    if (!doc) return;
    raiz.replaceChildren(...contenido(doc));
    raiz.classList.toggle('en-pose', !!estado.pose);
    raiz.classList.toggle('enlazando', !!estado.enlazando);
  }

  function contenido(doc) {
    const sel = estado.seleccion && buscar(doc, estado.seleccion);
    const varios = estado.seleccionados.length > 1;
    const huesos = doc.objects.filter((o) => o.type === 'bone');

    // Enlazar con clic: el modo más específico, va primero.
    if (estado.enlazando) {
      const n = doc.objects.filter((o) => o.bone === estado.enlazando).length;
      return [
        texto(`Clic en el dibujo (o en su fila de la jerarquía) para pegarlo a ${codigo(estado.enlazando)}; otro clic lo suelta. Alt + clic toma el grupo que lo contiene. ${n} enlazado${n === 1 ? '' : 's'}.`),
        boton('Listo', 'Terminar de enlazar (Esc)', () => fijar({ enlazando: null }), 'principal'),
      ];
    }

    if (estado.pose) {
      const pose = buscar(doc, estado.pose);
      const partes = [
        texto(
          estado.edicion
            ? `Pose ${codigo(estado.pose)}: los puntos que muevas quedan en la pose (con la misma cantidad de puntos, los params la interpolan). El montaje no cambia.`
            : `Pose ${codigo(estado.pose)}: arrastra un hueso o el dibujo enlazado para girarlo. Lo demás (boca, colores, switch...) se cambia en el inspector, que muestra arriba lo de la pose; <kbd>Enter</kbd> edita los puntos de un path en la pose.`,
        ),
      ];
      if (sel && pose?.values?.[sel.id]) {
        partes.push(boton(`Quitar ${sel.id} de la pose`, 'Vuelve a como está en el montaje, solo en esta pose', () => ejecutar(opsDePose(doc, pose.id, sel.id, Object.fromEntries(Object.keys(pose.values[sel.id]).map((k) => [k, undefined]))), `pose ${pose.id}: ${sel.id} del montaje`)));
      }
      if (estado.edicion) partes.push(boton('Terminar puntos', 'Salir de la edición de puntos (Enter)', () => fijar({ edicion: null, vertice: null })));
      partes.push(boton('Volver al montaje', 'Para editar el dibujo y el esqueleto en reposo', () => fijar({ pose: null, edicion: null, vertice: null }), 'principal'));
      return partes;
    }

    if (estado.params) {
      return [
        texto('Parámetros: el personaje se ve con la mezcla de poses que dan los controles de abajo. Aquí no se edita; para cambiar una pose, elígela en «Ver».'),
        boton('Volver al montaje', 'Dejar de ver la mezcla', () => fijar({ params: null }), 'principal'),
      ];
    }

    if (estado.edicion) {
      const partes = [texto('Puntos: arrastra anclas y tangentes (Alt separa), doble clic en un ancla = recto o curvo, clic en el contorno agrega, <kbd>Supr</kbd> borra.')];
      if (huesos.length) partes.push(...huesosDePuntos(doc, huesos));
      partes.push(boton('Terminar', 'Salir de la edición de puntos (Enter)', () => fijar({ edicion: null, vertice: null }), 'principal'));
      return partes;
    }

    if (sel?.type === 'bone' && !varios) return opcionesDeHueso(doc, sel);

    switch (estado.herramienta) {
      case 'hueso':
        return [texto(huesos.length ? 'Hueso: arrastra en vacío para crear uno suelto, o elige un hueso y arrastra desde su punta para encadenar. Arrastrar un hueso lo gira.' : 'Hueso: arrastra en el lienzo para crear el primero (desde la articulación hacia la punta).')];
      case 'path':
        return [texto('Pluma: clic = punto recto, clic y arrastrar = curvo, clic en el primero = cerrar, <kbd>Enter</kbd> = terminar abierto.')];
      case 'rect':
      case 'ellipse':
        return [texto(`Arrastra para dibujar ${estado.herramienta === 'rect' ? 'un rectángulo' : 'una elipse'}; <kbd>Shift</kbd> = ${estado.herramienta === 'rect' ? 'cuadrado' : 'círculo'}.`)];
      case 'rotar':
      case 'escalar':
        return [texto(`${estado.herramienta === 'rotar' ? 'Rotar' : 'Escalar'}: arrastra en cualquier parte; la selección ${estado.herramienta === 'rotar' ? 'gira' : 'escala'} desde su pivote.`)];
    }

    if (varios) {
      const ids = estado.seleccionados;
      const partes = [
        texto(`${ids.length} objetos: arrastra para moverlos; las manijas giran y escalan el conjunto.`),
        boton('Agrupar', 'Meterlos en un grupo nuevo (Ctrl+G)', acciones.agrupar),
        boton('Switch', 'Meterlos en un switch: cada uno es una variante y se ve una a la vez (Shift+G)', acciones.switch),
      ];
      const hueso = ids.map((id) => buscar(doc, id)).filter((o) => o?.type === 'bone');
      if (hueso.length === 1) partes.push(boton(`Enlazar a ${hueso[0].id}`, 'Pegar el dibujo seleccionado a este hueso (Ctrl+B)', acciones.enlazar));
      return partes;
    }

    if (sel?.type === 'switch') return opcionesDeSwitch(doc, sel);

    if (sel && !esquema.tipos.get(sel.type).resource) {
      const padre = sel.parent && buscar(doc, sel.parent);
      if (padre?.type === 'switch') {
        // Una variante de un switch: avisar si se ve solo porque está seleccionada, y dejar elegir la que se ve.
        const deVista = variantesAMostrar(doc)[padre.id] === sel.id;
        return [
          texto(`${codigo(sel.id)} es una variante del switch ${codigo(padre.id)}.${deVista ? ' Se ve mientras está seleccionada para que puedas editarla, pero el switch muestra otra.' : ''}`),
          selectorDeVariante(doc, padre),
          boton('Ir al switch', `Seleccionar ${padre.id}`, () => seleccionar(padre.id)),
        ];
      }
      const partes = [texto('Arrastra para mover. Manijas: círculo de arriba = rotar, esquinas = escalar, punto = pivote (moverlo no mueve el dibujo).')];
      const hueso = huesoDe(doc, sel.id);
      if (sel.bone) {
        partes.push(texto(`Sigue al hueso ${codigo(sel.bone)}.`));
        partes.push(boton('Desenlazar', 'Que deje de seguir al hueso', () => ejecutar([{ op: 'unset', target: sel.id, props: ['bone'] }], `desenlazar ${sel.id}`)));
        partes.push(boton('Ir al hueso', `Seleccionar ${sel.bone}`, () => seleccionar(sel.bone)));
      } else if (hueso) {
        partes.push(texto(`Sigue a ${codigo(hueso)} a través de su grupo.`));
      } else if (huesos.length) {
        partes.push(texto('Para pegarlo a un hueso: selecciona el hueso y usa «Enlazar dibujo…».'));
      }
      return partes;
    }

    return [texto(huesos.length ? 'Clic para seleccionar; arrastra en vacío para un recuadro. Los huesos se eligen con la herramienta Hueso (B) o en la jerarquía.' : 'Clic para seleccionar; arrastra en vacío para seleccionar con un recuadro.')];
  }

  /**
   * Enlace por punto: el hueso que sigue el vértice elegido, y repartir todos entre los huesos cercanos. Así un solo
   * path se dobla con una cadena de huesos.
   */
  function huesosDePuntos(doc, huesos) {
    const path = buscar(doc, estado.edicion);
    const vertices = leer(esquema, path, 'vertices');
    const guardar = (nuevos, nota) => ejecutar([{ op: 'set', target: path.id, props: { vertices: nuevos } }], `${nota} en ${path.id}`);
    const partes = [];
    if (estado.vertice != null && vertices[estado.vertice]) {
      const i = estado.vertice;
      const etiqueta = Object.assign(document.createElement('label'), { className: 'texto', textContent: `Punto ${i} sigue a ` });
      const select = document.createElement('select');
      select.append(new Option(`(el de la forma${huesoDe(doc, path.id) ? `: ${huesoDe(doc, path.id)}` : ''})`, ''), ...huesos.map((h) => new Option(h.id, h.id)));
      select.value = vertices[i].bone ?? '';
      select.addEventListener('change', () => {
        const { bone, ...resto } = vertices[i];
        guardar(vertices.map((v, j) => (j === i ? (select.value ? { ...resto, bone: select.value } : resto) : v)), `punto ${i} ${select.value ? `a ${select.value}` : 'sin hueso'}`);
      });
      etiqueta.append(select);
      partes.push(etiqueta);
    }
    partes.push(
      boton('Repartir entre huesos', 'Cada punto sigue al hueso más cercano: el path se dobla con la cadena en las poses', () => {
        try {
          guardar(repartirEntreHuesos(doc, esquema, path.id), 'repartir puntos entre huesos');
        } catch (e) {
          avisar(e.message, true);
        }
      }),
    );
    if (vertices.some((v) => v.bone)) partes.push(boton('Quitar huesos', 'Los puntos vuelven a seguir al hueso de la forma', () => guardar(vertices.map(({ bone, ...v }) => v), 'puntos sin hueso')));
    return partes;
  }

  /** Switch: qué variante se ve (en el montaje) y cómo agregarle más. */
  function opcionesDeSwitch(doc, sw) {
    const variantes = doc.objects.filter((o) => o.parent === sw.id);
    if (!variantes.length) {
      return [texto(`Switch ${codigo(sw.id)} vacío: arrastra dibujos adentro en la jerarquía, o dibuja con él seleccionado. Cada hijo es una variante y se ve una a la vez.`)];
    }
    // ¿Ya lo elige algún param? (un driver cuya pose cambia el active de este switch)
    const controles = [
      ...new Set(
        doc.objects
          .filter((o) => o.type === 'driver' && buscar(doc, o.pose)?.values?.[sw.id]?.active !== undefined)
          .map((o) => o.param)
          .filter(Boolean),
      ),
    ];
    const partes = [selectorDeVariante(doc, sw), texto(`${variantes.length} variante${variantes.length === 1 ? '' : 's'}: para agregar, arrastra dibujos adentro o dibuja con el switch seleccionado.`)];
    if (controles.length) partes.push(texto(`Lo elige el control ${controles.map(codigo).join(', ')} (abajo, en Parámetros).`));
    else partes.push(boton('Crear control', 'Un parámetro con una opción por variante (lista abajo, en Parámetros): crea una pose por variante y sus drivers', () => crearControl(doc, sw, variantes), 'principal'));
    return partes;
  }

  /**
   * Arma lo que se necesita para elegir la variante desde un control: un param enum con una opción por hijo, una pose
   * por opción (que pone ese hijo en active) y un driver con equals para cada una.
   */
  function crearControl(doc, sw, variantes) {
    const base = prompt('Nombre del control (por ejemplo viseme, mouth_shape):', `${sw.id}_choice`)?.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!base) return;
    const param = /^[a-z]/.test(base) ? base : `param_${base}`;
    // Opciones cortas: sin el prefijo del switch si todas lo tienen (mouth_a → a).
    const prefijo = `${sw.id}_`;
    const corto = variantes.every((v) => v.id.startsWith(prefijo) && v.id.length > prefijo.length);
    const opciones = variantes.map((v) => (corto ? v.id.slice(prefijo.length) : v.id));
    const ops = [{ op: 'create', type: 'param', id: param, props: { kind: 'enum', options: opciones, initial: opciones[variantes.findIndex((v) => v.id === varianteDe(doc, sw))] ?? opciones[0] } }];
    variantes.forEach((v, i) => {
      const pose = `${param}_${opciones[i]}`;
      ops.push({ op: 'create', type: 'pose', id: pose, props: { values: { [sw.id]: { active: v.id } } } });
      ops.push({ op: 'create', type: 'driver', id: `${pose}_driver`, props: { param, pose, equals: opciones[i] } });
    });
    const repetido = ops.find((o) => buscar(doc, o.id));
    if (repetido) return avisar(`Ya existe "${repetido.id}"; elige otro nombre para el control`, true);
    ejecutar(ops, `control ${param} para ${sw.id} (${opciones.length} opciones)`);
    avisar(`Listo: el control ${param} está abajo, en Parámetros`);
  }

  /** «X muestra [lista]»: en una pose cambia la pose; si no, el montaje. */
  function selectorDeVariante(doc, sw) {
    const variantes = doc.objects.filter((o) => o.parent === sw.id);
    const etiqueta = Object.assign(document.createElement('label'), { className: 'texto', textContent: `${estado.pose ? `En la pose ${estado.pose}, ` : ''}${sw.id} muestra ` });
    const select = document.createElement('select');
    select.append(...variantes.map((o) => new Option(o.id, o.id, false, o.id === varianteDe(doc, sw))));
    select.title = 'Qué variante se ve. Para que la elija un control: una pose por variante (active) y drivers con equals.';
    select.addEventListener('change', () => elegirVariante(sw.id, select.value));
    etiqueta.append(select);
    return etiqueta;
  }

  function opcionesDeHueso(doc, hueso) {
    const enlazados = doc.objects.filter((o) => o.bone === hueso.id);
    const poses = doc.objects.filter((o) => o.type === 'pose');
    const resumen = enlazados.length
      ? `Montaje: ${codigo(hueso.id)} mueve a ${enlazados.length} objeto${enlazados.length === 1 ? '' : 's'}, pero solo en las poses; aquí se acomoda sobre el dibujo.`
      : `Montaje: acomoda ${codigo(hueso.id)} sobre el dibujo y pégale las partes que debe mover.`;
    const partes = [
      texto(resumen),
      boton('Enlazar dibujo…', 'Elegir con clics qué partes sigue este hueso', () => fijar({ enlazando: hueso.id }), enlazados.length ? '' : 'principal'),
    ];
    if (enlazados.length) partes.push(boton(`Ver lo enlazado (${enlazados.length})`, 'Seleccionar las partes pegadas a este hueso', () => seleccionarVarios(enlazados.map((o) => o.id))));
    partes.push(boton('＋ Hueso hijo', 'Herramienta Hueso: arrastra desde la punta de este hueso para encadenar otro (B)', () => fijar({ herramienta: 'hueso' })));
    partes.push(
      boton(
        poses.length ? `Probar en la pose ${poses[0].id}` : 'Probar en una pose',
        'Ver cómo se mueve el dibujo al girar el hueso, sin tocar el montaje',
        () => {
          if (poses.length) return fijar({ pose: poses[0].id });
          let id = 'pose_1';
          for (let n = 2; buscar(doc, id); n++) id = `pose_${n}`;
          ejecutar([{ op: 'create', type: 'pose', id }], `crear pose ${id}`);
          fijar({ pose: id });
        },
        enlazados.length ? 'principal' : '',
      ),
    );
    return partes;
  }
}
