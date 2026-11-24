/**
 * Unit tests for `src/keymap-diff.ts` — the full-system staged-change
 * diff behind the Keys page "Review changes" panel and the Apply
 * confirmation summary (bead xbp). Runs under Node's native TS
 * stripping:
 *
 *   node scripts/test-keymap-diff.ts
 *
 * No DOM, no device: committed values come from an in-memory table and
 * staged state from a real `StagedEdits` instance, so the diff is
 * exercised against live stage/undo/redo/clear transitions.
 */

declare const process: { exit(code?: number): never };

import { StagedEdits } from '../src/remap-edit.ts';
import {
  buildKeymapDiff,
  diffSummary,
  diffValueLabel,
  keymapArgLabel,
  keymapArgSystem,
} from '../src/keymap-diff.ts';

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
const committedFn = (arg: number, index: number): number =>
  committed.get(arg)?.get(index) ?? 0;

const edits = new StagedEdits(committedFn);

section('empty diff');
let diff = buildKeymapDiff(edits, committedFn);
check('no groups', diff.groups.length === 0);
check('zero changes', diff.totalChanges === 0 && diff.affectedArgs === 0);
check('empty summary', diffSummary(diff) === 'no pending key changes');

section('single-arg diff');
edits.stage(0, new Map([[4, 0x00000007], [9, 0x0000001e]]));
diff = buildKeymapDiff(edits, committedFn);
check('one group', diff.affectedArgs === 1 && diff.groups.length === 1);
check('two changes', diff.totalChanges === 2);
check('group arg', diff.groups[0]?.arg === 0);
check('sorted by index', diff.groups[0]?.changes.map((c) => c.index).join(',') === '4,9');
check('old value captured', diff.groups[0]?.changes[0]?.oldValue === 4);
check('new value captured', diff.groups[0]?.changes[0]?.newValue === 7);
check(
  'single-arg summary',
  diffSummary(diff) === '2 keys on Key set 1',
  diffSummary(diff),
);

section('multi-arg diff (user + system)');
edits.stage(1, new Map([[4, 0x0000002d]])); // arg1: space → enter-ish
edits.stage(4, new Map([[4, 0x0000001d]])); // arg4: 'a' → 'z'-ish
diff = buildKeymapDiff(edits, committedFn);
check('three args', diff.affectedArgs === 3 && diff.totalChanges === 4);
check('groups ascending', diff.groups.map((g) => g.arg).join(',') === '0,1,4');
check(
  'multi summary',
  diffSummary(diff) === '4 keys across 3 key sets',
  diffSummary(diff),
);
check('arg labels', keymapArgLabel(0) === 'Key set 1' && keymapArgLabel(4) === 'System key set 1');
check('arg systems', keymapArgSystem(3) === 'user' && keymapArgSystem(4) === 'system');

section('live updates: undo / redo / clear / revert');
edits.undo(); // removes arg4 staging
diff = buildKeymapDiff(edits, committedFn);
check('undo shrinks diff', diff.totalChanges === 3 && diff.affectedArgs === 2);
edits.redo();
check('redo restores diff', buildKeymapDiff(edits, committedFn).totalChanges === 4);
edits.clearLayer(1);
check('clearLayer removes arg', buildKeymapDiff(edits, committedFn).affectedArgs === 2);
edits.undo(); // restore arg1 staging
check('undo restores group', buildKeymapDiff(edits, committedFn).totalChanges === 4);
// Revert one slot to committed → it leaves the diff entirely.
edits.stage(0, new Map([[4, null]]));
diff = buildKeymapDiff(edits, committedFn);
check('reverted slot gone', diff.groups[0]?.changes.length === 1);
check('remaining is index 9', diff.groups[0]?.changes[0]?.index === 9);

section('singular summary');
const e1 = new StagedEdits(committedFn);
e1.stage(2, new Map([[7, 0x1234]]));
const d1 = buildKeymapDiff(e1, committedFn);
check('one key', diffSummary(d1) === '1 key on Key set 3', diffSummary(d1));
check('empty committed → old 0', d1.groups[0]?.changes[0]?.oldValue === 0);

section('value labels');
check('usage label non-empty', diffValueLabel(0x00000004) !== '');
check('zero → empty', diffValueLabel(0) === '');
check('exotic raw still labelled', typeof diffValueLabel(0x80700) === 'string');

section('dropWritten keeps diff honest');
// Fresh store so earlier sections' pending state can't leak in.
const eDw = new StagedEdits(committedFn);
eDw.stage(0, new Map([[4, 9], [5, 10]]));
eDw.stage(1, new Map([[4, 11]]));
eDw.dropWritten(0, [4]);
let dwDiff = buildKeymapDiff(eDw, committedFn);
check('written arg still has remainder', dwDiff.totalChanges === 2 && dwDiff.affectedArgs === 2);
check('written slot left the diff', !dwDiff.groups[0]?.changes.some((c) => c.index === 4));
eDw.dropWritten(0, [5]);
eDw.dropWritten(1, [4]);
dwDiff = buildKeymapDiff(eDw, committedFn);
check('all written → empty diff', dwDiff.totalChanges === 0 && dwDiff.affectedArgs === 0);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
