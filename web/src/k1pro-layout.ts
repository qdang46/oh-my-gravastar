/**
 * K1 Pro (916_K1_PRO) physical key layout — ported verbatim from the vendor
 * configurator's `keycodeConfig/keyboard_916_K1_PRO.json`
 * (docs/research/khub-webapp/index-cV1Bl4gC.js).
 *
 * Coordinates are in "key units" px: a standard key is 44 px, rows sit on a
 * ~45 px pitch with 1 px gaps. `pos` is the keymap/light domain position
 * (`pos = 8 + n*4`, `effect_pos = 8 + n*3`, `light_pos = 8 + n*1`,
 * spec docs/protocol-khub916.md §6). `value` is the factory default
 * key value (fallback label only — the live keymap read wins).
 * Entries with `display:false` occupy keymap slots but are not physical
 * keys (media/system/aux positions).
 */

export interface KeyBlock {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  display: boolean;
  /** Factory default key value, e.g. "0x29". */
  value: string;
  /** Keymap-domain position: `pos = 8 + n*4`. */
  pos: number;
  effect_pos: number;
  light_pos: number;
}

/** Keymap/light table index `n` for a block (`pos = 8 + n*4`). */
export function keyIndexOf(pos: number): number {
  return (pos - 8) / 4;
}

export const K1_PRO_BLOCKS: readonly KeyBlock[] = [
  {"name":"ESC","x":0,"y":0,"width":44,"height":44,"display":true,"value":"0x29","pos":8,"effect_pos":8,"light_pos":8},
  {"name":"`~","x":0,"y":57,"width":44,"height":44,"display":true,"value":"0x35","pos":12,"effect_pos":11,"light_pos":9},
  {"name":"Tab","x":0,"y":102,"width":66,"height":44,"display":true,"value":"0x2b","pos":16,"effect_pos":14,"light_pos":10},
  {"name":"Caps","x":0,"y":148,"width":77,"height":44,"display":true,"value":"0x39","pos":20,"effect_pos":17,"light_pos":11},
  {"name":"L_shift","x":0,"y":193,"width":88,"height":44,"display":true,"value":"0x20000","pos":24,"effect_pos":20,"light_pos":12},
  {"name":"L_Ctrl","x":0,"y":239,"width":55,"height":44,"display":true,"value":"0x10000","pos":28,"effect_pos":23,"light_pos":13},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":32,"effect_pos":26,"light_pos":14},
  {"name":"1","x":45,"y":57,"width":44,"height":44,"display":true,"value":"0x1e","pos":36,"effect_pos":29,"light_pos":15},
  {"name":"Q","x":68,"y":102,"width":44,"height":44,"display":true,"value":"0x14","pos":40,"effect_pos":32,"light_pos":16},
  {"name":"A","x":80,"y":148,"width":44,"height":44,"display":true,"value":"0x4","pos":44,"effect_pos":35,"light_pos":17},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x64","pos":48,"effect_pos":38,"light_pos":18},
  {"name":"L_WIN","x":58,"y":239,"width":55,"height":44,"display":true,"value":"0x80000","pos":52,"effect_pos":41,"light_pos":19},
  {"name":"F1","x":91,"y":0,"width":44,"height":44,"display":true,"value":"0x3a","pos":56,"effect_pos":44,"light_pos":20},
  {"name":"2","x":91,"y":57,"width":44,"height":44,"display":true,"value":"0x1f","pos":60,"effect_pos":47,"light_pos":21},
  {"name":"W","x":113,"y":102,"width":44,"height":44,"display":true,"value":"0x1a","pos":64,"effect_pos":50,"light_pos":22},
  {"name":"S","x":125,"y":148,"width":44,"height":44,"display":true,"value":"0x16","pos":68,"effect_pos":53,"light_pos":23},
  {"name":"Z","x":92,"y":193,"width":44,"height":44,"display":true,"value":"0x1d","pos":72,"effect_pos":56,"light_pos":24},
  {"name":"L_Alt","x":114,"y":239,"width":55,"height":44,"display":true,"value":"0x40000","pos":76,"effect_pos":59,"light_pos":25},
  {"name":"F2","x":136,"y":0,"width":44,"height":44,"display":true,"value":"0x3b","pos":80,"effect_pos":62,"light_pos":26},
  {"name":"3","x":137,"y":57,"width":44,"height":44,"display":true,"value":"0x20","pos":84,"effect_pos":65,"light_pos":27},
  {"name":"E","x":159,"y":102,"width":44,"height":44,"display":true,"value":"0x8","pos":88,"effect_pos":68,"light_pos":28},
  {"name":"D","x":170,"y":148,"width":44,"height":44,"display":true,"value":"0x7","pos":92,"effect_pos":71,"light_pos":29},
  {"name":"X","x":138,"y":193,"width":44,"height":44,"display":true,"value":"0x1b","pos":96,"effect_pos":74,"light_pos":30},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":100,"effect_pos":77,"light_pos":31},
  {"name":"F3","x":182,"y":0,"width":44,"height":44,"display":true,"value":"0x3c","pos":104,"effect_pos":80,"light_pos":32},
  {"name":"4","x":183,"y":57,"width":44,"height":44,"display":true,"value":"0x21","pos":108,"effect_pos":83,"light_pos":33},
  {"name":"R","x":205,"y":102,"width":44,"height":44,"display":true,"value":"0x15","pos":112,"effect_pos":86,"light_pos":34},
  {"name":"F","x":216,"y":148,"width":44,"height":44,"display":true,"value":"0x9","pos":116,"effect_pos":89,"light_pos":35},
  {"name":"C","x":184,"y":193,"width":44,"height":44,"display":true,"value":"0x6","pos":120,"effect_pos":92,"light_pos":36},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":124,"effect_pos":95,"light_pos":37},
  {"name":"F4","x":228,"y":0,"width":44,"height":44,"display":true,"value":"0x3d","pos":128,"effect_pos":98,"light_pos":38},
  {"name":"5","x":228,"y":57,"width":44,"height":44,"display":true,"value":"0x22","pos":132,"effect_pos":101,"light_pos":39},
  {"name":"T","x":251,"y":102,"width":44,"height":44,"display":true,"value":"0x17","pos":136,"effect_pos":104,"light_pos":40},
  {"name":"G","x":261,"y":148,"width":44,"height":44,"display":true,"value":"0xa","pos":140,"effect_pos":107,"light_pos":41},
  {"name":"V","x":230,"y":193,"width":44,"height":44,"display":true,"value":"0x19","pos":144,"effect_pos":110,"light_pos":42},
  {"name":"Space","x":171,"y":239,"width":286,"height":44,"display":true,"value":"0x2c","pos":148,"effect_pos":113,"light_pos":43},
  {"name":"F5","x":296,"y":0,"width":44,"height":44,"display":true,"value":"0x3e","pos":152,"effect_pos":116,"light_pos":44},
  {"name":"6","x":273,"y":57,"width":44,"height":44,"display":true,"value":"0x23","pos":156,"effect_pos":119,"light_pos":45},
  {"name":"Y","x":296,"y":102,"width":44,"height":44,"display":true,"value":"0x1c","pos":160,"effect_pos":122,"light_pos":46},
  {"name":"H","x":307,"y":148,"width":44,"height":44,"display":true,"value":"0xb","pos":164,"effect_pos":125,"light_pos":47},
  {"name":"B","x":275,"y":193,"width":44,"height":44,"display":true,"value":"0x5","pos":168,"effect_pos":128,"light_pos":48},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":172,"effect_pos":131,"light_pos":49},
  {"name":"F6","x":342,"y":0,"width":44,"height":44,"display":true,"value":"0x3f","pos":176,"effect_pos":134,"light_pos":50},
  {"name":"7","x":319,"y":57,"width":44,"height":44,"display":true,"value":"0x24","pos":180,"effect_pos":137,"light_pos":51},
  {"name":"U","x":341,"y":102,"width":44,"height":44,"display":true,"value":"0x18","pos":184,"effect_pos":140,"light_pos":52},
  {"name":"J","x":353,"y":148,"width":44,"height":44,"display":true,"value":"0xd","pos":188,"effect_pos":143,"light_pos":53},
  {"name":"N","x":320,"y":193,"width":44,"height":44,"display":true,"value":"0x11","pos":192,"effect_pos":146,"light_pos":54},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":196,"effect_pos":149,"light_pos":55},
  {"name":"F7","x":387,"y":0,"width":44,"height":44,"display":true,"value":"0x40","pos":200,"effect_pos":152,"light_pos":56},
  {"name":"8","x":364,"y":57,"width":44,"height":44,"display":true,"value":"0x25","pos":204,"effect_pos":155,"light_pos":57},
  {"name":"I","x":386,"y":102,"width":44,"height":44,"display":true,"value":"0xc","pos":208,"effect_pos":158,"light_pos":58},
  {"name":"K","x":398,"y":148,"width":44,"height":44,"display":true,"value":"0xe","pos":212,"effect_pos":161,"light_pos":59},
  {"name":"M","x":366,"y":193,"width":44,"height":44,"display":true,"value":"0x10","pos":216,"effect_pos":164,"light_pos":60},
  {"name":"R_Alt","x":456,"y":239,"width":55,"height":44,"display":true,"value":"0x400000","pos":220,"effect_pos":167,"light_pos":61},
  {"name":"F8","x":432,"y":0,"width":44,"height":44,"display":true,"value":"0x41","pos":224,"effect_pos":170,"light_pos":62},
  {"name":"9","x":410,"y":57,"width":44,"height":44,"display":true,"value":"0x26","pos":228,"effect_pos":173,"light_pos":63},
  {"name":"O","x":432,"y":102,"width":44,"height":44,"display":true,"value":"0x12","pos":232,"effect_pos":176,"light_pos":64},
  {"name":"L","x":443,"y":148,"width":44,"height":44,"display":true,"value":"0xf","pos":236,"effect_pos":179,"light_pos":65},
  {"name":"<,","x":412,"y":193,"width":44,"height":44,"display":true,"value":"0x36","pos":240,"effect_pos":182,"light_pos":66},
  {"name":"Fn","x":513,"y":239,"width":55,"height":44,"display":true,"value":"0xd000000","pos":244,"effect_pos":185,"light_pos":67},
  {"name":"F9","x":500,"y":0,"width":44,"height":44,"display":true,"value":"0x42","pos":248,"effect_pos":188,"light_pos":68},
  {"name":"0","x":455,"y":57,"width":44,"height":44,"display":true,"value":"0x27","pos":252,"effect_pos":191,"light_pos":69},
  {"name":"P","x":478,"y":102,"width":44,"height":44,"display":true,"value":"0x13","pos":256,"effect_pos":194,"light_pos":70},
  {"name":":;","x":489,"y":148,"width":44,"height":44,"display":true,"value":"0x33","pos":260,"effect_pos":197,"light_pos":71},
  {"name":">.","x":457,"y":193,"width":44,"height":44,"display":true,"value":"0x37","pos":264,"effect_pos":200,"light_pos":72},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":268,"effect_pos":203,"light_pos":73},
  {"name":"F10","x":547,"y":0,"width":44,"height":44,"display":true,"value":"0x43","pos":272,"effect_pos":206,"light_pos":74},
  {"name":"-_","x":501,"y":57,"width":44,"height":44,"display":true,"value":"0x2d","pos":276,"effect_pos":209,"light_pos":75},
  {"name":"[{","x":524,"y":102,"width":44,"height":44,"display":true,"value":"0x2f","pos":280,"effect_pos":212,"light_pos":76},
  {"name":"'","x":535,"y":148,"width":44,"height":44,"display":true,"value":"0x34","pos":284,"effect_pos":215,"light_pos":77},
  {"name":"/?","x":503,"y":193,"width":44,"height":44,"display":true,"value":"0x38","pos":288,"effect_pos":218,"light_pos":78},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":292,"effect_pos":221,"light_pos":79},
  {"name":"F11","x":592,"y":0,"width":44,"height":44,"display":true,"value":"0x44","pos":296,"effect_pos":224,"light_pos":80},
  {"name":"=+","x":546,"y":57,"width":44,"height":44,"display":true,"value":"0x2e","pos":300,"effect_pos":227,"light_pos":81},
  {"name":"]}","x":570,"y":102,"width":44,"height":44,"display":true,"value":"0x30","pos":304,"effect_pos":230,"light_pos":82},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x32","pos":308,"effect_pos":233,"light_pos":83},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":312,"effect_pos":236,"light_pos":84},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":316,"effect_pos":239,"light_pos":85},
  {"name":"F12","x":638,"y":0,"width":44,"height":44,"display":true,"value":"0x45","pos":320,"effect_pos":242,"light_pos":86},
  {"name":"Back","x":592,"y":57,"width":88,"height":44,"display":true,"value":"0x2a","pos":324,"effect_pos":245,"light_pos":87},
  {"name":"|","x":615,"y":102,"width":66,"height":44,"display":true,"value":"0x31","pos":328,"effect_pos":248,"light_pos":88},
  {"name":"Enter","x":581,"y":148,"width":99,"height":44,"display":true,"value":"0x28","pos":332,"effect_pos":251,"light_pos":89},
  {"name":"R_shift","x":548,"y":193,"width":88,"height":44,"display":true,"value":"0x200000","pos":336,"effect_pos":254,"light_pos":90},
  {"name":"left","x":592,"y":239,"width":44,"height":44,"display":true,"value":"0x50","pos":340,"effect_pos":257,"light_pos":91},
  {"name":"volume-up","x":890,"y":0,"width":44,"height":44,"display":false,"value":"0x20000e9","pos":344,"effect_pos":260,"light_pos":92},
  {"name":"volume-down","x":958,"y":228,"width":44,"height":44,"display":false,"value":"0x20000ea","pos":348,"effect_pos":263,"light_pos":93},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x700001d","pos":352,"effect_pos":266,"light_pos":94},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":356,"effect_pos":269,"light_pos":95},
  {"name":"Up","x":638,"y":192,"width":44,"height":44,"display":true,"value":"0x52","pos":360,"effect_pos":272,"light_pos":96},
  {"name":"Down","x":638,"y":239,"width":44,"height":44,"display":true,"value":"0x51","pos":364,"effect_pos":275,"light_pos":97},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":368,"effect_pos":278,"light_pos":98},
  {"name":"Del","x":684,"y":57,"width":44,"height":44,"display":true,"value":"0x4c","pos":372,"effect_pos":281,"light_pos":99},
  {"name":"PgUp","x":684,"y":101,"width":44,"height":44,"display":true,"value":"0x4b","pos":376,"effect_pos":284,"light_pos":100},
  {"name":"PgDn","x":684,"y":145,"width":44,"height":44,"display":true,"value":"0x4e","pos":380,"effect_pos":287,"light_pos":101},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":384,"effect_pos":290,"light_pos":102},
  {"name":"right","x":684,"y":239,"width":44,"height":44,"display":true,"value":"0x4f","pos":388,"effect_pos":293,"light_pos":103},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":392,"effect_pos":296,"light_pos":104},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":396,"effect_pos":299,"light_pos":105},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":400,"effect_pos":302,"light_pos":106},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":404,"effect_pos":305,"light_pos":107},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":408,"effect_pos":308,"light_pos":108},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":412,"effect_pos":311,"light_pos":109},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":416,"effect_pos":314,"light_pos":110},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":420,"effect_pos":317,"light_pos":111},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":424,"effect_pos":320,"light_pos":112},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":428,"effect_pos":323,"light_pos":113},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":432,"effect_pos":326,"light_pos":114},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":436,"effect_pos":329,"light_pos":115},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":440,"effect_pos":332,"light_pos":116},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":444,"effect_pos":335,"light_pos":117},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":448,"effect_pos":338,"light_pos":118},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":452,"effect_pos":341,"light_pos":119},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":456,"effect_pos":344,"light_pos":120},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":460,"effect_pos":347,"light_pos":121},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":464,"effect_pos":350,"light_pos":122},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":468,"effect_pos":353,"light_pos":123},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":472,"effect_pos":356,"light_pos":124},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":476,"effect_pos":359,"light_pos":125},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":480,"effect_pos":362,"light_pos":126},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":484,"effect_pos":365,"light_pos":127},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":488,"effect_pos":368,"light_pos":128},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":492,"effect_pos":371,"light_pos":129},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":496,"effect_pos":374,"light_pos":130},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":500,"effect_pos":377,"light_pos":131},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":504,"effect_pos":380,"light_pos":132},
  {"name":"","x":0,"y":0,"width":44,"height":44,"display":false,"value":"0x0","pos":508,"effect_pos":383,"light_pos":133}
] as const;

/** catalogModel values that share the K1 Pro layout (regional variants TBD). */
export const K1_PRO_LAYOUT_MODELS: readonly string[] = ['916_K1_PRO'];

/** Pixel bounds of the displayed keys (vendor `g()` in commom-*.js). */
export function layoutBounds(blocks: readonly KeyBlock[]): { width: number; height: number } {
  const shown = blocks.filter((b) => b.display);
  if (shown.length === 0) return { width: 0, height: 0 };
  const unit = shown.find((b) => b.width === b.height)?.width ?? 44;
  const maxX = Math.max(...shown.map((b) => b.x));
  const maxY = Math.max(...shown.map((b) => b.y));
  return { width: maxX + unit, height: maxY + unit };
}
