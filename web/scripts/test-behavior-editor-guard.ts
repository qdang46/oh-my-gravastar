/**
 * Unit tests for the keymap-write guards in `src/behavior-editor.ts`
 * (bead oh-my-gravastar-gxe): every whole-table write — the adv
 * `writeKeyConfiguration` path (`commitAdv`) and the remove-binding
 * `writeKeymap` path (`commitRemoveAdv`) — must go through
 * `keymapBase`/`guardKeymapBase` and refuse to overwrite opaque
 * unknown-tag slots (AGENTS.md §Safety 6/7).
 *
 * Runs under Node's native TS stripping:
 *
 *   node scripts/test-behavior-editor-guard.ts
 *
 * No DOM, no device: the confirm-dialog halves (`applyAdv`/`removeAdv`)
 * are bypassed by calling the post-confirm `commit*` methods directly
 * (private at compile time, reachable through a structural cast), with
 * a fake session injected into `app.connected`.
 */

declare const process: { exit(code?: number): never };

import { BehaviorEditor, type ConfigureContext } from '../src/behavior-editor.ts';
import { app } from '../src/state/core.ts';
import type { AdvDraft } from '../src/behavior-core.ts';

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

// ── Mock session / app state ───────────────────────────────────────────

interface RecordedCalls {
  keyConfigWrites: number[][];
  advWrites: number;
  keymapWrites: number[][];
  keymapReads: number;
}

function entriesOf(values: readonly number[]) {
  return values.map((value) => ({ value, kv: { kind: 'empty' }, label: '' }));
}

/** Fake `Khub916Session`: table() is read live on every call. */
function mockSession(table: () => readonly number[]): { session: unknown; calls: RecordedCalls } {
  const calls: RecordedCalls = { keyConfigWrites: [], advWrites: 0, keymapWrites: [], keymapReads: 0 };
  const session = {
    advKeyConfig: async () => new Uint8Array(512),
    keymap: async (_arg: number) => {
      calls.keymapReads++;
      return entriesOf(table());
    },
    keyValues: async (_arg: number) => [...table()],
    writeKeyConfiguration: async (values: readonly number[]) => {
      calls.keyConfigWrites.push([...values]);
      return { command: 3, verified: true };
    },
    writeAdvKeyConfig: async (_blob: Uint8Array) => {
      calls.advWrites++;
      return { command: 18, verified: true };
    },
    writeKeymap: async (_layer: number, _system: number, values: readonly number[]) => {
      calls.keymapWrites.push([...values]);
      return { command: 3, verified: true };
    },
  };
  return { session, calls };
}

function connect(table: () => readonly number[]): RecordedCalls {
  const { session, calls } = mockSession(table);
  (app as { connected: unknown }).connected = {
    device: { vendorId: 0x258a, productId: 0x010c, productName: 'Gaming Keyboard', manufacturerName: 'BY Tech' },
    session,
  };
  (app as { snapshot: unknown }).snapshot = { keymaps: new Map() };
  return calls;
}

function ctx(index: number, committed = 0x0000_0004): ConfigureContext {
  return {
    arg: 0,
    index,
    keyName: '',
    committed,
    effective: committed,
    stagePlain: () => {},
    hasStaged: () => false,
    stagedCount: () => 0,
    labelFor: () => 'a',
    onDeviceWrite: () => {},
  };
}

// 126-slot K1 Pro-shaped table of plain 'a' values; slot 4 carries the
// undocumented tag-0x08 Fn-layer value that must stay opaque.
const BASE_TABLE: number[] = Array.from({ length: 126 }, (_, i) =>
  i === 4 ? 0x0802_0000 : 0x0000_0004,
);

interface AdvCacheLike {
  conn: unknown;
  blob: Uint8Array;
  keymap: number[];
}

/** Structural view of the private post-confirm write paths. */
interface EditorInternals {
  advError: string;
  ensureAdv(force?: boolean): Promise<AdvCacheLike | null>;
  commitAdv(
    ctx: ConfigureContext,
    draft: AdvDraft,
    adv: AdvCacheLike,
    desc: string,
  ): Promise<void>;
  commitRemoveAdv(ctx: ConfigureContext): Promise<void>;
}

const editor = () => new BehaviorEditor() as unknown as EditorInternals;

const MT_DRAFT: AdvDraft = { kind: 'mt', tap: 0x0000_0004, hold: 0x0002_0000, timeUnits: 50 };

// ── ensureAdv / commitAdv (writeKeyConfiguration path) ─────────────────

section('ensureAdv — guarded arg-0 base');
{
  const calls = connect(() => []);
  const ed = editor();
  const adv = await ed.ensureAdv();
  check('empty keymap read → no adv cache (write cannot be planned)', adv === null);
  check('advError records the abort', /empty/.test(ed.advError), ed.advError);
  void calls;
}
{
  connect(() => BASE_TABLE);
  const ed = editor();
  const adv = await ed.ensureAdv();
  check('good read caches a guarded base', adv !== null && adv.keymap.length === 126);
  check('opaque slot carried verbatim', adv?.keymap[4] === 0x0802_0000);
}

section('commitAdv — normal MT edit passes');
{
  // Fresh mock so we can inspect recorded calls.
  const recorded = connect(() => BASE_TABLE);
  const ed = editor();
  const adv = await ed.ensureAdv();
  await ed.commitAdv(ctx(10), MT_DRAFT, adv as AdvCacheLike, 'MT on key 10');
  check('keymap write sent once', recorded.keyConfigWrites.length === 1);
  const sent = recorded.keyConfigWrites[0] ?? [];
  check('sent table keeps device length (126, not padded-then-wrong)', sent.length === 126);
  check('bind slot rewritten to MT tag', ((sent[10] ?? 0) >>> 24) === 0x21, `got 0x${(sent[10] ?? 0).toString(16)}`);
  check('opaque slot 4 preserved byte-identical', sent[4] === 0x0802_0000);
  check('history blob write followed', recorded.advWrites === 1);
  check('status is not an error', app.statusError === false, app.status);
}

section('commitAdv — opaque slot refuse (§Safety 7)');
{
  // Opaque value ON the bind slot: the plan would overwrite it.
  const table = BASE_TABLE.slice();
  table[10] = 0x0802_0000;
  const recorded = connect(() => table);
  const ed = editor();
  const adv = await ed.ensureAdv();
  await ed.commitAdv(ctx(10, 0x0802_0000), MT_DRAFT, adv as AdvCacheLike, 'MT on key 10');
  check('no keymap write sent', recorded.keyConfigWrites.length === 0);
  check('no blob write sent', recorded.advWrites === 0);
  check('status reports refusal', app.statusError === true && /does not recognize/.test(app.status), app.status);
}
{
  // Opaque value on a NON-target slot: plan leaves it alone → passes.
  const recorded = connect(() => BASE_TABLE); // slot 4 is opaque
  const ed = editor();
  const adv = await ed.ensureAdv();
  await ed.commitAdv(ctx(10), MT_DRAFT, adv as AdvCacheLike, 'MT on key 10');
  const sent = recorded.keyConfigWrites[0] ?? [];
  check('write proceeds when opaque slot is untouched', recorded.keyConfigWrites.length === 1);
  check('untouched opaque slot preserved', sent[4] === 0x0802_0000);
}
{
  // TGL draft whose *target* slot is opaque: the target's value would be
  // captured into the history blob — refused even though the keymap
  // diff itself is clean.
  const table = BASE_TABLE.slice();
  table[20] = 0x0803_0100;
  const recorded = connect(() => table);
  const ed = editor();
  const adv = await ed.ensureAdv();
  await ed.commitAdv(ctx(10), { kind: 'tgl', key: 10, target: 20 }, adv as AdvCacheLike, 'TGL on key 10');
  check('opaque TGL target refused before any write', recorded.keyConfigWrites.length === 0 && recorded.advWrites === 0);
  check('status reports refusal', app.statusError === true && /does not recognize/.test(app.status), app.status);
}
{
  // SOCD partner slot opaque: planSocd rewrites BOTH slots → refused.
  const table = BASE_TABLE.slice();
  table[11] = 0x0802_0000;
  const recorded = connect(() => table);
  const ed = editor();
  const adv = await ed.ensureAdv();
  await ed.commitAdv(
    ctx(10),
    { kind: 'socd', keyA: 10, keyB: 11, direction: 0 },
    adv as AdvCacheLike,
    'SOCD on keys 10 + 11',
  );
  check('opaque SOCD partner refused before any write', recorded.keyConfigWrites.length === 0 && recorded.advWrites === 0);
  check('status reports refusal', app.statusError === true && /does not recognize/.test(app.status), app.status);
}

// ── commitRemoveAdv (writeKeymap path) ─────────────────────────────────

section('commitRemoveAdv — guarded whole-table write');
{
  const recorded = connect(() => BASE_TABLE);
  const ed = editor();
  await ed.commitRemoveAdv(ctx(10));
  check('keymap write sent once', recorded.keymapWrites.length === 1);
  const sent = recorded.keymapWrites[0] ?? [];
  check('wire table padded to 128 slots', sent.length === 128);
  check('target slot zeroed', sent[10] === 0);
  check('other slots untouched', sent[4] === 0x0802_0000 && sent[5] === 0x0000_0004);
  check('status is not an error', app.statusError === false, app.status);
}
{
  // Empty device read must abort BEFORE any bytes are sent.
  const recorded = connect(() => []);
  const ed = editor();
  await ed.commitRemoveAdv(ctx(10));
  check('empty base → no writeKeymap call', recorded.keymapWrites.length === 0);
  check('status reports the abort', app.statusError === true && /empty/.test(app.status), app.status);
}
{
  // Short read vs a sibling arg's cached length must abort too.
  const recorded = connect(() => BASE_TABLE.slice(0, 60));
  (app.snapshot?.keymaps as Map<number, unknown[]>).set(
    1,
    entriesOf(BASE_TABLE) as unknown[],
  );
  const ed = editor();
  await ed.commitRemoveAdv(ctx(10));
  check('short base vs sibling arg → no write', recorded.keymapWrites.length === 0);
  check('status reports the length mismatch', app.statusError === true && /60|126/.test(app.status), app.status);
}
{
  // Opaque slot at the remove target → refused (§Safety 7).
  const table = BASE_TABLE.slice();
  table[10] = 0x0802_0000;
  const recorded = connect(() => table);
  const ed = editor();
  await ed.commitRemoveAdv(ctx(10, 0x0802_0000));
  check('opaque remove target refused', recorded.keymapWrites.length === 0);
  check('status reports refusal', app.statusError === true && /does not recognize/.test(app.status), app.status);
}
{
  // Index past the device's real table → refused, nothing sent.
  const recorded = connect(() => BASE_TABLE);
  const ed = editor();
  await ed.commitRemoveAdv(ctx(200));
  check('out-of-range index → no write', recorded.keymapWrites.length === 0);
  check('status reports the range error', app.statusError === true && /past the 126/.test(app.status), app.status);
}

// Restore shared state for any later tests in the same process.
(app as { connected: unknown }).connected = null;
(app as { snapshot: unknown }).snapshot = null;

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall behavior-editor guard checks passed');
