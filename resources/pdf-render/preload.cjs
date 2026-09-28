/* global window */
// Minimal preload for the pdf-render window (04 §6.3 step 3): forwards the one MessagePort from
// main to the page. Exposes nothing on window and handles no other channel.
const { ipcRenderer } = require('electron');

ipcRenderer.once('eli5:extract:render-port', (event) => {
  window.postMessage('eli5-render-port', '*', event.ports);
});
