/**
 * English string bundle — the reference locale. Every key in `vi.ts`
 * must exist here; `t()` falls back to this bundle for missing keys.
 *
 * Keys are dot-namespaced by surface: `nav.*`, `shell.*`, `phase.*`,
 * `onboard.*`, `confirm.*`, `status.*`, `dash.*`, `common.*`.
 */

export const en = {
  // ── Navigation ────────────────────────────────────────────────────
  'nav.home': 'Home',
  'nav.lighting': 'Lighting',
  'nav.keys': 'Keys',
  'nav.macros': 'Macros',
  'nav.device': 'Device',
  'nav.performance': 'Performance',
  // Routes reachable but not in the primary nav.
  'nav.advanced': 'Advanced',
  'nav.music': 'Music',
  'nav.diagnostics': 'Diagnostics',
  'nav.assistant': 'Assistant',

  // ── Shell chrome ──────────────────────────────────────────────────
  'app.name': 'oh-my-gravastar',
  'app.tagline': 'GravaStar keyboard setup',
  'shell.connect': 'Connect',
  'shell.connectKeyboard': 'Connect keyboard',
  'shell.noWebHid':
    'This browser cannot talk to keyboards — use Chrome or Edge on a computer.',
  'shell.disconnect': 'Disconnect',
  'shell.refresh': 'Refresh',
  'shell.collapse': 'Collapse sidebar',
  'shell.expand': 'Expand sidebar',
  'shell.menu': 'Menu',
  'shell.noDevice': 'No device',
  'shell.connectedDevice': 'Connected device',
  'shell.battery': 'Battery',
  'shell.musicBanner':
    'Music mode is active — the keyboard lights follow your microphone. ' +
    'Press Stop on the Music page to restore your lighting.',
  'shell.editBanner.text':
    'Connected — read only. The keyboard is live for viewing; ' +
    'changes stay off until you approve this session.',
  'shell.editBanner.button': 'Enable editing',
  'shell.langLabel': 'Language',

  // ── Connection phases (core/conn-state.ts) ─────────────────────────
  'phase.disconnected': 'Not connected',
  'phase.picker-open': 'Choose a keyboard…',
  'phase.connecting': 'Connecting…',
  'phase.connected-read-only': 'Connected — read only',
  'phase.editing-enabled': 'Editing enabled',
  'phase.reconnect-read-only': 'Reconnected — read only',
  'phase.device-busy-runtime': 'Music mode active',
  'phase.disconnected-mid-op': 'Disconnected during a change',
  'phase.write-uncertain': 'Change result unknown — refresh first',
  'phase.unsupported': 'Unsupported device',
  'phase.hint.disconnected': 'Plug in the keyboard and press Connect.',
  'phase.hint.picker-open': 'Pick your keyboard in the browser window.',
  'phase.hint.connecting': 'Opening the keyboard and reading its settings…',
  'phase.hint.connected-read-only': 'You can look around; changes need editing enabled.',
  'phase.hint.editing-enabled': 'Changes you approve are written and verified.',
  'phase.hint.reconnect-read-only':
    'The keyboard reconnected on its own — press "Enable editing" to allow changes.',
  'phase.hint.device-busy-runtime': 'Stop music mode before making other changes.',
  'phase.hint.disconnected-mid-op':
    'The keyboard disconnected during a change — reconnect and refresh before trying again.',
  'phase.hint.write-uncertain':
    'A change may or may not have landed — refresh the keyboard before retrying.',
  'phase.hint.unsupported': 'This device is not one this app can configure.',

  // ── First-run / onboarding ────────────────────────────────────────
  'onboard.title': 'Set up your GravaStar keyboard',
  'onboard.intro':
    'This app talks to your keyboard directly through your browser — ' +
    'no drivers, no accounts, nothing leaves your computer.',
  'onboard.reqTitle': 'Before you start',
  'onboard.req1': 'Use Chrome or Edge on a Windows, Mac or Linux computer.',
  'onboard.req2': 'Plug the keyboard in with its USB cable.',
  'onboard.req3': 'Keep the keyboard close enough to reach the USB port.',
  'onboard.stepConnect': 'Press Connect and pick your keyboard in the browser window.',
  'onboard.stepIdentify': 'We identify it by name and show what it can do.',
  'onboard.stepSafe': 'Every change asks for your approval first — nothing is written silently.',
  'onboard.cta': 'Connect keyboard',
  'onboard.busy': 'Working…',

  // ── Confirmation surface (modal.ts WriteImpact) ───────────────────
  'confirm.impact.title': 'What will change',
  'confirm.impact.affected': 'Affected',
  'confirm.impact.persistent': 'Saved on the keyboard',
  'confirm.impact.backup': 'Backup',
  'confirm.impact.rollback': 'Undo coverage',
  'confirm.impact.restart': 'Restart / disconnect',
  'confirm.impact.persistentYes': 'Yes — the change is stored on the keyboard.',
  'confirm.impact.persistentNo': 'No — this only affects this browser session.',
  'confirm.impact.backupYes': 'A backup of the current settings was captured first.',
  'confirm.impact.backupNo': 'No backup was captured before this change.',
  'confirm.impact.rollbackYes': 'You can restore the previous settings from Backup & restore.',
  'confirm.impact.rollbackPartial': 'Only part of this change can be rolled back automatically.',
  'confirm.impact.rollbackNo': 'This change cannot be undone automatically.',
  'confirm.impact.restartNone': 'The keyboard keeps running — no restart expected.',
  'confirm.impact.restartWarn': 'The keyboard may restart or briefly disconnect.',

  // ── Status vocabulary (ui/status.ts) ──────────────────────────────
  'status.verified': 'Verified',
  'status.applied-unverified': 'Applied — not verified',
  'status.partial': 'Partially applied',
  'status.unsupported': 'Not supported',
  'status.unverified': 'Unverified',
  'status.failed': 'Failed',
  'status.pending': 'Pending',

  // ── Dashboard / Home ──────────────────────────────────────────────
  'dash.title': 'Home',
  'dash.noDevice': 'No keyboard connected.',
  'dash.noDeviceHint':
    'Plug in your GravaStar keyboard with a USB cable, then press Connect. ' +
    'This page shows what your keyboard can do, its current settings and ' +
    'quick shortcuts once connected.',
  'dash.device': 'Device',
  'dash.model': 'Model',
  'dash.firmware': 'Firmware',
  'dash.battery': 'Battery',
  'dash.protocol': 'Protocol',
  'dash.linkState': 'Link state',
  'dash.linkReconnected': 'Reconnected — changes blocked',
  'dash.linkConnected': 'Connected',
  'dash.profile': 'Current profile',
  'dash.lighting': 'Lighting',
  'dash.speed': 'Speed',
  'dash.brightness': 'Brightness',
  'dash.sleepTimer': 'Sleep timer',
  'dash.keyLayer': 'Key layer',
  'dash.savedProfile': 'Saved profile',
  'dash.profileHint1':
    'Unsaved edits live inside each editor (Keys, Lighting, Macro) and ' +
    'are not tracked here — open a section to see its dirty state.',
  'dash.profileHint2':
    'Named game/app profiles can be applied manually on the Backup & ' +
    'restore page — automatic per-app switching is not possible from ' +
    'a browser page.',
  'dash.quickActions': 'Quick actions',
  'dash.action.lighting': 'Lighting',
  'dash.action.lightingBlurb': 'Effects, colours, scenes',
  'dash.action.keys': 'Keys',
  'dash.action.keysBlurb': 'Key assignments & layers',
  'dash.action.macro': 'Macros',
  'dash.action.macroBlurb': 'Macros & timing',
  'dash.action.advanced': 'Advanced',
  'dash.action.advancedBlurb': 'SOCD / timers / toggles',
  'dash.action.music': 'Music',
  'dash.action.musicBlurb': 'Mic-reactive lighting',
  'dash.action.device': 'Device',
  'dash.action.deviceBlurb': 'Details, backup & restore',
  'dash.action.assistant': 'Ask AI',
  'dash.action.assistantBlurb': 'Describe what you want',
  'dash.action.backup': 'Back up settings',
  'dash.action.backupBlurb': 'Save a restore point',
  'dash.health': 'Device health',
  'dash.featuresAvailable': 'Features available',
  'dash.notSupported': 'Not supported',
  'dash.unverified': 'Unverified',
  'dash.noWarnings': 'No warnings — everything reported is verified or expected.',
  'dash.readOnlyWarning':
    'This session started read-only — press "Enable editing" in the banner ' +
    'to allow changes.',
  'dash.fnWarning': 'Fn layer check',
  'dash.recentChanges': 'Recent changes',
  'dash.noChanges': 'No changes recorded yet this session.',
  'dash.capabilities': 'What your keyboard can do',
  'dash.capabilitiesHint':
    'Only features this device supports are shown as usable; unavailable ' +
    'ones explain why.',
  'dash.backupNudge':
    'Tip: take a backup before your first change — it takes a few seconds ' +
    'on the Backup & restore page.',
  'dash.backupNudgeLink': 'Open Backup & restore',

  // ── Common actions ────────────────────────────────────────────────
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.close': 'Close',
  'common.ok': 'OK',
  'common.save': 'Save',
  'common.delete': 'Delete',
  'common.back': 'Back',
} as const;

export type StringKey = keyof typeof en;
export type Strings = Record<StringKey, string>;
