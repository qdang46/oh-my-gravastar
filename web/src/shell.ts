/**
 * Application shell — clones the vendor 1khub `MainLayout` structure:
 *
 *   aside.sidebar            collapsible left nav (device name on top,
 *                            icon+label items, tooltips when collapsed,
 *                            auto-collapse < 768 px, ☰/✕ toggle)
 *   .main-col > header.topbar  logo + device status + connect controls
 *   .status                    global status line
 *   main.page                  routed page content
 *
 * The vendor header's language dropdown (en/zh) and onboard-config entry
 * are omitted — this build is English-only and has no config profiles yet.
 */

import {
  app,
  autoConnect,
  bootStatus,
  connect,
  disconnect,
  enableEditing,
  refresh,
  subscribe,
} from './state.ts';
import { installHidDeviceEvents } from './device-events.ts';
import { NAV_PAGES, initPages, type PageId } from './pages.ts';

// ── Inline SVG icons (stroke, 24 px viewBox — vendor uses an icon font) ──

const ICONS: Record<PageId, string> = {
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="10" rx="1.5"/><rect x="13" y="3" width="8" height="6" rx="1.5"/><rect x="13" y="11" width="8" height="10" rx="1.5"/><rect x="3" y="15" width="8" height="6" rx="1.5"/></svg>',
  lighting: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  keys: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/></svg>',
  macro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-5-6-5M12 19h8"/></svg>',
  advanced: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h10M18 8h2M4 16h2M10 16h10"/><circle cx="16" cy="8" r="2"/><circle cx="8" cy="16" r="2"/></svg>',
  music: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v11"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="15" r="2.5"/></svg>',
  performance: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-6 4 3 6-8"/><path d="M14 6h4v4"/><path d="M3 21h18"/></svg>',
  device: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>',
  diagnostics: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-7 4 14 2-7h6"/></svg>',
  basic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="8" height="8" rx="1.5"/><rect x="13" y="4" width="8" height="8" rx="1.5"/><rect x="3" y="14" width="8" height="6" rx="1.5"/><rect x="13" y="14" width="8" height="6" rx="1.5"/></svg>',
  config: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h10M4 17h13"/><path d="M18 9l3 3-3 3"/></svg>',
  rhythm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v11"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="15" r="2.5"/></svg>',
  setting: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>',
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

export function mountShell(root: HTMLElement): void {
  root.replaceChildren();

  // Vendor MainLayout paints a fixed product background (allbg png).
  const bg = document.createElement('img');
  bg.className = 'app-bg';
  bg.src = './allbg.png';
  bg.alt = '';
  bg.setAttribute('aria-hidden', 'true');
  bg.addEventListener('error', () => bg.remove());
  root.append(bg);

  // ── Sidebar (vendor `aside.sidebar`) ──────────────────────────────
  const sidebar = el('aside', 'sidebar');
  const deviceName = el('div', 'menu-device-name', 'No device');
  sidebar.append(deviceName);

  const nav = el('nav', 'sidebar-nav');
  for (const p of NAV_PAGES) {
    const a = el('a', 'nav-item');
    a.href = `#${p.path}`;
    a.dataset.page = p.id;
    const icon = el('span', 'nav-icon');
    icon.innerHTML = ICONS[p.id];
    const label = el('span', 'nav-text', p.title);
    const tip = el('span', 'nav-tooltip', p.title);
    a.append(icon, label, tip);
    nav.append(a);
  }
  sidebar.append(nav);

  const footer = el('div', 'sidebar-footer');
  const collapseBtn = el('button', 'collapse-btn', '✕');
  collapseBtn.type = 'button';
  collapseBtn.title = 'Collapse sidebar';
  footer.append(el('h2', 'sidebar-title', 'Menu'), collapseBtn);
  sidebar.append(footer);

  // ── Main column: topbar + status + page ───────────────────────────
  const mainCol = el('div', 'main-col');

  const topbar = el('header', 'topbar');
  const brand = el('div', 'brand');
  const mark = el('span', 'brand-mark');
  mark.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/></svg>';
  brand.append(
    mark,
    el('span', 'brand-name', 'oh-my-gravastar'),
    el('span', 'brand-sub', 'GravaStar keyboard setup'),
  );
  const actions = el('div', 'topbar-actions');
  const deviceChip = el('span', 'device-chip', '');
  const connectBtn = el('button', 'primary', 'Connect');
  connectBtn.type = 'button';
  // `danger` styling keeps Disconnect visually prominent whenever a
  // device is connected (R6: easy disconnect after auto-reconnect).
  const disconnectBtn = el('button', 'danger', 'Disconnect');
  disconnectBtn.type = 'button';
  disconnectBtn.hidden = true;
  const refreshBtn = el('button', '', 'Refresh');
  refreshBtn.type = 'button';
  refreshBtn.hidden = true;
  actions.append(deviceChip, connectBtn, disconnectBtn, refreshBtn);
  topbar.append(brand, actions);

  const statusEl = el('p', 'status', app.status);
  // Shown while the Music page streams cmd-8 frames (app.musicActive) —
  // other pages' lighting writes are effectively overridden until Stop.
  const musicBanner = el(
    'div',
    'music-banner',
    'Music mode is active — the keyboard lights follow your microphone. ' +
      'Press Stop on the Music page to restore your lighting.',
  );
  musicBanner.hidden = true;
  // Read-only gate banner (conn-lifecycle): after a silent auto/hot-plug
  // reconnect the session is live for viewing but writes stay blocked
  // until this explicit "Enable editing" click (safety contract R6).
  const editBanner = el('div', 'edit-banner');
  const editBannerText = el(
    'span',
    'edit-banner-text',
    'Connected — read only. The keyboard is live for viewing; ' +
      'changes stay off until you approve this session.',
  );
  const editBtn = el('button', 'edit-banner-btn', 'Enable editing');
  editBtn.type = 'button';
  editBanner.append(editBannerText, editBtn);
  editBanner.hidden = true;
  const page = el('main', 'page');
  mainCol.append(topbar, statusEl, musicBanner, editBanner, page);

  const shell = el('div', 'shell');
  shell.append(sidebar, mainCol);
  root.append(shell);

  // ── Wiring ────────────────────────────────────────────────────────

  const setCollapsed = (collapsed: boolean): void => {
    sidebar.classList.toggle('sidebar-collapsed', collapsed);
    collapseBtn.textContent = collapsed ? '☰' : '✕';
    collapseBtn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  };
  collapseBtn.addEventListener('click', () => {
    setCollapsed(!sidebar.classList.contains('sidebar-collapsed'));
  });
  const onResize = (): void => {
    if (window.innerWidth < 768) setCollapsed(true);
  };
  window.addEventListener('resize', onResize);
  onResize();

  connectBtn.addEventListener('click', () => void connect());
  disconnectBtn.addEventListener('click', () => void disconnect());
  refreshBtn.addEventListener('click', () => void refresh());
  editBtn.addEventListener('click', enableEditing);

  // Sidebar tooltip positioning when collapsed (vendor behaviour).
  nav.addEventListener('mouseover', (e) => {
    if (!sidebar.classList.contains('sidebar-collapsed')) return;
    const item = (e.target as HTMLElement).closest<HTMLElement>('.nav-item');
    const tip = item?.querySelector<HTMLElement>('.nav-tooltip');
    if (!item || !tip) return;
    const r = item.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    tip.style.left = `${r.left + r.width / 2}px`;
    tip.style.top = `${r.top - tr.height - 10}px`;
    tip.style.transform = 'translateX(-50%)';
    tip.style.opacity = '1';
    tip.style.visibility = 'visible';
  });
  nav.addEventListener('mouseout', () => {
    nav.querySelectorAll<HTMLElement>('.nav-tooltip').forEach((t) => {
      t.style.opacity = '0';
      t.style.visibility = 'hidden';
    });
  });

  // ── State → chrome sync ───────────────────────────────────────────

  subscribe(() => {
    statusEl.textContent = app.status;
    statusEl.classList.toggle('error', app.statusError);
    musicBanner.hidden = !app.musicActive;
    // Show the read-only banner whenever the live session's write gate
    // is closed (silent reconnect / hot-plug connect / poison recovery).
    editBanner.hidden = app.connected?.session.writesBlocked !== true;

    const connected = app.connected !== null;
    connectBtn.hidden = connected || app.busy;
    disconnectBtn.hidden = !connected;
    refreshBtn.hidden = !connected;
    connectBtn.disabled = app.busy;
    refreshBtn.disabled = app.busy;

    const snap = app.snapshot;
    // Always name the actual device (product + model), never just
    // "connected" — critical after a silent auto-reconnect (R6).
    const label =
      app.deviceLabel || snap?.info.catalogName || (connected ? 'Connected device' : 'No device');
    deviceName.textContent = label;
    deviceChip.replaceChildren();
    const dot = el('span', 'dot');
    deviceChip.append(
      dot,
      document.createTextNode(
        snap
          ? `${app.deviceLabel || snap.info.catalogName || 'Keyboard'} · Battery ${snap.power.percent}%`
          : connected
            ? app.deviceLabel || 'Connected'
            : '',
      ),
    );
    deviceChip.hidden = !connected;
  });

  initPages(page, nav);
  // Hot-plug: auto-open read-only sessions for granted keyboards and
  // drop the session instantly when the active device disappears.
  installHidDeviceEvents();
  void bootStatus().then(() => {
    // Silent reconnect when the browser still holds permission for the
    // keyboard — non-tech users shouldn't have to click Connect every load.
    if (!app.connected) void autoConnect();
  });
}
