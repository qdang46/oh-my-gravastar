/**
 * Unit tests for `src/remap-edit.ts` — the staged-edit/undo model behind
 * the Keymap Studio (bead c8y). Runs under Node's native TS stripping:
 *
 *   node scripts/test-remap-edit.ts
 *
 * No DOM, no device: committed values come from an in-memory table.
 */

declare const process: { exit(code?: number): never };

import { StagedEdits } from '../src/remap-edit.ts';

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

// Committed table: arg → index → u32 (missing = 0).
const committed = new Map<number, Map<number, number>>([
  [0, new Map([[4, 0x00000004], [5, 0x00000005]])], // arg0: key4='a', key5='b'
  [1, new Map([[4, 0x0000002c]])], // arg1: key4=space
  [4, new Map([[4, 0x00000004]])], // arg4 (system layer0): key4='a'
]);

const edits = new StagedEdits((arg, index) => committed.get(arg)?.get(index) ?? 0);

section('stage / effective / pending');
check('no pending initially', edits.pendingCount(0) === 0);
check('effective falls back to committed', edits.effective(0, 4) === 4);
check('uncommitted slot reads 0', edits.effective(0, 9) === 0);

edits.stage(0, new Map([[4, 0x00000007]])); // key4 → 'd' usage
check('staged value wins', edits.effective(0, 4) === 7);
check('pending count 1', edits.pendingCount(0) === 1);
check('other slots untouched', edits.effective(0, 5) === 5);
check('can undo', edits.canUndo());

section('staging committed value reverts');
check('stage committed → no pending', !edits.stage(0, new Map([[5, 5]])));
check('still 1 pending', edits.pendingCount(0) === 1);
check('revert pending slot', edits.stage(0, new Map([[4, null]])));
check('pending empty after revert', edits.pendingCount(0) === 0);
check('effective back to committed', edits.effective(0, 4) === 4);

section('multi-key stage = one undo step');
edits.stage(0, new Map([[4, 30], [5, 31], [9, 40]]));
check('3 pending', edits.pendingCount(0) === 3);
edits.undo();
check('undo clears all 3', edits.pendingCount(0) === 0);
check('effective restored', edits.effective(0, 4) === 4 && edits.effective(0, 9) === 0);
check('can redo', edits.canRedo());
edits.redo();
check('redo restores 3', edits.pendingCount(0) === 3 && edits.effective(0, 9) === 40);
check('redo clears redo stack', !edits.canRedo());

section('undo/redo ordering');
// Fresh instance so earlier sections' history can't leak in.
const eOrd = new StagedEdits((a, i) => committed.get(a)?.get(i) ?? 0);
eOrd.stage(0, new Map([[4, 30], [5, 31], [9, 40]]));
eOrd.stage(0, new Map([[4, 100]]));
eOrd.undo(); // pops the {4:100} op; index4 returns to its pre-stage value 30
check('undo pops newest', eOrd.effective(0, 4) === 30);
check('older edit still staged', eOrd.effective(0, 9) === 40);
eOrd.undo(); // pops the multi-key op → all three slots revert
check('second undo empties', eOrd.pendingCount(0) === 0);
eOrd.undo();
check('undo on empty is noop', eOrd.pendingCount(0) === 0 && !eOrd.canUndo());

section('new stage clears redo');
const eRedo = new StagedEdits((a, i) => committed.get(a)?.get(i) ?? 0);
eRedo.stage(0, new Map([[4, 7]]));
eRedo.undo();
check('redo available', eRedo.canRedo());
eRedo.stage(0, new Map([[5, 8]]));
check('new edit clears redo', !eRedo.canRedo());
eRedo.clearHistory();

section('clearLayer (reset-to-read / discard)');
edits.stage(0, new Map([[4, 1], [5, 2]]));
edits.stage(1, new Map([[4, 9]]));
check('clearLayer returns true', edits.clearLayer(0));
check('arg0 cleared', edits.pendingCount(0) === 0);
check('arg1 untouched', edits.pendingCount(1) === 1);
edits.undo();
// arg0 had {4:1, 5:2, 9:40} pending (9 carried over from the redo) → all back.
check('undo restores cleared layer', edits.pendingCount(0) === 3);
edits.clearHistory();

section('copyLayer');
edits.clearHistory();
// arg0 currently clean; stage source values on arg1 first.
edits.stage(1, new Map([[4, 0x11223344], [6, 55]]));
check('planCopy same arg → null', edits.planCopy(1, 1) === null);
const n = edits.copyLayer(1, 0);
check('copy staged >0 slots', n > 0, `got ${n}`);
check('dst matches src effective', edits.effective(0, 4) === 0x11223344);
check('dst untouched slot copied', edits.effective(0, 6) === 55);
// arg1 key5 is empty while arg0 key5='b' → the copy stages an unassign (0).
check('dst extra key staged to empty', edits.effective(0, 5) === 0);
check('dst untouched-by-src slot stays clean', !edits.pendingView(0).has(7));
check('src pending preserved', edits.pendingView(1).get(4) === 0x11223344);
edits.undo();
// dst had pending {4:1, 5:2, 9:40} before the copy → undo restores those.
check('undo copy restores dst', edits.effective(0, 4) === 1 && edits.effective(0, 5) === 2);
edits.clearHistory();

section('copyLayer identical → 0 / same arg → -1');
edits.clearHistory();
const e2 = new StagedEdits((a, i) => committed.get(a)?.get(i) ?? 0);
check('copy same arg → -1', e2.copyLayer(2, 2) === -1);
const c1 = e2.copyLayer(0, 1);
check('copy stages diffs', c1 > 0, `got ${c1}`);
check('identical re-copy stages 0', e2.copyLayer(0, 1) === 0);

section('dropWritten + clearHistory');
edits.clearHistory();
edits.stage(0, new Map([[4, 9], [5, 10]]));
edits.dropWritten(0, [4]);
check('written slot dropped', !edits.pendingView(0).has(4));
check('other slot remains', edits.pendingView(0).has(5));
edits.clearHistory();
check('history cleared', !edits.canUndo() && !edits.canRedo());

section('history cap');
const e3 = new StagedEdits((a, i) => 0, 3);
for (let i = 0; i < 6; i++) e3.stage(0, new Map([[i, i + 1]]));
e3.undo();
e3.undo();
e3.undo();
check('cap keeps newest 3 undoable', e3.canUndo() === false);
check('oldest edits dropped', e3.effective(0, 0) === 1);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
