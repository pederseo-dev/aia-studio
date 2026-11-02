// Punto de entrada del editor. En la fase 1 se reemplaza por la interfaz completa.

import { FORMATO } from '../core/formato.js';

document.querySelector('#app').innerHTML = `
  <h1>aia-studio</h1>
  <p>Base lista. Formato <code>${FORMATO}</code>. El editor se construye en la fase 1.</p>`;
