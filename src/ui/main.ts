/**
 * Entry point. Nothing here but construction and a loud failure if it does not construct -
 * a shell that silently renders nothing is the worst possible outcome to debug.
 */

import { App } from './app.js';

declare global {
  interface Window { logicweb?: App }
}

try {
  window.logicweb = new App();
} catch (e) {
  console.error('[logicweb] failed to start', e);
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;inset:0;margin:0;padding:24px;background:#1B1B1C;'
    + 'color:#f52a66;font:13px ui-monospace,monospace;white-space:pre-wrap;z-index:99';
  pre.textContent = `logicweb failed to start\n\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`;
  document.body.appendChild(pre);
  throw e;
}
