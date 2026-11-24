/**
 * First-run onboarding overlay (bead oh-my-gravastar-d3u).
 *
 * Shown on the home page until the user has connected successfully once
 * (localStorage 'omg-onboarded'). Friendly 3-step guide for non-technical
 * Vietnamese users, styled with the vendor theme (dark + lime accent).
 * Dismiss button or first successful connect both set the flag.
 */

import { app, subscribe } from './state.ts';
import { t } from './i18n.ts';

const FLAG = 'omg-onboarded';

function isOnboarded(): boolean {
  try {
    return localStorage.getItem(FLAG) === '1';
  } catch {
    return false;
  }
}

function markOnboarded(): void {
  try {
    localStorage.setItem(FLAG, '1');
  } catch {
    /* ignore */
  }
}

function isHomeRoute(): boolean {
  const h = location.hash.replace(/^#\/?/, '');
  return h === '' || h === 'home';
}

const ICONS = [
  // USB plug
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"/><path d="M9 8V2h6v6"/><path d="M12 8v4"/><path d="M6 12l-2 4a4 4 0 0 0 7 3l1-2 1 2a4 4 0 0 0 7-3l-2-4"/><path d="M12 8c-2 0-4 1-4 3v4"/></svg>',
  // mouse-pointer click / connect
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11.5V5a1.5 1.5 0 0 1 3 0v5.5"/><path d="M12 11.5V4a1.5 1.5 0 0 1 3 0v8"/><path d="M15 12.5V7a1.5 1.5 0 0 1 3 0v9a7 7 0 0 1-7 7h-1a7 7 0 0 1-6-3.3L3 14.5a1.6 1.6 0 0 1 2.5-2L7 14"/></svg>',
  // sliders / customisation
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h10M18 8h2M4 16h2M10 16h10"/><circle cx="16" cy="8" r="2"/><circle cx="8" cy="16" r="2"/></svg>',
];

/**
 * Mount the overlay into `host` (the shell root). Re-evaluates visibility
 * on every state emit and on hash changes.
 */
export function initOnboarding(host: HTMLElement): void {
  const overlay = document.createElement('div');
  overlay.className = 'onboard-overlay';
  overlay.hidden = true;

  const card = document.createElement('div');
  card.className = 'onboard-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');

  const title = document.createElement('h2');
  title.className = 'onboard-title';
  card.append(title);

  const sub = document.createElement('p');
  sub.className = 'onboard-sub';
  card.append(sub);

  const list = document.createElement('ol');
  list.className = 'onboard-steps';
  const stepEls: { icon: HTMLElement; text: HTMLElement }[] = [];
  for (let i = 0; i < 3; i++) {
    const li = document.createElement('li');
    const icon = document.createElement('span');
    icon.className = 'onboard-icon';
    icon.innerHTML = ICONS[i]!;
    const text = document.createElement('span');
    li.append(icon, text);
    list.append(li);
    stepEls.push({ icon, text });
  }
  card.append(list);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'onboard-dismiss';
  card.append(dismiss);

  overlay.append(card);
  host.append(overlay);

  const dismissIt = (): void => {
    markOnboarded();
    overlay.hidden = true;
  };
  dismiss.addEventListener('click', dismissIt);

  const sync = (): void => {
    const shouldShow =
      !isOnboarded() && !app.connected && !app.busy && isHomeRoute();
    overlay.hidden = !shouldShow;
  };

  const unsubState = subscribe(sync);
  window.addEventListener('hashchange', sync);

  // Localize + rebuild text on language change.
  const renderText = (): void => {
    title.textContent = t('onboard.title');
    sub.textContent = t('onboard.sub');
    for (let i = 0; i < 3; i++) {
      stepEls[i]!.text.textContent = t(`onboard.step${i + 1}`);
    }
    dismiss.textContent = t('onboard.dismiss');
  };
  renderText();

  // Auto-dismiss after the first successful connect.
  const checkConnected = (): void => {
    if (app.connected && app.snapshot && !isOnboarded()) {
      markOnboarded();
      overlay.hidden = true;
    }
  };
  subscribe(checkConnected);
  window.addEventListener('hashchange', checkConnected);

  // Language changes: keep the flag module self-contained by re-rendering
  // text on every emit too (cheap).
  subscribe(renderText);

  sync();
}
