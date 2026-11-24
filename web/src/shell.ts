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
 * The vendor header's onboard-config entry is omitted — this build has no
 * config profiles yet. The language dropdown position is reused for the
 * EN/VI toggle (vendor ships en/zh).
 */

import { app, autoConnect, bootStatus, connect, disconnect, emit, refresh, subscribe } from './state.ts';
import { PAGES, initPages, type PageId } from './pages.ts';
import { getLang, onLangChange, setLang, t, type Locale } from './i18n.ts';
import { initOnboarding } from './onboard.ts';

// ── Inline SVG icons (stroke, 24 px viewBox — vendor uses an icon font) ──

const ICONS: Record<PageId, string> = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  lighting: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  keys: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/></svg>',
  macro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-5-6-5M12 19h8"/></svg>',
  advanced: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h10M18 8h2M4 16h2M10 16h10"/><circle cx="16" cy="8" r="2"/><circle cx="8" cy="16" r="2"/></svg>',
  device: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>',
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
  const deviceName = el('div', 'menu-device-name', t('shell.noDevice'));
  sidebar.append(deviceName);

  const nav = el('nav', 'sidebar-nav');
  const navTexts = new Map<PageId, { label: HTMLElement; tip: HTMLElement }>();
  for (const p of PAGES) {
    const a = el('a', 'nav-item');
    a.href = `#${p.path}`;
    a.dataset.page = p.id;
    const icon = el('span', 'nav-icon');
    icon.innerHTML = ICONS[p.id];
    const label = el('span', 'nav-text', t(`page.${p.id}.title`));
    const tip = el('span', 'nav-tooltip', t(`page.${p.id}.title`));
    a.append(icon, label, tip);
    nav.append(a);
    navTexts.set(p.id, { label, tip });
  }
  sidebar.append(nav);

  const footer = el('div', 'sidebar-footer');
  const collapseBtn = el('button', 'collapse-btn', '✕');
  collapseBtn.type = 'button';
  collapseBtn.title = t('shell.collapse');
  footer.append(el('h2', 'sidebar-title', t('shell.menu')), collapseBtn);
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
    el('span', 'brand-sub', t('shell.brandSub')),
  );
  const actions = el('div', 'topbar-actions');

  // Language toggle — vendor header position (its en/zh dropdown slot).
  const lang = el('div', 'lang-toggle');
  lang.setAttribute('role', 'group');
  lang.setAttribute('aria-label', t('shell.langLabel'));
  const langBtns: Record<Locale, HTMLButtonElement> = { en: el('button'), vi: el('button') };
  for (const l of ['en', 'vi'] as const) {
    langBtns[l].type = 'button';
    langBtns[l].textContent = l.toUpperCase();
    langBtns[l].dataset.lang = l;
    langBtns[l].addEventListener('click', () => {
      setLang(l);
      syncLangToggle();
      emit();
    });
    lang.append(langBtns[l]);
  }
  const syncLangToggle = (): void => {
    const cur = getLang();
    for (const l of ['en', 'vi'] as const) {
      langBtns[l].classList.toggle('active', l === cur);
      langBtns[l].setAttribute('aria-pressed', String(l === cur));
    }
  };
  syncLangToggle();

  const deviceChip = el('span', 'device-chip', '');
  const connectBtn = el('button', 'primary', t('shell.connect'));
  connectBtn.type = 'button';
  const disconnectBtn = el('button', '', t('shell.disconnect'));
  disconnectBtn.type = 'button';
  disconnectBtn.hidden = true;
  const refreshBtn = el('button', '', t('shell.refresh'));
  refreshBtn.type = 'button';
  refreshBtn.hidden = true;
  actions.append(lang, deviceChip, connectBtn, disconnectBtn, refreshBtn);
  topbar.append(brand, actions);

  const statusEl = el('p', 'status', app.status);
  const page = el('main', 'page');
  mainCol.append(topbar, statusEl, page);

  const shell = el('div', 'shell');
  shell.append(sidebar, mainCol);
  root.append(shell);
  document.title = t('shell.docTitle');

  // ── Wiring ────────────────────────────────────────────────────────

  const setCollapsed = (collapsed: boolean): void => {
    sidebar.classList.toggle('sidebar-collapsed', collapsed);
    collapseBtn.textContent = collapsed ? '☰' : '✕';
    collapseBtn.title = collapsed ? t('shell.expand') : t('shell.collapse');
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

    const connected = app.connected !== null;
    connectBtn.hidden = connected || app.busy;
    disconnectBtn.hidden = !connected;
    refreshBtn.hidden = !connected;
    connectBtn.disabled = app.busy;
    refreshBtn.disabled = app.busy;

    const snap = app.snapshot;
    deviceName.textContent =
      snap?.info.catalogName ?? (connected ? t('shell.connectedDevice') : t('shell.noDevice'));
    deviceChip.replaceChildren();
    const dot = el('span', 'dot');
    deviceChip.append(
      dot,
      document.createTextNode(
        snap
          ? `${snap.info.catalogName ?? t('shell.keyboard')} · ${t('common.battery', { pct: snap.power.percent })}`
          : connected
            ? t('shell.connected')
            : '',
      ),
    );
    deviceChip.hidden = !connected;
  });

  initPages(page, nav);

  // Language change: refresh chrome labels, then emit() so every page
  // re-renders in the new locale (stateful views rebuild via their own
  // subscribe handlers / langEpoch checks).
  onLangChange(() => {
    for (const [id, texts] of navTexts) {
      const label = t(`page.${id}.title`);
      texts.label.textContent = label;
      texts.tip.textContent = label;
    }
    connectBtn.textContent = t('shell.connect');
    disconnectBtn.textContent = t('shell.disconnect');
    refreshBtn.textContent = t('shell.refresh');
    collapseBtn.title = sidebar.classList.contains('sidebar-collapsed')
      ? t('shell.expand')
      : t('shell.collapse');
    sidebar.querySelector('.sidebar-title')!.textContent = t('shell.menu');
    brand.querySelector('.brand-sub')!.textContent = t('shell.brandSub');
    lang.setAttribute('aria-label', t('shell.langLabel'));
    document.title = t('shell.docTitle');
    syncLangToggle();
    emit();
  });

  initOnboarding(shell);

  void bootStatus().then(() => {
    // Silent reconnect when the browser still holds permission for the
    // keyboard — non-tech users shouldn't have to click Connect every load.
    if (!app.connected) void autoConnect();
  });
}
