/**
 * Unit tests for `src/edit-model.ts` (shared Edit → Preview → Apply →
 * Verify bar, bead sl3) and the Configure-key disclosure ordering in
 * `src/behavior-core.ts` (`splitBehaviorChoices` / `BEHAVIOR_CARDS`).
 * Runs under Node's native TS stripping:
 *
 *   node scripts/test-edit-model.ts
 *
 * No DOM, no device: the view model is a pure function and the catalog
 * is built literally, matching page usage.
 */

declare const process: { exit(code?: number): never };

import {
  EditSession,
  editBarViewModel,
  pendingBadgeText,
} from '../src/edit-model.ts';
import {
  BEHAVIOR_CARDS,
  behaviorCard,
  splitBehaviorChoices,
  type BehaviorOption,
} from '../src/behavior-core.ts';

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

section('pendingBadgeText');
check('zero → empty', pendingBadgeText(0) === '');
check('negative → empty', pendingBadgeText(-3) === '');
check('one → singular', pendingBadgeText(1) === '1 unsaved change');
check('many → plural', pendingBadgeText(7) === '7 unsaved changes');

section('editBarViewModel — clean state');
{
  const vm = editBarViewModel({ pending: 0 });
  check('badge hidden when clean', vm.badgeHidden === true && vm.badgeText === '');
  check('apply disabled when clean', vm.applyDisabled === true);
  check('discard disabled when clean', vm.discardDisabled === true);
  check('default apply label', vm.applyText === 'Save');
  check('default discard label', vm.discardText === 'Discard changes');
}

section('editBarViewModel — dirty state');
{
  const vm = editBarViewModel({ pending: 3 });
  check('badge shows count', vm.badgeText === '3 unsaved changes' && !vm.badgeHidden);
  check('apply enabled', vm.applyDisabled === false);
  check('discard enabled', vm.discardDisabled === false);
}

section('editBarViewModel — busy state');
{
  const vm = editBarViewModel({
    pending: 2,
    busy: true,
    applyLabel: (n, b) => (b ? 'Saving…' : `Save all (${n})`),
  });
  check('busy disables apply', vm.applyDisabled === true);
  check('busy disables discard', vm.discardDisabled === true);
  check('busy label honoured', vm.applyText === 'Saving…');
  const clean = editBarViewModel({ pending: 0, busy: true });
  check('busy+clean still disabled', clean.applyDisabled === true);
}

section('editBarViewModel — labels, note, extra gate');
{
  const vm = editBarViewModel({
    pending: 1,
    applyLabel: (n) => `Save all (${n})`,
    discardLabel: 'Discard',
    note: 'writes immediately on Apply',
    applyDisabled: true,
  });
  check('fn apply label', vm.applyText === 'Save all (1)');
  check('custom discard label', vm.discardText === 'Discard');
  check('note shown', vm.noteText === 'writes immediately on Apply' && !vm.noteHidden);
  check('page gate disables apply', vm.applyDisabled === true);
  check('page gate does not enable discard', vm.discardDisabled === false);
  const noNote = editBarViewModel({ pending: 1 });
  check('note hidden by default', noNote.noteHidden === true);
}

section('EditSession — dirty-state tracker');
{
  const s = new EditSession();
  check('starts clean', s.pending === 0 && !s.isDirty && !s.busy);
  s.setPending(4);
  check('setPending → dirty', s.pending === 4 && s.isDirty);
  s.setPending(1.9);
  check('setPending floors', s.pending === 1);
  s.setPending(-2);
  check('setPending clamps at 0', s.pending === 0 && !s.isDirty);
  s.setPending(Number.NaN);
  check('setPending NaN → 0', s.pending === 0);
  s.setBusy(true);
  check('busy flag', s.busy === true);
  s.setNote('hint');
  check('note', s.note === 'hint');
  s.reset();
  check('reset clears all', s.pending === 0 && !s.busy && s.note === '');
}

// ── Disclosure ordering (behavior-core) ───────────────────────────────

function opt(id: BehaviorOption['id'], group: BehaviorOption['group'], available = true): BehaviorOption {
  return { id, label: id, group, available, write: available ? 'staged' : 'none' };
}

section('splitBehaviorChoices — ordering + tiers');
{
  // Catalog order as behaviorCatalog() emits it: plain, mt, socd, tgl.
  const catalog = [
    opt('plain', 'action'),
    opt('mt', 'adv'),
    opt('socd', 'adv'),
    opt('tgl', 'adv'),
    opt('layer-tap', 'unavailable', false),
    opt('combo', 'unavailable', false),
  ];
  const { primary, advanced } = splitBehaviorChoices(catalog);
  check(
    'primary order = Normal, Tap-or-hold, Toggle',
    primary.map((o) => o.id).join(',') === 'plain,mt,tgl',
    primary.map((o) => o.id).join(','),
  );
  check('advanced = SOCD only', advanced.map((o) => o.id).join(',') === 'socd');
  check('unavailable excluded', primary.length + advanced.length === 4);
}

section('BEHAVIOR_CARDS — plain-language metadata');
{
  check('plain card = Normal key', behaviorCard('plain')?.title === 'Normal key');
  check('mt card = Tap or hold', behaviorCard('mt')?.title === 'Tap or hold');
  check('tgl card = Toggle', behaviorCard('tgl')?.title === 'Toggle');
  const socd = behaviorCard('socd');
  check('socd demoted to advanced tier', socd?.tier === 'advanced');
  check('socd title has no bare acronym', socd?.title === 'Opposing keys');
  check('every writable id has a card',
    (['plain', 'mt', 'socd', 'tgl'] as const).every((id) => BEHAVIOR_CARDS[id] !== undefined));
  check('inventory id → null', behaviorCard('layer-tap') === null);
  // Primary cards must not lead with jargon.
  for (const id of ['plain', 'mt', 'tgl'] as const) {
    check(`${id} primary tier`, BEHAVIOR_CARDS[id].tier === 'primary');
    check(`${id} title jargon-free`, !/SOCD|MT|TGL/.test(BEHAVIOR_CARDS[id].title));
  }
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
