/**
 * oh-my-gravastar web UI — khub916 wired configurator shell.
 *
 * Vendor-clone layout (docs/research/khub-webapp/MainLayout): collapsible
 * sidebar + topbar + routed pages. Read-only: only query commands
 * (130/131/132/133/134/135/138) are issued; no write opcodes exist.
 */

import { mountShell } from './shell.ts';

const app = document.getElementById('app');
if (!app) throw new Error('missing #app');
mountShell(app);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* offline cache is best-effort */
  });
}
