/**
 * Node smoke test for `src/lighting-scenes.ts` — the pure scene logic
 * (parse/validate/serialise/preview/storage-shape). DOM helpers are not
 * exercised. Run: `npm run smoke` (node >= 22.18, native TS stripping).
 */

declare const process: { exit(code?: number): never };

import {
  CUSTOM_LIGHT_SLOTS,
  LIGHT_MODES,
  rgbToHex,
} from '../src/proto/light.ts';
import {
  parseSceneConfig,
  sceneConfigToJson,
  parseSceneFile,
  sceneFileName,
  sceneFileText,
  sceneIssues,
  scenePreviewColors,
  sceneSummary,
  sceneSwatchCss,
  validSceneName,
  type LightingSceneConfig,
  type StoredLightingScene,
} from '../src/lighting-scenes.ts';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name} ${extra}`);
  }
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// ── parseSceneConfig ───────────────────────────────────────────────────

const good: LightingSceneConfig = {
  schema: 1,
  mode: 2, // breathing
  speed: 8,
  brightness: 12,
  color_model: 2,
  color: '#ff0000',
};

{
  const cfg = parseSceneConfig(JSON.stringify(good));
  check('parse json string', cfg.mode === 2 && cfg.speed === 8 && cfg.brightness === 12);
  check('parse keeps color', cfg.color === '#ff0000', String(cfg.color));

  const obj = parseSceneConfig({ schema: 1, mode: 277, speed: 0, brightness: 0 });
  check('parse bare object (custom mode)', obj.mode === 277);

  check('rejects bad json', throws(() => parseSceneConfig('{nope')));
  check('rejects non-object', throws(() => parseSceneConfig('42')));
  check('rejects wrong schema', throws(() => parseSceneConfig({ schema: 2, mode: 1, speed: 0, brightness: 0 })));
  check('rejects missing mode', throws(() => parseSceneConfig({ schema: 1, speed: 0, brightness: 0 })));
  check('rejects speed > 20', throws(() => parseSceneConfig({ schema: 1, mode: 2, speed: 21, brightness: 0 })));
  check('rejects negative brightness', throws(() => parseSceneConfig({ schema: 1, mode: 2, speed: 0, brightness: -1 })));
  check('rejects bad colour', throws(() => parseSceneConfig({ ...good, color: 'blue' })));
  check('rejects colour_model 3', throws(() => parseSceneConfig({ ...good, color_model: 3 })));

  const keys = Array.from({ length: CUSTOM_LIGHT_SLOTS }, (_, i) => rgbToHex({ r: i & 0xff, g: 0, b: 0 }));
  const withKeys = parseSceneConfig({ schema: 1, mode: 277, speed: 0, brightness: 0, keys: { colors: keys } });
  check('parse 126 key colours', withKeys.keys?.colors.length === CUSTOM_LIGHT_SLOTS);
  check('key colours canonicalised', withKeys.keys?.colors[1] === '#010000', String(withKeys.keys?.colors[1]));
  check('rejects short keys table', throws(() =>
    parseSceneConfig({ schema: 1, mode: 277, speed: 0, brightness: 0, keys: { colors: keys.slice(1) } })));
  check('rejects keys without colors', throws(() =>
    parseSceneConfig({ schema: 1, mode: 277, speed: 0, brightness: 0, keys: {} })));
}

// ── serialise round-trip ───────────────────────────────────────────────

{
  const json = sceneConfigToJson(good);
  const back = parseSceneConfig(json);
  check('round-trip mode', back.mode === good.mode);
  check('round-trip speed', back.speed === good.speed);
  check('round-trip brightness', back.brightness === good.brightness);
  check('round-trip colour', back.color === good.color);
  check('round-trip colour_model', back.color_model === good.color_model);
  check('json has schema', JSON.parse(json).schema === 1);
}

// ── summary / issues ───────────────────────────────────────────────────

{
  check('summary mentions mode', /Breathing/i.test(sceneSummary(good)), sceneSummary(good));
  check('summary mentions params', sceneSummary(good).includes('speed 8'));

  const off = parseSceneConfig({ schema: 1, mode: 0, speed: 0, brightness: 0 });
  check('off scene warns', sceneIssues(off).some((i) => /off/i.test(i)), sceneIssues(off).join('|'));

  const unknown = parseSceneConfig({ schema: 1, mode: 999, speed: 0, brightness: 0 });
  check('unknown mode warns', sceneIssues(unknown).some((i) => /not in the known/.test(i)));

  const rainbow = parseSceneConfig({ schema: 1, mode: 3, speed: 4, brightness: 9, color: '#00ff00' });
  check('colour on multi-mode warns', sceneIssues(rainbow).some((i) => /single-colour/.test(i)));

  const breathing = parseSceneConfig({ schema: 1, mode: 2, speed: 4, brightness: 9 });
  check('clean scene no issues', sceneIssues(breathing).length === 0, sceneIssues(breathing).join('|'));
}

// ── preview ────────────────────────────────────────────────────────────

{
  const solid = parseSceneConfig({ schema: 1, mode: 2, speed: 0, brightness: 0, color: '#ff0000' });
  const cols = scenePreviewColors(solid, 8);
  check('solid preview length', cols.length === 8);
  check('solid preview colour', cols.every((c) => c.r === 255 && c.g === 0 && c.b === 0));
  check('swatch css is gradient', sceneSwatchCss(solid).startsWith('linear-gradient'));

  const keys = Array.from({ length: CUSTOM_LIGHT_SLOTS }, (_, i) =>
    rgbToHex({ r: Math.round((i / (CUSTOM_LIGHT_SLOTS - 1)) * 255), g: 0, b: 255 - Math.round((i / (CUSTOM_LIGHT_SLOTS - 1)) * 255) }));
  const keyed = parseSceneConfig({ schema: 1, mode: 277, speed: 0, brightness: 0, keys: { colors: keys } });
  const kcols = scenePreviewColors(keyed, 8);
  check('keys preview length', kcols.length === 8);
  check('keys preview spans range', kcols[0]!.r < 60 && kcols[kcols.length - 1]!.r > 200,
    `${kcols[0]!.r}→${kcols[kcols.length - 1]!.r}`);

  const multi = parseSceneConfig({ schema: 1, mode: 3, speed: 0, brightness: 0 });
  const mcols = scenePreviewColors(multi, 8);
  check('multi preview varies', new Set(mcols.map((c) => `${c.r},${c.g},${c.b}`)).size > 4);

  const off = parseSceneConfig({ schema: 1, mode: 0, speed: 0, brightness: 0 });
  check('off preview black', scenePreviewColors(off, 4).every((c) => c.r === 0 && c.g === 0 && c.b === 0));
}

// ── files ──────────────────────────────────────────────────────────────

{
  const rec: StoredLightingScene = { name: 'My Scene!', savedAt: 1700000000000, config: good };
  const text = sceneFileText(rec);
  const parsed = parseSceneFile(text);
  check('file round-trip name', parsed.name === 'My Scene!');
  check('file round-trip mode', parsed.config.mode === 2);

  const bare = parseSceneFile(sceneConfigToJson(good));
  check('bare config accepted', bare.name === null && bare.config.speed === 8);

  check('file name slug', sceneFileName('My Scene!') === 'omg-lighting-my-scene.json', sceneFileName('My Scene!'));
  check('file name fallback', sceneFileName('   ') === 'omg-lighting-scene.json');

  check('rejects non-json file', throws(() => parseSceneFile('not json')));
  check('rejects bad wrapped config', throws(() =>
    parseSceneFile(JSON.stringify({ omg_lighting_scene: 1, name: 'x', config: { mode: 'a' } }))));
}

// ── names ──────────────────────────────────────────────────────────────

check('valid name ok', validSceneName('  Rain  ') === null);
check('empty name rejected', validSceneName('   ') !== null);
check('long name rejected', validSceneName('x'.repeat(60)) !== null);

// Every LIGHT_MODES id must parse as a scene mode.
for (const m of LIGHT_MODES) {
  const cfg = parseSceneConfig({ schema: 1, mode: m.id, speed: 0, brightness: 0 });
  if (cfg.mode !== m.id) {
    check(`mode ${m.id} round-trips`, false);
  }
}
check('all 18 mode ids parse', true);

console.log(failures === 0 ? '\nAll scene smoke checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
