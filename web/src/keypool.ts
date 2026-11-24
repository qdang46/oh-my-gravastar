/**
 * Key-value pool for the remap picker — port of the vendor
 * `Ca[]` table (docs/research/khub-webapp/index-M8-m9qFR.deob.js,
 * 217 `{value,name}` entries, default EN legend). `value` is the raw
 * u32 keymap value written verbatim by `setBasicKeyCode`; dual
 * encodings (e.g. `0x80007` vs `0x80700` for desktop) are kept,
 * exactly like the vendor pool.
 *
 * Groups mirror the vendor `keyModelList` tabs (basicKeys /
 * windows+system / mouse / multimedia / edit+apps); the macro tab
 * is excluded — macro binding is a separate bead.
 *
 * Each entry also exposes the decoded HID usage id (for plain-key
 * encodings) so the picker can search and tooltip by usage code
 * (bead c8y).
 */

import { decodeKeyValue, hidUsageLabel } from './proto/khub916.ts';

export type PoolGroup = 'basic' | 'system' | 'mouse' | 'media' | 'edit';

export interface PoolEntry {
  /** Raw u32 keymap value (written verbatim). */
  value: number;
  /** Vendor display name. */
  name: string;
  group: PoolGroup;
  /** HID usage id for `normal` encodings, else null (modifier-only,
   *  macro, Fn, media/system dual encodings…). */
  usage: number | null;
  /** Legend for `usage` ('' when none). */
  usageLabel: string;
}

export const POOL_GROUPS: readonly { id: PoolGroup; label: string }[] = [
  { id: 'basic', label: 'Basic' },
  { id: 'system', label: 'System keys' },
  { id: 'mouse', label: 'Mouse' },
  { id: 'media', label: 'Media' },
  { id: 'edit', label: 'Edit / Apps' },
] as const;

/** Synthetic unassign entry (keymap value 0). */
export const POOL_UNASSIGN: PoolEntry = {
  value: 0,
  name: '(none)',
  group: 'basic',
  usage: null,
  usageLabel: '',
};

const RAW: readonly (readonly [number, string])[] = [
  [41, "ESC"],
  [53, "`~"],
  [43, "Tab"],
  [57, "Caps"],
  [131072, "L_shift"],
  [65536, "L_Ctrl"],
  [30, "1"],
  [20, "Q"],
  [4, "A"],
  [29, "Z"],
  [524288, "L_WIN"],
  [58, "F1"],
  [31, "2"],
  [26, "W"],
  [22, "S"],
  [27, "X"],
  [262144, "L_Alt"],
  [59, "F2"],
  [32, "3"],
  [8, "E"],
  [7, "D"],
  [6, "C"],
  [60, "F3"],
  [33, "4"],
  [21, "R"],
  [9, "F"],
  [25, "V"],
  [61, "F4"],
  [34, "5"],
  [23, "T"],
  [10, "G"],
  [5, "B"],
  [44, "Space"],
  [62, "F5"],
  [35, "6"],
  [28, "Y"],
  [11, "H"],
  [17, "N"],
  [63, "F6"],
  [36, "7"],
  [24, "U"],
  [13, "J"],
  [16, "M"],
  [64, "F7"],
  [37, "8"],
  [12, "I"],
  [14, "K"],
  [54, "<,"],
  [4194304, "R_Alt"],
  [65, "F8"],
  [38, "9"],
  [18, "O"],
  [15, "L"],
  [55, ">."],
  [218103808, "Fn"],
  [66, "F9"],
  [39, "0"],
  [19, "P"],
  [51, ":;"],
  [56, "/?"],
  [101, "App"],
  [67, "F10"],
  [45, "-_"],
  [47, "[{"],
  [52, "'"],
  [68, "F11"],
  [46, "=+"],
  [48, "]}"],
  [40, "Enter"],
  [2097152, "R_shift"],
  [1048576, "R_Ctrl"],
  [69, "F12"],
  [42, "Back"],
  [49, "|"],
  [70, "Print"],
  [73, "Ins"],
  [76, "Del"],
  [80, "left"],
  [71, "Scroll"],
  [74, "Home"],
  [77, "End"],
  [82, "Up"],
  [81, "Down"],
  [72, "Pause"],
  [75, "PgUp"],
  [78, "PgDn"],
  [79, "right"],
  [83, "Num Lock"],
  [95, "Num 7"],
  [92, "Num 4"],
  [89, "Num 1"],
  [98, "Num 0"],
  [84, "Num /"],
  [96, "Num 8"],
  [93, "Num 5"],
  [90, "Num 2"],
  [85, "Num *"],
  [97, "Num 9"],
  [94, "Num 6"],
  [91, "Num 3"],
  [99, "Num ."],
  [86, "Num -"],
  [87, "Num +"],
  [88, "Num Enter"],
  [8388608, "R_WIN"],
  [277760, "close"],
  [262205, "close"],
  [528128, "lock"],
  [524303, "lock"],
  [77312, "zoom-in"],
  [65582, "zoom-in"],
  [77056, "zoom-out"],
  [65581, "zoom-out"],
  [526080, "desktop"],
  [524295, "desktop"],
  [347136, "task-manager"],
  [327756, "task-manager"],
  [71168, "save"],
  [65558, "save"],
  [33554543, "brightness-up"],
  [33582848, "brightness-up"],
  [33554544, "brightness-down"],
  [33583104, "brightness-down"],
  [207104, "Ctrl + Shift + Esc"],
  [196649, "Ctrl + Shift + Esc"],
  [65577, "Ctrl + ESC"],
  [76032, "Ctrl + ESC"],
  [273152, "Alt + Tab"],
  [262187, "Alt + Tab"],
  [277760, "Alt + F4"],
  [262205, "Alt + F4"],
  [272640, "Alt + ESC"],
  [262185, "Alt + ESC"],
  [16843008, "mouse-left"],
  [16842753, "mouse-left"],
  [16908544, "mouse-right"],
  [16908289, "mouse-right"],
  [16974080, "mouse-middle"],
  [16973825, "mouse-middle"],
  [17105152, "mouse-forward"],
  [17104897, "mouse-forward"],
  [17039616, "mouse-back"],
  [17039361, "mouse-back"],
  [33554637, "play-pause"],
  [33606912, "play-pause"],
  [33554819, "multimedia"],
  [33587969, "multimedia"],
  [33554658, "mute"],
  [33612288, "mute"],
  [33554615, "pause"],
  [33601280, "pause"],
  [33554614, "previous-song"],
  [33601024, "previous-song"],
  [33554613, "next-song"],
  [33600768, "next-song"],
  [33554665, "volume-up"],
  [33614080, "volume-up"],
  [33554666, "volume-down"],
  [33614336, "volume-down"],
  [72448, "cut"],
  [65563, "cut"],
  [67072, "copy"],
  [65542, "copy"],
  [71936, "paste"],
  [65561, "paste"],
  [72960, "revoke"],
  [65565, "revoke"],
  [33554979, "browser"],
  [33563394, "browser"],
  [33554834, "calculator"],
  [33591809, "calculator"],
  [33554826, "email"],
  [33589761, "email"],
  [33554836, "my-computer"],
  [33592321, "my-computer"],
  [33554986, "favorite"],
  [33565186, "favorite"],
  [535296, "LWin + tab"],
  [524331, "LWin + tab"],
  [526080, "LWin + D"],
  [524295, "LWin + D"],
  [612352, "LWin + Ctrl + Enter"],
  [589912, "LWin + Ctrl + Enter"],
  [530176, "LWin + T"],
  [524311, "LWin + T"],
  [525312, "LWin + A"],
  [524292, "LWin + A"],
  [526336, "LWin + E"],
  [524296, "LWin + E"],
  [527360, "LWin + I"],
  [524300, "LWin + I"],
  [527872, "LWin + K"],
  [524302, "LWin + K"],
  [525568, "LWin + B"],
  [524293, "LWin + B"],
  [526848, "LWin + G"],
  [524298, "LWin + G"],
  [529664, "LWin + R"],
  [524309, "LWin + R"],
  [529920, "LWin + S"],
  [524310, "LWin + S"],
  [530432, "LWin + U"],
  [524312, "LWin + U"],
  [531200, "LWin + X"],
  [524315, "LWin + X"],
  [538368, "LWin + ."],
  [524343, "LWin + ."],
  [536064, "LWin + ="],
  [524334, "LWin + ="],
  [218169344, "Fn1"],
  [137, "H/R"],
  [136, "S/C"],
  [138, "A/P"],
  [139, "K/T"],
  [135, "*"],
  [50, "CL/B"],
  [100, "L/G/B"],
] as const;

function groupOf(index: number): PoolGroup {
  if (index <= 104 || index >= 209) return 'basic';
  if (index <= 132 || (index >= 177 && index <= 208)) return 'system';
  if (index <= 142) return 'mouse';
  if (index <= 158) return 'media';
  return 'edit';
}

/** HID usage id + legend for a pool value (null for non-`normal` kinds). */
function usageOf(value: number): { usage: number | null; usageLabel: string } {
  const kv = decodeKeyValue(value);
  // usage 0 = bare modifier chord (Ctrl/Shift/Alt/Win only) — no usage key.
  if (kv.kind !== 'normal' || kv.usage === 0) return { usage: null, usageLabel: '' };
  return { usage: kv.usage, usageLabel: hidUsageLabel(kv.usage) };
}

export const KEY_POOL: readonly PoolEntry[] = RAW.map(([value, name], i) => ({
  value,
  name,
  group: groupOf(i),
  ...usageOf(value),
}));

/** value → vendor name for exact pool matches (display fallback). */
const NAME_BY_VALUE = new Map<number, string>();
for (const e of KEY_POOL) if (!NAME_BY_VALUE.has(e.value)) NAME_BY_VALUE.set(e.value, e.name);

/** Vendor pool name for an exact u32 match, else null. */
export function poolNameFor(value: number): string | null {
  return NAME_BY_VALUE.get(value >>> 0) ?? null;
}
