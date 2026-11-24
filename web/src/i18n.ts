/**
 * Tiny i18n for the oh-my-gravastar web UI.
 *
 * Locales: 'en' (default/fallback) and 'vi' (the primary user base is
 * Vietnamese non-technical users). The active locale persists in
 * localStorage ('omg-lang'); on first visit it is auto-detected from
 * navigator.language (vi* → vi, anything else → en).
 *
 * `t(key, vars?)` never returns undefined/blank: a missing key in the
 * active locale falls back to English, and a key missing everywhere
 * returns the key itself so the UI stays debuggable.
 *
 * `vars` substitutes `{name}` placeholders, e.g. t('x', {n: 3}).
 */

export type Locale = 'en' | 'vi';

const STORAGE_KEY = 'omg-lang';

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'vi') return saved;
  } catch {
    /* storage unavailable (private mode etc.) */
  }
  const nav = (navigator.language || '').toLowerCase();
  return nav.startsWith('vi') ? 'vi' : 'en';
}

let current: Locale = detectLocale();

const listeners = new Set<() => void>();

export function getLang(): Locale {
  return current;
}

/** Bumped on every language change so stateful views can rebuild. */
let epoch = 0;

export function langEpoch(): number {
  return epoch;
}

export function setLang(l: Locale): void {
  if (l === current) return;
  current = l;
  epoch++;
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    /* ignore */
  }
  if (typeof document !== 'undefined') document.documentElement.lang = l;
  for (const fn of listeners) fn();
}

/** Re-render hook — shell calls this to refresh chrome + pages. */
export function onLangChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── Dictionary ─────────────────────────────────────────────────────────
// Keep keys grouped by file/feature. `{name}` = interpolation slot.

const en: Record<string, string> = {
  // ── i18n / shell ──
  'shell.noDevice': 'No device',
  'shell.menu': 'Menu',
  'shell.collapse': 'Collapse sidebar',
  'shell.expand': 'Expand sidebar',
  'shell.brandSub': 'GravaStar keyboard setup',
  'shell.connect': 'Connect',
  'shell.disconnect': 'Disconnect',
  'shell.refresh': 'Refresh',
  'shell.connectedDevice': 'Connected device',
  'shell.connected': 'Connected',
  'shell.keyboard': 'Keyboard',
  'shell.langLabel': 'Language',
  'shell.docTitle': 'GravaStar Keyboard Setup',

  // ── common ──
  'common.battery': 'Battery {pct}%',
  'common.batteryLabel': 'Battery',
  'common.firmware': 'Firmware {v}',
  'common.unknownModel': 'Unknown model',
  'common.none': 'None',
  'common.empty': '(empty)',
  'common.noneShort': '(none)',
  'common.unnamed': '(unnamed)',
  'common.unknown': 'unknown',
  'common.bytes': '{n} bytes',
  'common.cancel': 'Cancel',
  'common.copy': 'Copy',
  'common.comingSoon': 'Coming soon — read-only preview.',
  'common.connectFirst': 'Connect a keyboard first (top-right → Connect).',
  'common.technicalDetails': 'Technical details',
  'common.layer': 'Layer {n}',
  'common.layerShort': 'Layer',
  'common.steps': '{n} step(s)',
  'common.savedAndChecked': 'saved and checked',
  'common.savedUnchecked': 'sent but not confirmed',
  'common.unconfirmed': 'sent, not confirmed',
  'common.key': 'Key',
  'common.keySlot': 'Key slot',
  'common.keySlotN': 'key #{i}',
  'common.keyboard': 'keyboard',
  'common.unsaved': '{n} unsaved',

  // ── page titles (sidebar nav) ──
  'page.home.title': 'Home',
  'page.lighting.title': 'Lighting',
  'page.keys.title': 'Keys',
  'page.macro.title': 'Macro',
  'page.advanced.title': 'Advanced',
  'page.device.title': 'Device',
  'page.basic.title': 'Layout',
  'page.config.title': 'Backup',
  'page.rhythm.title': 'Music',
  'page.setting.title': 'Settings',

  // ── state.ts status line ──
  'status.gettingReady': 'Getting ready…',
  'status.chooseKeyboard': 'Choose your keyboard in the browser popup…',
  'status.noKeyboardSelected': 'No keyboard selected.',
  'status.connecting': 'Connecting…',
  'status.couldNotConnect': 'Could not connect: {msg}',
  'status.disconnected': 'Disconnected.',
  'status.readingKeyboard': 'Reading your keyboard…',
  'status.reconnecting': 'Connection hiccup — reconnecting…',
  'status.lostConnection': 'Lost the connection ({reason}) — please press Connect again.',
  'status.couldNotRead': 'Could not read the keyboard: {msg}',
  'status.ready': 'Ready — {name} connected. Pick an option on the left.',
  'status.reconnectingKb': 'Reconnecting keyboard…',
  'status.prevDeviceMissing': 'Previously authorised device not found — use Connect.',
  'status.noWebHid':
    'This browser cannot talk to keyboards. Please use Chrome or Edge on a computer.',
  'status.welcomeBack': 'Welcome back! Press Connect to pick your keyboard.',
  'status.plugAndConnect':
    'Ready. Plug in your GravaStar keyboard with a USB cable, then press Connect.',
  'status.couldNotReadKeymap': 'Could not read the keymap: {msg}',

  // ── home page (pages.ts) ──
  'home.title': 'Set up your GravaStar keyboard',
  'home.note':
    'Change key colours and effects, remap keys, record macros — all from ' +
    'your browser. Nothing is installed and nothing leaves your computer.',
  'home.connectBtn': 'Connect keyboard',
  'home.step1': 'Plug the keyboard into your computer with a USB cable.',
  'home.step2': 'Press "Connect keyboard" and pick it in the browser popup.',
  'home.step3': 'Pick what to change on the left — colours, keys, macros.',
  'home.needs':
    'Works in Chrome or Edge on a computer (not phones or Firefox). ' +
    'Supported: GravaStar K1 / K1 Pro / K98 series over USB cable.',
  'home.welcomeBack': 'Welcome back, {name}',
  'home.savedNote':
    'Everything you change is saved to the keyboard itself — it keeps ' +
    'working the same when you unplug it.',
  'home.linkColors': 'Colours & effects',
  'home.linkKeys': 'Remap keys',
  'home.linkMacros': 'Macros',

  // ── keys page misc (pages.ts / remap.ts shared) ──
  'keys.modelUnknown': 'Model unknown — showing the K1 Pro reference layout.',
  'keys.layoutNotPorted':
    'Layout table for {model} is not ported yet — showing the K1 Pro reference layout.',

  // ── device page ──
  'device.connectBlurb':
    'Connect your keyboard to see its model, firmware version and battery level.',
  'device.about': 'About your keyboard',
  'device.model': 'Model',
  'device.screen': 'Screen',
  'device.none': 'None',
  'device.rawData': 'Raw device data',
  'device.modelId': 'Model id',
  'device.deviceUuid': 'Device UUID',
  'device.profileData': 'Profile data',
  'device.lightMode': 'Light mode',
  'device.sleepTime': 'Sleep time',
  'device.lightData': 'Light data',
  'device.macroData': 'Macro data',
  'device.customColours': 'Custom light colours',
  'device.slotTitle': 'Slot {i} — rgb({r},{g},{b})',
  'device.keyAssignments': 'Key assignments — layer {n} (raw)',
  'device.allSlots': 'All 128 key slots, in order.',
  'device.slotTip': 'Slot {i} — 0x{hex}',
  'device.snapshotJson': 'Snapshot JSON',
  'device.snapshotJsonHint': 'Everything readable today, as one JSON document.',

  // ── basic page (pages-secondary.ts) ──
  'basic.title': 'Keyboard layout',
  'basic.disconnectedBlurb':
    'Shows the physical layout of the connected keyboard — which keys ' +
    'exist and where they sit.',
  'basic.keysCount': '{n} physical keys',
  'basic.kvKeys': 'Keys',
  'basic.kvKeySize': 'Key size',
  'basic.kvLivePreview': 'Live preview',
  'basic.keySize': 'standard 1u keys (the size used by most keyboards)',
  'basic.layoutTable': 'Layout table',
  'basic.layoutMatched': 'matched to this keyboard model',
  'basic.layoutGeneric':
    'generic reference layout — a table for this model is not available yet',
  'basic.livePreview': 'the Keys page shows this layout with live key labels and lighting',
  'basic.hint':
    'The vendor app lets you draw custom keycap shapes and spacing, but it ' +
    'only saves them in the browser — it never sends them to the keyboard. ' +
    'This page shows the fixed layout the keyboard actually uses.',
  'basic.editKeyShape': 'Edit key shape',
  'basic.editKeyShapeWhy':
    'The vendor app only stores this in the browser, not on the keyboard',
  'basic.hiddenKeys': 'Hidden keys',
  'basic.hiddenKeysWhy': 'Layout details are browser-side only in the vendor app',
  'basic.baseSize': 'Base size / gaps',
  'basic.baseSizeWhy':
    'Layout editing is browser-side only — nothing to send to the keyboard',

  // ── config (backup) page ──
  'config.title': 'Backup & restore',
  'config.disconnectedBlurb':
    'Save everything stored on the keyboard to a file, or restore a ' +
    'previously saved file.',
  'config.exportTitle': 'Save a backup',
  'config.exportHint':
    'Downloads a JSON file containing everything currently stored on the ' +
    'keyboard — key assignments, lighting, macros and device info. ' +
    'Use it to restore later or to move settings between keyboards.',
  'config.downloadBtn': 'Download backup file',
  'config.reading': 'Reading device…',
  'config.downloaded': 'Backup file downloaded.',
  'config.exportFailed': 'Could not create the backup: {msg}',
  'config.importTitle': 'Restore from backup',
  'config.importHint':
    'Pick a backup file made by this page (or the omg CLI). The page shows ' +
    'exactly what will change before anything is written; each part is ' +
    'checked on the keyboard afterwards.',
  'config.fileBad': 'That file cannot be used: {msg}',
  'config.fileUnreadable': 'Could not read that file: {msg}',
  'config.fileLine': 'File: {name} — model "{model}"',
  'config.noWritable': 'No writable sections found in this file.',
  'config.writeBtn': 'Write to keyboard',
  'config.writeBtnConfirm': 'Yes — write {n} section(s) to the keyboard',
  'config.writeWarn':
    'This writes to the keyboard and checks each part afterwards.',
  'config.allSaved': 'All sections saved.',
  'config.failed': 'FAILED: {msg}',
  'config.skippedPrefix': 'skipped — {what}',
  'config.keymapSection': 'Key assignments',
  'config.keymapSummary': '{n} key layer(s)',
  'config.keymapSaved': 'layer {n}',
  'config.colorsSection': 'Per-key colours',
  'config.colorsSummary': '{n} key colour(s) from the file',
  'config.colorsSaved': 'saved and checked',
  'config.lightSection': 'Lighting effects',
  'config.lightSummary': '{n} bytes of effect data',
  'config.macroSection': 'Macros',
  'config.macroSummary': '{n} bytes of macro data',
  'config.saved': 'saved',
  'config.savedList': 'saved ({list})',
  'config.savedChecked': 'saved and checked',
  'config.layerUnreadable': 'key assignments (layer {n}): unreadable data',
  'config.layerUnreadableVals': 'key assignments (layer {n}): unreadable values',
  'config.pending': 'not supported in this build yet',
  'config.pendingLayers': 'key assignments ({n} layer(s)): {why}',
  'config.pendingColors': 'per-key colours ({n} key(s)): {why}',
  'config.pendingLight': 'lighting effects ({n} bytes): {why}',
  'config.pendingMacro': 'macros ({n} bytes): {why}',
  'config.skipColorsBad': 'per-key colours: unreadable data in the file',
  'config.skipLightBad': 'lighting effects: unreadable data in the file',
  'config.skipMacroBad': 'macros: unreadable data in the file',
  'config.skipProfile':
    'raw device profile (sleep time, light mode): not applied — change those ' +
    'on the Settings and Lighting pages instead',
  // import errors
  'config.errNotProfile': 'This file is not a supported omg profile backup.',
  'config.errNotBackup': 'This does not look like an omg profile backup file.',
  'config.errNoKhub': 'This backup does not contain a khub916 keyboard.',
  'config.errNoSettings': 'This backup has no keyboard settings to import.',
  'config.errConnectFirst': 'Connect a keyboard first.',

  // ── rhythm page ──
  'rhythm.title': 'Music-reactive lighting',
  'rhythm.blurb':
    'The vendor app can make the keyboard lights react to music, but it ' +
    'needs their Windows companion program — a web page cannot do that part.',
  'rhythm.fact1': 'Keyboard-side lighting is fully available today — see the Lighting page.',
  'rhythm.fact2': 'Live per-key colours are visible on the Keys page.',

  // ── setting page ──
  'setting.title': 'Settings',
  'setting.disconnectedBlurb': 'Device settings that can be changed safely from the browser.',
  'setting.sleepTitle': 'Sleep timer',
  'setting.sleepCurrent': 'Current',
  'setting.sleepSeconds': '{n} seconds',
  'setting.sleepWhat': 'What it does',
  'setting.sleepWhatText': 'how long the keyboard stays awake before sleeping',
  'setting.sleepNote': 'Note',
  'setting.sleepNoteText':
    'The vendor app only shows this for wireless keyboards and warns it may ' +
    'have no effect when plugged in — your mileage may vary.',
  'setting.secondsPlaceholder': 'seconds',
  'setting.setSleep': 'Set sleep time',
  'setting.confirmSleep': 'Yes — save to keyboard',
  'setting.badSeconds': 'Enter a whole number of seconds between 0 and 255.',
  'setting.sleepPending': 'Saving sleep time is {why}.',
  'setting.sleepSaved': 'Sleep time set to {n} seconds — checked on the keyboard.',
  'setting.sleepSent': 'Sleep time set to {n} seconds — sent but not confirmed.',
  'setting.sleepFailed': 'Could not save the sleep time: {msg}',
  'setting.otherTitle': 'Other settings available elsewhere',
  'setting.factLight': 'Lighting effects, speed and brightness — see the Lighting page.',
  'setting.factDevice': 'Connection details, firmware version and battery — see the Device page.',
  'setting.factKeys': 'Key assignments, macros and advanced keys — see the Keys, Macro and Advanced pages.',
  'setting.factSafety':
    'Factory reset and firmware updates are deliberately not offered here for safety.',

  // ── lighting page ──
  'light.connectBlurb':
    'Connect a keyboard to configure lighting — effect modes, speed/' +
    'brightness, colours and per-key custom colours.',
  'light.currentEffect': 'Current effect',
  'light.chooseEffect': 'Choose an effect',
  'light.chooseHint': 'Tap an effect to preview it on the keyboard above.',
  'light.hue': 'Hue',
  'light.speed': 'Speed',
  'light.brightness': 'Brightness',
  'light.colour': 'Colour',
  'light.oneColour': 'One colour',
  'light.mixedColours': 'Mixed colours',
  'light.colours': 'Colours',
  'light.coloursHint': 'Quick fills for the "custom" effect, or pick any colour by hand.',
  'light.presetSolid': 'Solid',
  'light.presetSolidHint': 'One colour everywhere',
  'light.presetGradient': 'Gradient',
  'light.presetGradientHint': 'Blend between two colours',
  'light.presetRainbow': 'Rainbow',
  'light.presetRainbowHint': 'Every colour of the wheel',
  'light.from': 'From',
  'light.to': 'To',
  'light.applyFill': 'Apply fill',
  'light.resetToKeyboard': 'Reset to keyboard',
  'light.editing': 'Editing',
  'light.effectColour': 'Effect colour',
  'light.keyN': 'Key #{n}',
  'light.perKeyTitle': 'Individual key colours ({n} keys)',
  'light.perKeyHint':
    'Fine-tune the colour of each key. Click a key on the keyboard or a ' +
    'cell below to choose which one the colour picker edits.',
  'light.saveTitle': 'Save to keyboard',
  'light.saveChanges': 'Save changes',
  'light.undoChanges': 'Undo changes',
  'light.advancedJson': 'Advanced: config JSON',
  'light.copied': 'Config JSON copied.',
  'light.kvEffect': 'Effect',
  'light.kvColourStyle': 'Colour style',
  'light.kvAccent': 'Accent colour',
  'light.kvPerKey': 'Per-key colours set',
  'light.perKeyCount': '{n} of {total}',
  'light.kvUnreadable': '— (could not read from keyboard)',
  'light.effectUnknown': 'Effect {n} (unknown)',
  'light.modeNotInTable': 'Current effect {n} (not in table)',
  'light.effectNoAccent':
    'This effect ({name}) does not use a single accent colour.',
  'light.fillFailed': 'Could not apply that fill: {msg}',
  'light.saveTitleQ': 'Save these lighting changes?',
  'light.saveHint':
    'This writes the new effect, colours and speed to the keyboard and ' +
    'checks each step was saved correctly. The keyboard may blink while ' +
    'it updates.',
  'light.exactSettings': 'Exact settings that will be sent:',
  'light.apply': 'Apply',
  'light.stepReading': 'Reading current device state…',
  'light.stepColorsOk': 'Per-key colours: saved and checked',
  'light.stepColorsSkip': 'Per-key colours: skipped (unchanged)',
  'light.stepFxOk': 'Effect settings: saved and checked',
  'light.stepFxSkip': 'Effect settings: skipped (unchanged)',
  'light.stepAccentOk': 'Accent colour: saved and checked',
  'light.stepAccentSkip': 'Accent colour: skipped',
  'light.failedSuffix': 'FAILED — {msg}',
  'light.partialFail': 'Some lighting changes failed — see the steps above.',
  'light.saved': 'Lighting saved to the keyboard.',
  'light.saveFailed': 'Saving failed: {msg}',
  'light.badProfile': 'profile too short to decode light state',
  'light.badRange': 'speed/brightness must be ≤ 20',

  // ── macro page ──
  'macro.title': 'Macro',
  'macro.connectBlurb': 'Connect a keyboard to manage its saved macros.',
  'macro.count': 'Macros ({n})',
  'macro.storageHint':
    'About {free} of {total} bytes of macro storage is free. ' +
    'Saving writes the whole list to the keyboard and checks it was stored correctly.',
  'macro.empty': 'No macros stored on the device yet.',
  'macro.colName': 'Name',
  'macro.colSteps': 'Steps',
  'macro.editing': 'Editing',
  'macro.edit': 'Edit',
  'macro.delete': 'Delete',
  'macro.new': '+ New macro',
  'macro.newStep': '+ Add step',
  'macro.editor': 'Macro editor',
  'macro.editorEmpty':
    'Select a macro above, or create a new one, to edit its steps.',
  'macro.newN': 'New macro #{n}',
  'macro.editingN': 'Editing macro #{n}',
  'macro.editorHint':
    'each step is a key press or release with a delay in milliseconds ' +
    '(up to {max}). ' +
    'Changes are only sent to the keyboard when you save.',
  'macro.name': 'Name',
  'macro.colAction': 'Action',
  'macro.colKind': 'Kind',
  'macro.colDelay': 'Delay (ms)',
  'macro.press': 'Press',
  'macro.release': 'Release',
  'macro.unknownKey': 'Unknown key (code {u})',
  'macro.kindKey': 'Key',
  'macro.kindModifier': 'Modifier',
  'macro.kindMouse': 'Mouse',
  'macro.kindOther': 'Other (advanced)',
  'macro.badDelay':
    'Delay must be a whole number of milliseconds between 0 and {max}',
  'macro.moveUp': 'Move step up',
  'macro.moveDown': 'Move step down',
  'macro.removeStep': 'Remove step',
  'macro.importJson': 'Import steps JSON…',
  'macro.importPrompt':
    'Paste steps JSON — a [{"action":"down","key":"KeyA","delay_ms":8}, …] array ' +
    'or {"name":"…","steps":[…]} (docs/macro-schema.md):',
  'macro.imported': 'Imported {n} step(s) — press Save to send them to the keyboard.',
  'macro.importFailed': 'That JSON was not understood: {msg}',
  'macro.saveBtn': 'Save macro to keyboard',
  'macro.saveBtnClean': 'Save macro (no changes)',
  'macro.saveHint': 'Saves all macros to the keyboard',
  'macro.discard': 'Discard edits',
  'macro.bindTitle': 'Bind to a key',
  'macro.bindHint':
    'Assigns a saved macro to one key on a chosen layer. ' +
    'The macro must be saved on the keyboard first.',
  'macro.bindEmpty': 'No macros stored — save one first.',
  'macro.unnamedEntry': '(unnamed)',
  'macro.stepsCount': '{n} steps',
  'macro.layer': 'Layer',
  'macro.advanced': 'Advanced',
  'macro.macroSel': 'Macro',
  'macro.macroType': 'Macro type',
  'macro.loopCount': 'Loop count',
  'macro.assign': 'Assign macro to key',
  'macro.clearKey': 'Clear this key',
  'macro.slotHint':
    'Key slots are numbered 0–127; pick the slot for the key you want to change.',
  'macro.needsStep':
    'A macro needs at least one step. To remove a macro, use Delete instead.',
  'macro.noSpace':
    "Not enough macro storage: '{name}' needs about {need} bytes but only about {free} are free — delete unused macros first.",
  'macro.prepareFailed': 'Could not prepare the macro data: {msg}',
  'macro.createDesc': 'Create new macro "{name}" with {n} step(s)',
  'macro.replaceDesc': 'Replace macro "{old}" with "{name}" ({n} step(s))',
  'macro.saveAllQ': 'Save all macros to the keyboard?',
  'macro.savedOk': '{desc} — saved and checked on the keyboard.',
  'macro.saveFailed': 'Could not save the macro: {msg}',
  'macro.deleteQ':
    'Delete macro "{name}" ({n} step(s))?\n\n' +
    'This removes it from the keyboard. Keys already assigned to it will stop working.',
  'macro.deleted': 'Deleted macro "{name}" — saved and checked on the keyboard.',
  'macro.deleteFailed': 'Could not delete the macro: {msg}',
  'macro.badSlot': 'Key slot must be an integer 0..{max}',
  'macro.badType': 'Macro type must be an integer 1..255',
  'macro.badLoop': 'Loop count must be an integer ≥ 1',
  'macro.clearDesc': 'Clear key slot {slot} on layer {layer} (currently {before})',
  'macro.assignDesc':
    'Assign macro[{i}] to key slot {slot} on layer {layer} (currently {before})',
  'macro.saveChangeQ': 'Save this change to the keyboard?',
  'macro.slotRange':
    'key slot {slot} is out of range — the keymap only has {n} entries',
  'macro.slotCleared': 'Key slot {slot} cleared — checked on the keyboard.',
  'macro.slotRuns': 'Key slot {slot} now runs macro "{name}" — checked on the keyboard.',
  'macro.keySaveFailed': 'Could not save the key change: {msg}',

  // ── advanced keys page ──
  'adv.title': 'Advanced keys',
  'adv.connectBlurb':
    'Connect a keyboard to manage advanced keys — SOCD, mod-tap and toggle functions.',
  'adv.reading': 'Reading adv-key state…',
  'adv.unavailable': 'Adv-key state unavailable — press Refresh.',
  'adv.cardTitle': 'Advanced keys — SOCD / MT / TGL',
  'adv.chipCounts': '{label}: {hist} history · {bound} bound',
  'adv.hint':
    'SOCD makes two opposing keys share one output, mod-tap (MT) gives a key ' +
    'two actions depending on how long you hold it, and toggle (TGL) makes ' +
    'a key switch another key on or off with each press. There is no delete ' +
    "on the device — \"Unbind\" clears the key's assignment but keeps its " +
    'stored settings.',
  'adv.techHint':
    'History blob: {n} B — SOCD/MT slots are 8 B, TGL slots 4 B. ' +
    'Bindings live in the layer-0 keymap as 0x20/0x21/0x22 values.',
  'adv.unconfirmedWarn':
    'The last settings write was sent but the keyboard did not confirm it. ' +
    'On K1 Pro firmware this particular save does not always stick — ' +
    'press Refresh in a minute to check, or try again.',
  'adv.kindTitle': '{kind} advanced keys',
  'adv.noneBound': 'No keys use this kind of advanced function yet.',
  'adv.colSlot': 'Key slot',
  'adv.colPos': 'Position',
  'adv.colSetting': 'Setting',
  'adv.colDetail': 'Detail',
  'adv.colSaved': 'Saved values',
  'adv.noSaved': '(no saved settings — stale assignment)',
  'adv.unbind': 'Unbind',
  'adv.unbindWhy':
    "Remove this key's advanced function. The saved settings stay stored on the keyboard.",
  'adv.savedOnKb': 'Saved settings on the keyboard:',
  'adv.colStored': 'Stored values',
  'adv.addHintMt':
    'Mod-tap: short press emits Tap, long press emits Hold after the threshold. ' +
    "The bind key's current value is replaced by the adv binding.",
  'adv.addHintSocd':
    'SOCD: two opposing keys share one output; the Direction picks the resolution mode. ' +
    "Both keys' current values are stored as the history entry.",
  'adv.addHintTgl':
    "Toggle: pressing the bind key toggles the output stored from the toggle slot's current value.",
  'adv.fKeyToChange': 'Key to change',
  'adv.fTap': 'Tap (short press)',
  'adv.fHold': 'Hold (long press)',
  'adv.fHoldTime': 'Hold time (×10 ms)',
  'adv.holdTimeWhy': 'How long you must hold the key before the Hold action fires',
  'adv.addMt': 'Add MT key',
  'adv.addSocd': 'Add SOCD pair',
  'adv.addTgl': 'Add TGL key',
  'adv.saveToKb': 'Saves the key binding and its settings to the keyboard',
  'adv.fKeyA': 'Key A (slot)',
  'adv.fKeyB': 'Key B (slot)',
  'adv.fDirection': 'Direction',
  'adv.fToggleTarget': 'Toggle target (slot)',
  'adv.socdLastWins': 'Last input wins',
  'adv.socdAPriority': 'Key A priority',
  'adv.socdBPriority': 'Key B priority',
  'adv.socdAllCancel': 'All cancel',
  'adv.dirLast': 'last-input priority',
  'adv.dirA': 'key A priority',
  'adv.dirB': 'key B priority',
  'adv.dirAll': 'all-cancel',
  'adv.involvesA': 'involves key A',
  'adv.involvesB': 'involves key B',
  'adv.holdAfter': 'hold after {ms} ms',
  'adv.toggle': 'toggle',
  'adv.customValue': '(custom value)',
  'adv.readFailed': 'Could not read advanced-key settings: {msg}',
  'adv.badHoldTime': 'Hold time must be a whole number between 0 and 100',
  'adv.mtFailed': 'Could not set up that mod-tap key: {msg}',
  'adv.socdFailed': 'Could not set up that SOCD pair: {msg}',
  'adv.tglFailed': 'Could not set up that toggle key: {msg}',
  'adv.mtDesc':
    'MT key[#{key}] ({old}): tap {tap}, hold {hold}, threshold {ms} ms',
  'adv.socdDesc': 'SOCD key[#{a}] + key[#{b}]: direction {dir}',
  'adv.tglDesc': 'TGL key[#{key}] toggles key[#{t}] ({v})',
  'adv.confirmWrite':
    '{desc}\n\n' +
    'This saves the change to the keyboard. Note: on some firmware the ' +
    'saved settings may not stick — the page will tell you honestly if ' +
    'that happens. Continue?',
  'adv.histSaved': 'settings saved and checked',
  'adv.histUnconfirmed':
    'settings sent but NOT confirmed (this firmware may not keep them — press Refresh in a minute to check)',
  'adv.savedOk': '{desc} — key binding saved; {hist}.',
  'adv.saveFailed': 'Could not save the advanced-key change: {msg}',
  'adv.unbindQ':
    'Remove the {kind} function from key slot #{i}?\n\n' +
    'The key currently runs {old}. Its saved settings stay stored on ' +
    'the keyboard (the device has no delete), but the key goes back to normal.',
  'adv.unbound': 'Removed the {kind} function from key slot #{i} — checked on the keyboard.',
  'adv.unbindFailed': 'Could not remove that function: {msg}',

  // ── remap (keys) page ──
  'keys.title': 'Keyboard',
  'keys.connectBlurb':
    'The keyboard visualizer and key remapping need a connected keyboard. ' +
    'Click a key, pick what it should do, then save.',
  'keys.poolTitle': 'Key pool',
  'keys.apply': 'Apply',
  'keys.discard': 'Discard',
  'keys.writing': 'Writing…',
  'keys.applyN': 'Apply ({n})',
  'keys.unassign': 'Unassign',
  'keys.unassignWhy': 'Make the selected key do nothing',
  'keys.saveThis': 'Save this key',
  'keys.searchPh': 'Search keys…',
  'keys.noMatch': 'No keys match the search.',
  'keys.pickPrompt': 'Click a key on the keyboard to pick a new function.',
  'keys.selInfo': '#{i} {name} — currently {cur}{pend}',
  'keys.willBecome': ', will become {v}',
  'keys.nothing': 'nothing',
  'keys.dupNote': 'Note: {label} is also assigned to {slots}.',
  'keys.confirmTitleAll': 'Save {n} key change(s) to layer {l}?',
  'keys.confirmTitleOne': 'Change {name} (#{i}) on layer {l}?',
  'keys.confirmWarn': 'This sends the change to the keyboard and checks it was saved.',
  'keys.saveAndCheck': 'Save & check',
  'keys.changeDesc': '#{i} {name}: {old} → {new}',
  'keys.savedN': 'Saved {n} key change(s) on layer {l} — checked on the keyboard.',
  'keys.saveFailed': 'Could not save the key changes: {msg}',
  'keys.poolBasic': 'Basic',
  'keys.poolSystem': 'System',
  'keys.poolMouse': 'Mouse',
  'keys.poolMedia': 'Media',
  'keys.poolEdit': 'Edit / Apps',

  // ── keyboard visualizer ──
  'kb.keyTitle': 'Key {n} — {label}',
  'kb.willBecome': '→ will become 0x{hex}',
  'kb.unsaved': '(unsaved)',

  // ── hid.ts errors ──
  'hid.interrupted':
    'the keyboard connection was interrupted ({reason}) — reconnect and try again',
  'hid.badReplySize': 'unexpected reply size from the keyboard ({n} bytes)',
  'hid.noAttempt': 'khub916: no attempt made',
  'hid.transferError': 'transfer error',
  'hid.attemptsFailed': 'command failed after {n} attempts: {msg}',
  'hid.shortResponse': 'khub916 short response: {n} bytes',
  'hid.echoMismatch':
    'khub916 echo mismatch: sent [{sent}] expected [{exp}]',
  'hid.writeInterrupted':
    'the keyboard connection was interrupted ({reason})',
  'hid.configWriteFailed': 'config write failed: {msg}',
  'hid.unexpectedKeymap': 'the keyboard returned an unexpected keymap size',
  'hid.keymapUnconfirmed': 'key change was not confirmed by the keyboard',
  'hid.macroBadSize': 'macro data has an invalid size ({n} bytes)',
  'hid.macroUnconfirmed': 'macro save was not confirmed by the keyboard',
  'hid.profileBadSize': 'device profile has an invalid size ({n} bytes)',
  'hid.profileUnconfirmed': 'settings save was not confirmed by the keyboard',
  'hid.colorsCount':
    'per-key colour save needs exactly {need} colours, got {got}',
  'hid.colorsUnconfirmed': 'per-key colours were not confirmed by the keyboard',
  'hid.lightUnconfirmed': 'lighting settings were not confirmed by the keyboard',
  'hid.advBadSize': 'advanced-key data has an invalid size ({n} bytes)',
  'hid.kcBadSize': 'advanced-key read-back has an unexpected size ({n})',
  'hid.kcCount': 'advanced-key save needs 1..={max} values, got {n}',
  'hid.kcUnconfirmed': 'advanced-key save was not confirmed by the keyboard',
  'hid.noReply': 'no reply from the keyboard',
  'hid.noChannel': 'the keyboard did not answer on any known channel ({why})',
  'hid.channelErr': 'channel {id}: {msg}',
  'hid.channelSize': 'channel {id}: unexpected reply ({n} bytes)',
  'hid.notKeyboard': 'this does not look like a supported GravaStar keyboard',
  'hid.wirelessUnsupported':
    'wireless dongle connections are not supported yet — plug in with USB',
  'hid.timeout': 'khub916: no answer (timeout)',

  // ── onboarding ──
  'onboard.title': 'Welcome!',
  'onboard.sub': 'Three quick steps to get started:',
  'onboard.step1': 'Plug your GravaStar keyboard into the computer with a USB cable.',
  'onboard.step2': 'Press Connect and pick your keyboard in the popup.',
  'onboard.step3': 'Pick a feature on the left to start customising.',
  'onboard.dismiss': "Got it — let's go!",
};

const vi: Record<string, string> = {
  'shell.noDevice': 'Chưa kết nối',
  'shell.menu': 'Menu',
  'shell.collapse': 'Thu gọn thanh bên',
  'shell.expand': 'Mở rộng thanh bên',
  'shell.brandSub': 'Cài đặt bàn phím GravaStar',
  'shell.connect': 'Kết nối',
  'shell.disconnect': 'Ngắt kết nối',
  'shell.refresh': 'Làm mới',
  'shell.connectedDevice': 'Thiết bị đã kết nối',
  'shell.connected': 'Đã kết nối',
  'shell.keyboard': 'Bàn phím',
  'shell.langLabel': 'Ngôn ngữ',
  'shell.docTitle': 'Cài đặt bàn phím GravaStar',

  'common.battery': 'Pin {pct}%',
  'common.batteryLabel': 'Pin',
  'common.firmware': 'Firmware {v}',
  'common.unknownModel': 'Không rõ mẫu',
  'common.none': 'Không có',
  'common.empty': '(trống)',
  'common.noneShort': '(không)',
  'common.unnamed': '(chưa đặt tên)',
  'common.unknown': 'không rõ',
  'common.bytes': '{n} byte',
  'common.cancel': 'Huỷ',
  'common.copy': 'Sao chép',
  'common.comingSoon': 'Sắp ra mắt — bản xem trước chỉ đọc.',
  'common.connectFirst': 'Hãy kết nối bàn phím trước (góc trên bên phải → Kết nối).',
  'common.technicalDetails': 'Chi tiết kỹ thuật',
  'common.layer': 'Lớp {n}',
  'common.layerShort': 'Lớp',
  'common.steps': '{n} bước',
  'common.savedAndChecked': 'đã lưu và kiểm tra',
  'common.savedUnchecked': 'đã gửi nhưng chưa xác nhận',
  'common.unconfirmed': 'đã gửi, chưa xác nhận',
  'common.key': 'Phím',
  'common.keySlot': 'Ô phím',
  'common.keySlotN': 'phím #{i}',
  'common.keyboard': 'bàn phím',
  'common.unsaved': '{n} chưa lưu',

  'page.home.title': 'Trang chủ',
  'page.lighting.title': 'Đèn nền',
  'page.keys.title': 'Phím',
  'page.macro.title': 'Macro',
  'page.advanced.title': 'Nâng cao',
  'page.device.title': 'Thiết bị',
  'page.basic.title': 'Bố cục',
  'page.config.title': 'Sao lưu',
  'page.rhythm.title': 'Nhạc',
  'page.setting.title': 'Cài đặt',

  'status.gettingReady': 'Đang chuẩn bị…',
  'status.chooseKeyboard': 'Chọn bàn phím trong cửa sổ hiện lên của trình duyệt…',
  'status.noKeyboardSelected': 'Chưa chọn bàn phím nào.',
  'status.connecting': 'Đang kết nối…',
  'status.couldNotConnect': 'Không kết nối được: {msg}',
  'status.disconnected': 'Đã ngắt kết nối.',
  'status.readingKeyboard': 'Đang đọc bàn phím…',
  'status.reconnecting': 'Kết nối bị gián đoạn — đang kết nối lại…',
  'status.lostConnection': 'Mất kết nối ({reason}) — hãy bấm Kết nối lại.',
  'status.couldNotRead': 'Không đọc được bàn phím: {msg}',
  'status.ready': 'Sẵn sàng — đã kết nối {name}. Chọn một mục bên trái.',
  'status.reconnectingKb': 'Đang kết nối lại bàn phím…',
  'status.prevDeviceMissing': 'Không tìm thấy thiết bị đã cấp quyền — hãy bấm Kết nối.',
  'status.noWebHid':
    'Trình duyệt này không hỗ trợ bàn phím. Hãy dùng Chrome hoặc Edge trên máy tính.',
  'status.welcomeBack': 'Chào mừng trở lại! Bấm Kết nối để chọn bàn phím.',
  'status.plugAndConnect':
    'Sẵn sàng. Cắm bàn phím GravaStar bằng cáp USB rồi bấm Kết nối.',
  'status.couldNotReadKeymap': 'Không đọc được bố cục phím: {msg}',

  'home.title': 'Cài đặt bàn phím GravaStar của bạn',
  'home.note':
    'Đổi màu và hiệu ứng phím, gán lại phím, ghi macro — tất cả ngay ' +
    'trong trình duyệt. Không cần cài đặt, dữ liệu không rời khỏi máy của bạn.',
  'home.connectBtn': 'Kết nối bàn phím',
  'home.step1': 'Cắm bàn phím vào máy tính bằng cáp USB.',
  'home.step2': 'Bấm "Kết nối bàn phím" và chọn bàn phím trong cửa sổ hiện lên.',
  'home.step3': 'Chọn mục muốn chỉnh bên trái — màu sắc, phím, macro.',
  'home.needs':
    'Dùng được trên Chrome hoặc Edge trên máy tính (không dùng trên ' +
    'điện thoại hay Firefox). Hỗ trợ: dòng GravaStar K1 / K1 Pro / K98 qua cáp USB.',
  'home.welcomeBack': 'Chào mừng trở lại, {name}',
  'home.savedNote':
    'Mọi thay đổi được lưu trực tiếp vào bàn phím — rút cáp vẫn giữ nguyên.',
  'home.linkColors': 'Màu sắc & hiệu ứng',
  'home.linkKeys': 'Gán lại phím',
  'home.linkMacros': 'Macro',

  'keys.modelUnknown': 'Chưa rõ mẫu — hiển thị bố cục tham chiếu K1 Pro.',
  'keys.layoutNotPorted':
    'Chưa có bảng bố cục cho {model} — hiển thị bố cục tham chiếu K1 Pro.',

  'device.connectBlurb':
    'Kết nối bàn phím để xem mẫu, phiên bản firmware và mức pin.',
  'device.about': 'Về bàn phím của bạn',
  'device.model': 'Mẫu',
  'device.screen': 'Màn hình',
  'device.none': 'Không có',
  'device.rawData': 'Dữ liệu thô của thiết bị',
  'device.modelId': 'Mã mẫu',
  'device.deviceUuid': 'UUID thiết bị',
  'device.profileData': 'Dữ liệu cấu hình',
  'device.lightMode': 'Chế độ đèn',
  'device.sleepTime': 'Thời gian ngủ',
  'device.lightData': 'Dữ liệu đèn',
  'device.macroData': 'Dữ liệu macro',
  'device.customColours': 'Màu đèn tuỳ chỉnh',
  'device.slotTitle': 'Ô {i} — rgb({r},{g},{b})',
  'device.keyAssignments': 'Phím đã gán — lớp {n} (thô)',
  'device.allSlots': 'Tất cả 128 ô phím, theo thứ tự.',
  'device.slotTip': 'Ô {i} — 0x{hex}',
  'device.snapshotJson': 'JSON trạng thái',
  'device.snapshotJsonHint': 'Toàn bộ dữ liệu đọc được, gói trong một tài liệu JSON.',

  'basic.title': 'Bố cục bàn phím',
  'basic.disconnectedBlurb':
    'Hiển thị bố cục vật lý của bàn phím đã kết nối — những phím nào ' +
    'có và nằm ở đâu.',
  'basic.keysCount': '{n} phím vật lý',
  'basic.kvKeys': 'Phím',
  'basic.kvKeySize': 'Kích thước phím',
  'basic.kvLivePreview': 'Xem trước trực tiếp',
  'basic.keySize': 'phím 1u tiêu chuẩn (kích thước phổ biến của bàn phím)',
  'basic.layoutTable': 'Bảng bố cục',
  'basic.layoutMatched': 'khớp với mẫu bàn phím này',
  'basic.layoutGeneric': 'bố cục tham chiếu chung — chưa có bảng cho mẫu này',
  'basic.livePreview':
    'trang Phím hiển thị bố cục này với nhãn phím và đèn trực tiếp',
  'basic.hint':
    'Ứng dụng gốc cho phép vẽ hình dáng và khoảng cách phím tuỳ ý, nhưng ' +
    'chỉ lưu trong trình duyệt — không bao giờ gửi vào bàn phím. ' +
    'Trang này hiển thị bố cục cố định mà bàn phím thực sự dùng.',
  'basic.editKeyShape': 'Sửa hình dáng phím',
  'basic.editKeyShapeWhy': 'Ứng dụng gốc chỉ lưu trong trình duyệt, không lưu vào bàn phím',
  'basic.hiddenKeys': 'Phím ẩn',
  'basic.hiddenKeysWhy': 'Chi tiết bố cục chỉ nằm trong trình duyệt ở ứng dụng gốc',
  'basic.baseSize': 'Kích thước gốc / khoảng cách',
  'basic.baseSizeWhy': 'Chỉnh bố cục chỉ nằm trong trình duyệt — không có gì để gửi vào bàn phím',

  'config.title': 'Sao lưu & khôi phục',
  'config.disconnectedBlurb':
    'Lưu toàn bộ dữ liệu trên bàn phím ra một tệp, hoặc khôi phục từ ' +
    'tệp đã lưu trước đó.',
  'config.exportTitle': 'Lưu bản sao lưu',
  'config.exportHint':
    'Tải về một tệp JSON chứa toàn bộ dữ liệu đang lưu trên bàn phím — ' +
    'phím đã gán, đèn, macro và thông tin thiết bị. Dùng để khôi phục ' +
    'sau này hoặc chuyển cài đặt sang bàn phím khác.',
  'config.downloadBtn': 'Tải tệp sao lưu',
  'config.reading': 'Đang đọc thiết bị…',
  'config.downloaded': 'Đã tải tệp sao lưu.',
  'config.exportFailed': 'Không tạo được bản sao lưu: {msg}',
  'config.importTitle': 'Khôi phục từ bản sao lưu',
  'config.importHint':
    'Chọn một tệp sao lưu do trang này (hoặc công cụ omg CLI) tạo ra. ' +
    'Trang sẽ cho xem chính xác những gì sẽ thay đổi trước khi ghi; ' +
    'mỗi phần đều được kiểm tra lại trên bàn phím sau đó.',
  'config.fileBad': 'Không dùng được tệp này: {msg}',
  'config.fileUnreadable': 'Không đọc được tệp: {msg}',
  'config.fileLine': 'Tệp: {name} — mẫu "{model}"',
  'config.noWritable': 'Không tìm thấy phần nào có thể ghi trong tệp này.',
  'config.writeBtn': 'Ghi vào bàn phím',
  'config.writeBtnConfirm': 'Có — ghi {n} phần vào bàn phím',
  'config.writeWarn': 'Thao tác này ghi vào bàn phím và kiểm tra từng phần sau đó.',
  'config.allSaved': 'Đã lưu tất cả các phần.',
  'config.failed': 'THẤT BẠI: {msg}',
  'config.skippedPrefix': 'bỏ qua — {what}',
  'config.keymapSection': 'Phím đã gán',
  'config.keymapSummary': '{n} lớp phím',
  'config.keymapSaved': 'lớp {n}',
  'config.colorsSection': 'Màu từng phím',
  'config.colorsSummary': '{n} màu phím từ tệp',
  'config.colorsSaved': 'đã lưu và kiểm tra',
  'config.lightSection': 'Hiệu ứng đèn',
  'config.lightSummary': '{n} byte dữ liệu hiệu ứng',
  'config.macroSection': 'Macro',
  'config.macroSummary': '{n} byte dữ liệu macro',
  'config.saved': 'đã lưu',
  'config.savedList': 'đã lưu ({list})',
  'config.savedChecked': 'đã lưu và kiểm tra',
  'config.layerUnreadable': 'phím đã gán (lớp {n}): dữ liệu không đọc được',
  'config.layerUnreadableVals': 'phím đã gán (lớp {n}): giá trị không đọc được',
  'config.pending': 'bản này chưa hỗ trợ',
  'config.pendingLayers': 'phím đã gán ({n} lớp): {why}',
  'config.pendingColors': 'màu từng phím ({n} phím): {why}',
  'config.pendingLight': 'hiệu ứng đèn ({n} byte): {why}',
  'config.pendingMacro': 'macro ({n} byte): {why}',
  'config.skipColorsBad': 'màu từng phím: dữ liệu trong tệp không đọc được',
  'config.skipLightBad': 'hiệu ứng đèn: dữ liệu trong tệp không đọc được',
  'config.skipMacroBad': 'macro: dữ liệu trong tệp không đọc được',
  'config.skipProfile':
    'cấu hình thô của thiết bị (thời gian ngủ, chế độ đèn): không áp dụng — ' +
    'hãy đổi ở trang Cài đặt và Đèn nền',
  'config.errNotProfile': 'Tệp này không phải bản sao lưu omg được hỗ trợ.',
  'config.errNotBackup': 'Đây không giống tệp sao lưu omg.',
  'config.errNoKhub': 'Bản sao lưu này không chứa bàn phím khub916.',
  'config.errNoSettings': 'Bản sao lưu này không có cài đặt bàn phím để nhập.',
  'config.errConnectFirst': 'Hãy kết nối bàn phím trước.',

  'rhythm.title': 'Đèn phản ứng theo nhạc',
  'rhythm.blurb':
    'Ứng dụng gốc có thể làm đèn bàn phím phản ứng theo nhạc, nhưng cần ' +
    'chương trình đồng hành trên Windows — trang web không làm được phần đó.',
  'rhythm.fact1': 'Đèn phía bàn phím đã dùng đầy đủ ngay hôm nay — xem trang Đèn nền.',
  'rhythm.fact2': 'Màu từng phím trực tiếp hiển thị ở trang Phím.',

  'setting.title': 'Cài đặt',
  'setting.disconnectedBlurb': 'Cài đặt thiết bị có thể thay đổi an toàn từ trình duyệt.',
  'setting.sleepTitle': 'Hẹn giờ ngủ',
  'setting.sleepCurrent': 'Hiện tại',
  'setting.sleepSeconds': '{n} giây',
  'setting.sleepWhat': 'Tác dụng',
  'setting.sleepWhatText': 'bàn phím thức bao lâu trước khi tự ngủ',
  'setting.sleepNote': 'Lưu ý',
  'setting.sleepNoteText':
    'Ứng dụng gốc chỉ hiển thị mục này cho bàn phím không dây và cảnh báo ' +
    'có thể không có tác dụng khi cắm dây — kết quả có thể khác nhau.',
  'setting.secondsPlaceholder': 'giây',
  'setting.setSleep': 'Đặt thời gian ngủ',
  'setting.confirmSleep': 'Có — lưu vào bàn phím',
  'setting.badSeconds': 'Nhập số giây nguyên từ 0 đến 255.',
  'setting.sleepPending': 'Chưa thể lưu thời gian ngủ — {why}.',
  'setting.sleepSaved': 'Đã đặt thời gian ngủ {n} giây — đã kiểm tra trên bàn phím.',
  'setting.sleepSent': 'Đã đặt thời gian ngủ {n} giây — đã gửi nhưng chưa xác nhận.',
  'setting.sleepFailed': 'Không lưu được thời gian ngủ: {msg}',
  'setting.otherTitle': 'Cài đặt khác có ở trang khác',
  'setting.factLight': 'Hiệu ứng đèn, tốc độ và độ sáng — xem trang Đèn nền.',
  'setting.factDevice': 'Thông tin kết nối, phiên bản firmware và pin — xem trang Thiết bị.',
  'setting.factKeys': 'Phím đã gán, macro và phím nâng cao — xem trang Phím, Macro và Nâng cao.',
  'setting.factSafety':
    'Đặt lại xuất xưởng và cập nhật firmware cố ý không có ở đây vì lý do an toàn.',

  'light.connectBlurb':
    'Kết nối bàn phím để cài đặt đèn — chế độ hiệu ứng, tốc độ/' +
    'độ sáng, màu sắc và màu tuỳ chỉnh từng phím.',
  'light.currentEffect': 'Hiệu ứng hiện tại',
  'light.chooseEffect': 'Chọn hiệu ứng',
  'light.chooseHint': 'Chạm vào một hiệu ứng để xem trước trên bàn phím phía trên.',
  'light.hue': 'Sắc độ',
  'light.speed': 'Tốc độ',
  'light.brightness': 'Độ sáng',
  'light.colour': 'Màu sắc',
  'light.oneColour': 'Một màu',
  'light.mixedColours': 'Nhiều màu',
  'light.colours': 'Màu sắc',
  'light.coloursHint': 'Tô nhanh cho hiệu ứng "tuỳ chỉnh", hoặc tự chọn màu bất kỳ.',
  'light.presetSolid': 'Một màu',
  'light.presetSolidHint': 'Một màu cho mọi phím',
  'light.presetGradient': 'Chuyển sắc',
  'light.presetGradientHint': 'Pha giữa hai màu',
  'light.presetRainbow': 'Cầu vồng',
  'light.presetRainbowHint': 'Đủ mọi màu',
  'light.from': 'Từ',
  'light.to': 'Đến',
  'light.applyFill': 'Tô màu',
  'light.resetToKeyboard': 'Khôi phục từ bàn phím',
  'light.editing': 'Đang chỉnh',
  'light.effectColour': 'Màu hiệu ứng',
  'light.keyN': 'Phím #{n}',
  'light.perKeyTitle': 'Màu từng phím ({n} phím)',
  'light.perKeyHint':
    'Tinh chỉnh màu của từng phím. Chạm vào phím trên bàn phím hoặc ô ' +
    'bên dưới để chọn phím mà bộ chọn màu đang chỉnh.',
  'light.saveTitle': 'Lưu vào bàn phím',
  'light.saveChanges': 'Lưu thay đổi',
  'light.undoChanges': 'Hoàn tác thay đổi',
  'light.advancedJson': 'Nâng cao: JSON cấu hình',
  'light.copied': 'Đã sao chép JSON cấu hình.',
  'light.kvEffect': 'Hiệu ứng',
  'light.kvColourStyle': 'Kiểu màu',
  'light.kvAccent': 'Màu nhấn',
  'light.kvPerKey': 'Số phím đã đặt màu',
  'light.perKeyCount': '{n}/{total}',
  'light.kvUnreadable': '— (không đọc được từ bàn phím)',
  'light.effectUnknown': 'Hiệu ứng {n} (không rõ)',
  'light.modeNotInTable': 'Hiệu ứng hiện tại {n} (ngoài bảng)',
  'light.effectNoAccent': 'Hiệu ứng này ({name}) không dùng một màu nhấn duy nhất.',
  'light.fillFailed': 'Không áp dụng được màu tô: {msg}',
  'light.saveTitleQ': 'Lưu các thay đổi đèn này?',
  'light.saveHint':
    'Thao tác này ghi hiệu ứng, màu sắc và tốc độ mới vào bàn phím và ' +
    'kiểm tra từng bước đã lưu đúng. Bàn phím có thể nhấp nháy khi cập nhật.',
  'light.exactSettings': 'Cài đặt chính xác sẽ được gửi:',
  'light.apply': 'Áp dụng',
  'light.stepReading': 'Đang đọc trạng thái thiết bị…',
  'light.stepColorsOk': 'Màu từng phím: đã lưu và kiểm tra',
  'light.stepColorsSkip': 'Màu từng phím: bỏ qua (không đổi)',
  'light.stepFxOk': 'Cài đặt hiệu ứng: đã lưu và kiểm tra',
  'light.stepFxSkip': 'Cài đặt hiệu ứng: bỏ qua (không đổi)',
  'light.stepAccentOk': 'Màu nhấn: đã lưu và kiểm tra',
  'light.stepAccentSkip': 'Màu nhấn: bỏ qua',
  'light.failedSuffix': 'THẤT BẠI — {msg}',
  'light.partialFail': 'Một số thay đổi đèn thất bại — xem các bước phía trên.',
  'light.saved': 'Đã lưu đèn vào bàn phím.',
  'light.saveFailed': 'Lưu thất bại: {msg}',
  'light.badProfile': 'dữ liệu cấu hình quá ngắn để đọc trạng thái đèn',
  'light.badRange': 'tốc độ/độ sáng phải ≤ 20',

  'macro.title': 'Macro',
  'macro.connectBlurb': 'Kết nối bàn phím để quản lý các macro đã lưu.',
  'macro.count': 'Macro ({n})',
  'macro.storageHint':
    'Còn trống khoảng {free}/{total} byte bộ nhớ macro. ' +
    'Khi lưu, toàn bộ danh sách được ghi vào bàn phím và kiểm tra lại.',
  'macro.empty': 'Bàn phím chưa có macro nào.',
  'macro.colName': 'Tên',
  'macro.colSteps': 'Bước',
  'macro.editing': 'Đang sửa',
  'macro.edit': 'Sửa',
  'macro.delete': 'Xoá',
  'macro.new': '+ Macro mới',
  'macro.newStep': '+ Thêm bước',
  'macro.editor': 'Trình sửa macro',
  'macro.editorEmpty': 'Chọn một macro ở trên hoặc tạo macro mới để sửa các bước.',
  'macro.newN': 'Macro mới #{n}',
  'macro.editingN': 'Đang sửa macro #{n}',
  'macro.editorHint':
    'mỗi bước là một lần nhấn hoặc nhả phím kèm độ trễ tính bằng mili giây ' +
    '(tối đa {max}). ' +
    'Thay đổi chỉ được gửi vào bàn phím khi bạn lưu.',
  'macro.name': 'Tên',
  'macro.colAction': 'Hành động',
  'macro.colKind': 'Loại',
  'macro.colDelay': 'Độ trễ (ms)',
  'macro.press': 'Nhấn',
  'macro.release': 'Nhả',
  'macro.unknownKey': 'Phím lạ (mã {u})',
  'macro.kindKey': 'Phím',
  'macro.kindModifier': 'Phím bổ trợ',
  'macro.kindMouse': 'Chuột',
  'macro.kindOther': 'Khác (nâng cao)',
  'macro.badDelay': 'Độ trễ phải là số nguyên mili giây từ 0 đến {max}',
  'macro.moveUp': 'Đưa bước lên',
  'macro.moveDown': 'Đưa bước xuống',
  'macro.removeStep': 'Xoá bước',
  'macro.importJson': 'Nhập JSON các bước…',
  'macro.importPrompt':
    'Dán JSON các bước — mảng [{"action":"down","key":"KeyA","delay_ms":8}, …] ' +
    'hoặc {"name":"…","steps":[…]} (docs/macro-schema.md):',
  'macro.imported': 'Đã nhập {n} bước — bấm Lưu để gửi vào bàn phím.',
  'macro.importFailed': 'Không hiểu JSON này: {msg}',
  'macro.saveBtn': 'Lưu macro vào bàn phím',
  'macro.saveBtnClean': 'Lưu macro (không có thay đổi)',
  'macro.saveHint': 'Lưu toàn bộ macro vào bàn phím',
  'macro.discard': 'Bỏ thay đổi',
  'macro.bindTitle': 'Gán vào phím',
  'macro.bindHint':
    'Gán một macro đã lưu cho một phím ở lớp đã chọn. ' +
    'Macro phải được lưu trên bàn phím trước.',
  'macro.bindEmpty': 'Chưa có macro — hãy lưu một macro trước.',
  'macro.unnamedEntry': '(chưa đặt tên)',
  'macro.stepsCount': '{n} bước',
  'macro.layer': 'Lớp',
  'macro.advanced': 'Nâng cao',
  'macro.macroSel': 'Macro',
  'macro.macroType': 'Loại macro',
  'macro.loopCount': 'Số lần lặp',
  'macro.assign': 'Gán macro vào phím',
  'macro.clearKey': 'Xoá phím này',
  'macro.slotHint':
    'Ô phím được đánh số 0–127; chọn ô của phím bạn muốn thay đổi.',
  'macro.needsStep':
    'Macro cần ít nhất một bước. Để xoá macro, hãy dùng nút Xoá.',
  'macro.noSpace':
    "Không đủ bộ nhớ macro: '{name}' cần khoảng {need} byte nhưng chỉ còn khoảng {free} — hãy xoá macro không dùng.",
  'macro.prepareFailed': 'Không chuẩn bị được dữ liệu macro: {msg}',
  'macro.createDesc': 'Tạo macro mới "{name}" với {n} bước',
  'macro.replaceDesc': 'Thay macro "{old}" bằng "{name}" ({n} bước)',
  'macro.saveAllQ': 'Lưu toàn bộ macro vào bàn phím?',
  'macro.savedOk': '{desc} — đã lưu và kiểm tra trên bàn phím.',
  'macro.saveFailed': 'Không lưu được macro: {msg}',
  'macro.deleteQ':
    'Xoá macro "{name}" ({n} bước)?\n\n' +
    'Thao tác này xoá macro khỏi bàn phím. Các phím đang gán macro này sẽ ngừng hoạt động.',
  'macro.deleted': 'Đã xoá macro "{name}" — đã lưu và kiểm tra trên bàn phím.',
  'macro.deleteFailed': 'Không xoá được macro: {msg}',
  'macro.badSlot': 'Ô phím phải là số nguyên 0..{max}',
  'macro.badType': 'Loại macro phải là số nguyên 1..255',
  'macro.badLoop': 'Số lần lặp phải là số nguyên ≥ 1',
  'macro.clearDesc': 'Xoá ô phím {slot} ở lớp {layer} (hiện là {before})',
  'macro.assignDesc':
    'Gán macro[{i}] vào ô phím {slot} ở lớp {layer} (hiện là {before})',
  'macro.saveChangeQ': 'Lưu thay đổi này vào bàn phím?',
  'macro.slotRange':
    'ô phím {slot} vượt phạm vi — keymap chỉ có {n} mục',
  'macro.slotCleared': 'Đã xoá ô phím {slot} — đã kiểm tra trên bàn phím.',
  'macro.slotRuns': 'Ô phím {slot} giờ chạy macro "{name}" — đã kiểm tra trên bàn phím.',
  'macro.keySaveFailed': 'Không lưu được thay đổi phím: {msg}',

  'adv.title': 'Phím nâng cao',
  'adv.connectBlurb':
    'Kết nối bàn phím để quản lý phím nâng cao — SOCD, mod-tap và toggle.',
  'adv.reading': 'Đang đọc trạng thái phím nâng cao…',
  'adv.unavailable': 'Không đọc được trạng thái phím nâng cao — hãy bấm Làm mới.',
  'adv.cardTitle': 'Phím nâng cao — SOCD / MT / TGL',
  'adv.chipCounts': '{label}: {hist} mục lưu · {bound} đã gán',
  'adv.hint':
    'SOCD khiến hai phím đối nghịch dùng chung một đầu ra, mod-tap (MT) ' +
    'cho một phím hai hành động tuỳ thời gian giữ, và toggle (TGL) khiến ' +
    'một phím bật/tắt phím khác mỗi lần nhấn. Thiết bị không có xoá — ' +
    '"Gỡ gán" xoá liên kết của phím nhưng giữ lại cài đặt đã lưu.',
  'adv.techHint':
    'Khối lịch sử: {n} B — ô SOCD/MT là 8 B, ô TGL là 4 B. ' +
    'Liên kết nằm trong keymap lớp 0 dưới dạng giá trị 0x20/0x21/0x22.',
  'adv.unconfirmedWarn':
    'Lần ghi cài đặt trước đã gửi nhưng bàn phím không xác nhận. ' +
    'Trên firmware K1 Pro, lần lưu này không phải lúc nào cũng giữ được — ' +
    'hãy bấm Làm mới sau một phút để kiểm tra, hoặc thử lại.',
  'adv.kindTitle': 'Phím nâng cao {kind}',
  'adv.noneBound': 'Chưa có phím nào dùng chức năng nâng cao loại này.',
  'adv.colSlot': 'Ô phím',
  'adv.colPos': 'Vị trí',
  'adv.colSetting': 'Cài đặt',
  'adv.colDetail': 'Chi tiết',
  'adv.colSaved': 'Giá trị đã lưu',
  'adv.noSaved': '(chưa có cài đặt — gán cũ)',
  'adv.unbind': 'Gỡ gán',
  'adv.unbindWhy': 'Xoá chức năng nâng cao của phím này. Cài đặt đã lưu vẫn nằm trên bàn phím.',
  'adv.savedOnKb': 'Cài đặt đã lưu trên bàn phím:',
  'adv.colStored': 'Giá trị đã lưu',
  'adv.addHintMt':
    'Mod-tap: nhấn nhanh phát Tap, nhấn giữ phát Hold sau ngưỡng thời gian. ' +
    'Giá trị hiện tại của phím bị thay bằng liên kết nâng cao.',
  'adv.addHintSocd':
    'SOCD: hai phím đối nghịch dùng chung một đầu ra; mục Hướng chọn chế độ xử lý. ' +
    'Giá trị hiện tại của cả hai phím được lưu làm mục lịch sử.',
  'adv.addHintTgl':
    'Toggle: nhấn phím gán sẽ bật/tắt đầu ra lưu từ giá trị hiện tại của ô toggle.',
  'adv.fKeyToChange': 'Phím cần đổi',
  'adv.fTap': 'Nhấn nhanh (Tap)',
  'adv.fHold': 'Nhấn giữ (Hold)',
  'adv.fHoldTime': 'Thời gian giữ (×10 ms)',
  'adv.holdTimeWhy': 'Bạn phải giữ phím bao lâu trước khi hành động Hold kích hoạt',
  'adv.addMt': 'Thêm phím MT',
  'adv.addSocd': 'Thêm cặp SOCD',
  'adv.addTgl': 'Thêm phím TGL',
  'adv.saveToKb': 'Lưu liên kết phím và cài đặt của nó vào bàn phím',
  'adv.fKeyA': 'Phím A (ô)',
  'adv.fKeyB': 'Phím B (ô)',
  'adv.fDirection': 'Hướng',
  'adv.fToggleTarget': 'Phím bị toggle (ô)',
  'adv.socdLastWins': 'Phím nhấn sau thắng',
  'adv.socdAPriority': 'Ưu tiên phím A',
  'adv.socdBPriority': 'Ưu tiên phím B',
  'adv.socdAllCancel': 'Huỷ tất cả',
  'adv.dirLast': 'ưu tiên phím nhấn sau',
  'adv.dirA': 'ưu tiên phím A',
  'adv.dirB': 'ưu tiên phím B',
  'adv.dirAll': 'huỷ tất cả',
  'adv.involvesA': 'liên quan phím A',
  'adv.involvesB': 'liên quan phím B',
  'adv.holdAfter': 'giữ {ms} ms',
  'adv.toggle': 'bật/tắt',
  'adv.customValue': '(giá trị tuỳ chỉnh)',
  'adv.readFailed': 'Không đọc được cài đặt phím nâng cao: {msg}',
  'adv.badHoldTime': 'Thời gian giữ phải là số nguyên từ 0 đến 100',
  'adv.mtFailed': 'Không thiết lập được phím mod-tap: {msg}',
  'adv.socdFailed': 'Không thiết lập được cặp SOCD: {msg}',
  'adv.tglFailed': 'Không thiết lập được phím toggle: {msg}',
  'adv.mtDesc': 'Phím MT[#{key}] ({old}): nhấn nhanh {tap}, nhấn giữ {hold}, ngưỡng {ms} ms',
  'adv.socdDesc': 'SOCD phím[#{a}] + phím[#{b}]: hướng {dir}',
  'adv.tglDesc': 'Phím TGL[#{key}] điều khiển phím[#{t}] ({v})',
  'adv.confirmWrite':
    '{desc}\n\n' +
    'Thao tác này lưu thay đổi vào bàn phím. Lưu ý: trên một số firmware, ' +
    'cài đặt đã lưu có thể không giữ được — trang sẽ báo thật nếu điều đó xảy ra. Tiếp tục?',
  'adv.histSaved': 'cài đặt đã lưu và kiểm tra',
  'adv.histUnconfirmed':
    'cài đặt đã gửi nhưng CHƯA xác nhận (firmware này có thể không giữ — bấm Làm mới sau một phút để kiểm tra)',
  'adv.savedOk': '{desc} — liên kết phím đã lưu; {hist}.',
  'adv.saveFailed': 'Không lưu được thay đổi phím nâng cao: {msg}',
  'adv.unbindQ':
    'Xoá chức năng {kind} khỏi ô phím #{i}?\n\n' +
    'Phím hiện đang chạy {old}. Cài đặt đã lưu vẫn nằm trên bàn phím ' +
    '(thiết bị không có xoá), nhưng phím trở về hoạt động bình thường.',
  'adv.unbound': 'Đã xoá chức năng {kind} khỏi ô phím #{i} — đã kiểm tra trên bàn phím.',
  'adv.unbindFailed': 'Không xoá được chức năng đó: {msg}',

  'keys.title': 'Bàn phím',
  'keys.connectBlurb':
    'Hình xem bàn phím và gán lại phím cần bàn phím đã kết nối. ' +
    'Chạm vào một phím, chọn chức năng mới, rồi lưu.',
  'keys.poolTitle': 'Danh sách phím',
  'keys.apply': 'Áp dụng',
  'keys.discard': 'Bỏ',
  'keys.writing': 'Đang ghi…',
  'keys.applyN': 'Áp dụng ({n})',
  'keys.unassign': 'Bỏ gán',
  'keys.unassignWhy': 'Để phím đã chọn không làm gì',
  'keys.saveThis': 'Lưu phím này',
  'keys.searchPh': 'Tìm phím…',
  'keys.noMatch': 'Không có phím nào khớp.',
  'keys.pickPrompt': 'Chạm vào một phím trên bàn phím để chọn chức năng mới.',
  'keys.selInfo': '#{i} {name} — hiện là {cur}{pend}',
  'keys.willBecome': ', sẽ thành {v}',
  'keys.nothing': 'không có',
  'keys.dupNote': 'Lưu ý: {label} cũng đang gán cho {slots}.',
  'keys.confirmTitleAll': 'Lưu {n} thay đổi phím vào lớp {l}?',
  'keys.confirmTitleOne': 'Đổi {name} (#{i}) ở lớp {l}?',
  'keys.confirmWarn': 'Thao tác này gửi thay đổi vào bàn phím và kiểm tra đã lưu.',
  'keys.saveAndCheck': 'Lưu & kiểm tra',
  'keys.changeDesc': '#{i} {name}: {old} → {new}',
  'keys.savedN': 'Đã lưu {n} thay đổi phím ở lớp {l} — đã kiểm tra trên bàn phím.',
  'keys.saveFailed': 'Không lưu được thay đổi phím: {msg}',
  'keys.poolBasic': 'Cơ bản',
  'keys.poolSystem': 'Hệ thống',
  'keys.poolMouse': 'Chuột',
  'keys.poolMedia': 'Đa phương tiện',
  'keys.poolEdit': 'Chỉnh sửa / Ứng dụng',

  'kb.keyTitle': 'Phím {n} — {label}',
  'kb.willBecome': '→ sẽ thành 0x{hex}',
  'kb.unsaved': '(chưa lưu)',

  'hid.interrupted':
    'kết nối bàn phím bị gián đoạn ({reason}) — hãy kết nối lại và thử lại',
  'hid.badReplySize': 'kích thước phản hồi bất thường từ bàn phím ({n} byte)',
  'hid.noAttempt': 'khub916: chưa có lần thử nào',
  'hid.transferError': 'lỗi truyền',
  'hid.attemptsFailed': 'lệnh thất bại sau {n} lần thử: {msg}',
  'hid.shortResponse': 'khub916 phản hồi ngắn: {n} byte',
  'hid.echoMismatch': 'khub916 phản hồi không khớp: gửi [{sent}] mong đợi [{exp}]',
  'hid.writeInterrupted': 'kết nối bàn phím bị gián đoạn ({reason})',
  'hid.configWriteFailed': 'ghi cấu hình thất bại: {msg}',
  'hid.unexpectedKeymap': 'bàn phím trả về kích thước keymap bất thường',
  'hid.keymapUnconfirmed': 'thay đổi phím không được bàn phím xác nhận',
  'hid.macroBadSize': 'dữ liệu macro có kích thước không hợp lệ ({n} byte)',
  'hid.macroUnconfirmed': 'bàn phím không xác nhận đã lưu macro',
  'hid.profileBadSize': 'cấu hình thiết bị có kích thước không hợp lệ ({n} byte)',
  'hid.profileUnconfirmed': 'bàn phím không xác nhận đã lưu cài đặt',
  'hid.colorsCount': 'lưu màu từng phím cần đúng {need} màu, nhận {got}',
  'hid.colorsUnconfirmed': 'bàn phím không xác nhận màu từng phím',
  'hid.lightUnconfirmed': 'bàn phím không xác nhận cài đặt đèn',
  'hid.advBadSize': 'dữ liệu phím nâng cao có kích thước không hợp lệ ({n} byte)',
  'hid.kcBadSize': 'kích thước đọc lại phím nâng cao bất thường ({n})',
  'hid.kcCount': 'lưu phím nâng cao cần 1..={max} giá trị, nhận {n}',
  'hid.kcUnconfirmed': 'bàn phím không xác nhận đã lưu phím nâng cao',
  'hid.noReply': 'bàn phím không phản hồi',
  'hid.noChannel': 'bàn phím không trả lời trên kênh nào đã biết ({why})',
  'hid.channelErr': 'kênh {id}: {msg}',
  'hid.channelSize': 'kênh {id}: phản hồi bất thường ({n} byte)',
  'hid.notKeyboard': 'đây không giống bàn phím GravaStar được hỗ trợ',
  'hid.wirelessUnsupported':
    'kết nối qua dongle không dây chưa được hỗ trợ — hãy cắm bằng cáp USB',
  'hid.timeout': 'khub916: không có phản hồi (hết giờ)',

  'onboard.title': 'Chào mừng!',
  'onboard.sub': 'Ba bước nhanh để bắt đầu:',
  'onboard.step1': 'Cắm bàn phím GravaStar vào máy bằng cáp USB.',
  'onboard.step2': 'Bấm Kết nối và chọn bàn phím trong cửa sổ hiện lên.',
  'onboard.step3': 'Chọn chức năng bên trái để tuỳ chỉnh.',
  'onboard.dismiss': 'Đã hiểu — bắt đầu thôi!',
};

const DICTS: Record<Locale, Record<string, string>> = { en, vi };

export function t(key: string, vars?: Record<string, string | number>): string {
  let s = DICTS[current][key] ?? DICTS.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

// Apply the detected locale to <html lang> once the DOM exists.
if (typeof document !== 'undefined') {
  document.documentElement.lang = current;
}
