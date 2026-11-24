/**
 * Unit tests for `src/layout-model.ts` — the physical/visual/mapping
 * separation behind the layout editor (bead oh-my-gravastar-aur).
 * Pure module tests under Node's native TS stripping:
 *
 *   npm test        (node scripts/test-layout.ts)
 *
 * Covers: physical table integrity (all catalog models resolve, pos →
 * keyIndex mapping, unique ids), visual override resolution, JSON
 * import/export round-trip, validation errors/warnings (unknown keys,
 * bounds, overlaps), and localStorage persistence via memoryStorage.
 */

declare const process: { exit(code?: number): never };

import {
  PHYSICAL_LAYOUTS,
  emptyVisualDoc,
  findOverlaps,
  layoutStorageKey,
  loadVisualLayout,
  physicalBounds,
  physicalLayoutById,
  physicalLayoutForModel,
  resolveVisual,
  saveVisualLayout,
  validateVisualLayout,
  visualBounds,
  visualLayoutToJson,
  type VisualLayoutDoc,
} from '../src/layout-model.ts';
import { memoryStorage } from '../src/safety/index.ts';
import { CATALOG } from '../src/proto/khub916.ts';

let failures = 0;
function check(name: string, cond: unknown, extra = ''): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name} ${extra}`);
  }
}
function section(title: string): void {
  console.log(`\n== ${title}`);
}

const K1PRO = physicalLayoutById('916_K1_PRO');

// ── Physical tables ────────────────────────────────────────────────────

section('physical layouts');

check('at least one physical layout registered', PHYSICAL_LAYOUTS.length > 0);
check('K1 Pro table resolves', K1PRO !== undefined);
check('K1 Pro has 126 keymap slots', K1PRO?.keys.length === 126);
check(
  'every GravaStar catalog model resolves a layout',
  CATALOG.filter((c) => c.model.startsWith('916_')).every(
    (c) => physicalLayoutForModel(c.model) !== undefined,
  ),
);
check(
  'physicalLayoutForModel(916_K1_PRO) → 916_K1_PRO',
  physicalLayoutForModel('916_K1_PRO')?.id === '916_K1_PRO',
);
check(
  'physicalLayoutForModel(unknown) → undefined',
  physicalLayoutForModel('not-a-model') === undefined &&
    physicalLayoutForModel(null) === undefined,
);
check(
  'key ids are unique k<n> and match pos = 8 + n*4',
  K1PRO !== undefined &&
    K1PRO.keys.every((k) => k.id === `k${k.keyIndex}` && k.pos === 8 + k.keyIndex * 4),
);
check(
  'display keys have positive size; hidden slots flagged',
  K1PRO !== undefined &&
    K1PRO.keys.some((k) => k.display && k.width > 0) &&
    K1PRO.keys.some((k) => !k.display),
);
{
  const b = K1PRO ? physicalBounds(K1PRO) : { width: 0, height: 0 };
  check('K1 Pro bounds are plausible (~730x283)', b.width > 600 && b.width < 900 && b.height > 250 && b.height < 400, JSON.stringify(b));
}

// ── Resolve ────────────────────────────────────────────────────────────

section('resolveVisual');

if (K1PRO) {
  const esc = K1PRO.keys.find((k) => k.keyIndex === 0);
  const resolved = resolveVisual(K1PRO, null);
  check('no overrides → physical geometry', resolved.length === K1PRO.keys.length);
  check(
    'ESC resolves at physical pos with factory legend',
    resolved[0]?.id === esc?.id && resolved[0]?.vx === esc?.x && resolved[0]?.legend === 'ESC',
  );

  const doc: VisualLayoutDoc = {
    schema: 1,
    layout: '916_K1_PRO',
    model: '916_K1_PRO',
    keys: {
      k0: { x: 10, y: 20, w: 50, h: 40, rotation: 370, legend: 'MY ESC', hidden: false },
      k1: { legend: '' },
    },
  };
  const r2 = resolveVisual(K1PRO, doc);
  const escR = r2.find((k) => k.id === 'k0');
  check('override x/y/w/h applied', escR?.vx === 10 && escR?.vy === 20 && escR?.vw === 50 && escR?.vh === 40);
  check('rotation normalized to [0,360)', escR?.rotation === 10);
  check('custom legend applied', escR?.legend === 'MY ESC');
  const k1 = r2.find((k) => k.id === 'k1');
  check('empty legend → blank', k1?.legend === '');

  const hiddenDoc: VisualLayoutDoc = {
    schema: 1,
    layout: '916_K1_PRO',
    model: null,
    keys: { k0: { hidden: true } },
  };
  const r3 = resolveVisual(K1PRO, hiddenDoc);
  check('hidden flag applied', r3.find((k) => k.id === 'k0')?.hidden === true);
  const b = visualBounds(r3);
  check('visualBounds shrinks when a corner key is hidden', b.width <= physicalBounds(K1PRO).width);
}

// ── Overlap detection ──────────────────────────────────────────────────

section('findOverlaps');

if (K1PRO) {
  const phys = resolveVisual(K1PRO, null);
  check('physical layout has no overlaps', findOverlaps(phys).length === 0);
  const doc: VisualLayoutDoc = {
    schema: 1,
    layout: '916_K1_PRO',
    model: null,
    keys: { k0: { x: 0, y: 0 }, k36: { x: 0, y: 0 } }, // move "1" onto ESC
  };
  const r = resolveVisual(K1PRO, doc);
  const ov = findOverlaps(r);
  check('moved key overlaps detected', ov.some((p) => (p.a === 'k0' && p.b === 'k36') || (p.a === 'k36' && p.b === 'k0')), JSON.stringify(ov.slice(0, 3)));
}

// ── Validation ─────────────────────────────────────────────────────────

section('validateVisualLayout');

check('rejects non-object', validateVisualLayout('42').ok === false);
check('rejects bad JSON string', validateVisualLayout('{nope').ok === false);
check('rejects wrong schema', validateVisualLayout({ schema: 2, layout: '916_K1_PRO', keys: {} }).ok === false);
check(
  'rejects unknown layout id',
  validateVisualLayout({ schema: 1, layout: 'nope', keys: {} }).ok === false,
);
{
  const v = validateVisualLayout(
    { schema: 1, layout: '916_K1_PRO', keys: { k999: { x: 1 } } },
    K1PRO,
  );
  check('rejects unknown key id', v.ok === false && v.errors.some((e) => e.includes('k999')), JSON.stringify(v.errors));
}
{
  const v = validateVisualLayout(
    { schema: 1, layout: '916_K1_PRO', keys: { k0: { x: 'a', w: -5, legend: 3, hidden: 'yes' } } },
    K1PRO,
  );
  check(
    'collects all field errors',
    v.ok === false &&
      v.errors.filter((e) => e.startsWith('keys.k0')).length >= 4,
    JSON.stringify(v.errors),
  );
}
{
  const v = validateVisualLayout(
    { schema: 1, layout: '916_K1_PRO', keys: { k0: { x: 0, y: 0 }, k36: { x: 0, y: 0 } } },
    K1PRO,
  );
  check('overlap is a warning not an error', v.ok === true && v.warnings.some((w) => w.includes('overlap')), JSON.stringify(v.warnings));
}
{
  const v = validateVisualLayout(
    { schema: 1, layout: '916_K1_PRO', keys: { k0: { x: -99999 } } },
    K1PRO,
  );
  check('out-of-range coord is an error', v.ok === false);
}
{
  const v = validateVisualLayout(
    { schema: 1, layout: '916_K1_PRO', model: '916_K1_PRO', keys: { k0: { legend: 'Hi', rotation: 725 } } },
    K1PRO,
  );
  check('valid doc passes with normalized rotation', v.ok === true && v.doc?.keys.k0?.rotation === 5, JSON.stringify(v));
}
{
  // schema-only check without physical: unknown keys tolerated
  const v = validateVisualLayout({ schema: 1, layout: '916_K1', keys: { k0: { x: 1 } } });
  check('validates without physical context', v.ok === true && v.doc?.layout === '916_K1');
}

// ── Export / import round-trip ─────────────────────────────────────────

section('JSON round-trip');

if (K1PRO) {
  const doc: VisualLayoutDoc = {
    schema: 1,
    layout: '916_K1_PRO',
    model: '916_K1_PRO',
    keys: { k0: { x: 5, legend: 'ESC!' }, k1: { hidden: true } },
  };
  const json = visualLayoutToJson(doc);
  const v = validateVisualLayout(json, K1PRO);
  check('exported JSON re-validates', v.ok === true && v.doc !== undefined);
  check(
    'round-trip preserves overrides',
    v.doc?.keys.k0?.x === 5 && v.doc?.keys.k0?.legend === 'ESC!' && v.doc?.keys.k1?.hidden === true,
  );
}

// ── Persistence ────────────────────────────────────────────────────────

section('localStorage persistence');

{
  const storage = memoryStorage();
  const doc: VisualLayoutDoc = {
    schema: 1,
    layout: '916_K1_PRO',
    model: '916_K1_PRO',
    keys: { k0: { x: 42 } },
  };
  saveVisualLayout(doc, storage);
  check(
    'storage key is model+layout scoped',
    layoutStorageKey('916_K1_PRO', '916_K1_PRO') === 'omg.layout.v1.916_K1_PRO.916_K1_PRO' &&
      storage.getItem(layoutStorageKey('916_K1_PRO', '916_K1_PRO')) !== null,
  );
  const back = loadVisualLayout('916_K1_PRO', '916_K1_PRO', storage);
  check('load returns saved doc', back?.keys.k0?.x === 42);
  check('different model does not see it', loadVisualLayout('916_K1', '916_K1_PRO', storage) === null);
  check('different layout does not see it', loadVisualLayout('916_K1_PRO', '916_K1', storage) === null);

  // Corrupt entry → null, not a throw.
  storage.setItem(layoutStorageKey('916_K1_PRO', '916_K1_PRO'), '{broken');
  check('corrupt JSON loads as null', loadVisualLayout('916_K1_PRO', '916_K1_PRO', storage) === null);

  // Empty doc round-trips.
  saveVisualLayout(emptyVisualDoc('916_K1', '916_K1'), storage);
  check('empty doc persists', loadVisualLayout('916_K1', '916_K1', storage)?.keys !== undefined);
}

console.log(failures === 0 ? '\nall layout tests passed' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
