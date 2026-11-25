# khub916 clean-reset coverage — cmd 17 semantics and the `reset_verified` question

Research note for the design-review gap "`omg reset` semantics unresolved".
Companion: `docs/specs/schema-coverage-and-reset-decision.md` §1.2/§2.1/§2.5,
`docs/specs/rust-cli-config-migration-spec.md` §7, `docs/plan.md` §2,
`AGENTS.md` incident log (cmd-8 wedge, 2026-11).

Headline: **`reset_verified` is NOT claimable today.** cmd 17 is
fire-and-forget with no read-back possible in-session; per-region reset
coverage is unverified for every persistent region; no factory-default
reference image exists for most regions; and the command's own status is
contradictory across the codebase (direct CLI works, capability registry
and plan policy call it blocked/not-implemented). Everything below is
code-verified at best unless marked otherwise.

---

## 1. What cmd 17 is

`crates/proto-khub916/src/lib.rs:840–850`:

```rust
/// Keyboard reset / restore-factory (cmd 17, vendor
/// `setKeyboardReset`, tags 1/0, 1-byte type payload). Type `0` is
/// the vendor's "restore factory settings"; type `2` is the keymap
/// page's "reset all layers".
///
/// Fire-and-forget — the device reboots and drops off the bus, so
/// **no read-back verify is possible**. Gate behind `--yes`.
pub fn reset_keyboard(&mut self, kind: u8) -> Result<()> {
    let pkt = Self::packet(CMD_KEYBOARD_RESET, 0x00, 0x01, 0x00, &[kind])?;
    self.config_write(&pkt)
}
```

- Wire: `[17, 0, 0, 1, 0, 1, 0, kind]` padded to 519 B
  (`CMD_KEYBOARD_RESET = 17`, lib.rs:99; cmd map
  `docs/protocol-khub916.md:270` — `setKeyboardReset`, tags 1/0, 1-byte
  payload).
- Sent via `config_write` → `Link::feature_write`, then only a 150 ms
  settle (`WRITE_SETTLE`, lib.rs:92–95) — **no response is read or
  expected** (vendor JS never reads replies to writes, lib.rs:30–35).
- `kind` is an unrestricted `u8` (`crates/omg/src/main.rs:4152–4155`,
  `--kind` default 0). **No range validation** — any value 0–255 can be
  sent; only 0 and 2 have vendor-documented meanings.
- CLI surface: `omg kb916 reset --kind <n> --yes`
  (`main.rs:4702–4718`). Output honestly reports `"verified": false` /
  `"event": "reset_sent"`.

Vendor evidence for the type byte: the only observed vendor call is
`setKeyboardReset(0)` in the webapp demo
(`docs/research/khub-webapp/home-B-bkOec8.js`). Type 2 = "reset all
keymap layers" per the official webapp's keymap page — cited in
`main.rs:4147–4149` and the spec doc §2.1; the exact vendor call site was
not re-verified in this pass (**code-verified, vendor-sourced**).

Wireless sibling: cmd 6 `[6,1,0,type]` "clears cached state R"
(`docs/protocol-khub916.md:536`) — code-verified only, transport not
implemented, and explicitly blacklisted (`lib.rs:50–54`).

## 2. The cmd-17 conflict — documented precisely

Four surfaces disagree:

| surface | position | evidence |
|---|---|---|
| Protocol crate | cmd 17 reset IS implemented | `proto-khub916/src/lib.rs:52–54, 840–850` |
| Direct CLI | `omg kb916 reset --kind --yes` works | `omg/src/main.rs:4147–4158, 4702–4718` |
| Capability registry | `factory_reset: supported:false, blacklisted:true, reason:not-implemented`, detail "protocol blacklist: cmd 17 reset and all writes" | `omg/src/device.rs:93–94` (Khub916Wired); same shape for HE `:133`, mouse `:159` |
| Plan policy | `kb916 reset` is Risk::L4, refused at validation | `omg/src/plan.rs:10–11, 293–317` (`[kb916, reset] → L4`, plus `"reset"` in `L4_SEGMENTS`); refusal at `plan.rs:614–617, 1457–1459` |
| Config schema | `"area": "reset"` listed under excluded/non-writable, `risk_class: "L4"` | `omg/src/config/schema.rs:521` |

So: the bytes can be sent today via the direct command, but every
*generic* surface (device capabilities, plan, config schema) declares
the operation blocked or nonexistent. The `device.rs` detail string is
also stale — it claims "protocol blacklist: cmd 17 reset" while the
protocol crate doc (`lib.rs:18–57`) documents cmd 17 as an *implemented*
exception to the write blacklist (only wireless cmd 6 and arbitrary
commands are blacklisted). This is the inconsistency the spec §2.1 flags;
resolution is a policy decision, not a code bug — per spec §2.1 the
recommendation is `factory_reset_candidate`, L4-blocked for Agent use
until live-tested on a recoverable target.

Note also `omg/src/plan.rs:292`: `"reset"` is in `L4_SEGMENTS`, so even a
hypothetical `omg config reset`-style op would be refused — consistent
with spec §1.2/§2.5 (clean reset is a separate L4 operation, never a
config field).

## 3. Persistent regions — cmd-17 coverage per region

Every region has a **read** command, so post-reset verification is
*possible in principle*; the question is whether type 0 (or type 2)
actually clears it. No region below has been observed post-reset —
**all coverage claims are unverified** unless noted.

| # | region | read | write | plausible type-0 reset? | plausible type-2 reset? | evidence level |
|---|--------|------|-------|------------------------|------------------------|----------------|
| 1 | Keymap banks, args 0–7 (4 layers × 2 system) | cmd 131 | cmd 3 | likely (vendor "factory") | **yes — this is its documented job** ("reset all layers") | type semantics code-verified; actual clearing unverified |
| 2 | Profile blob ~128 B (sleep `profile[24]`, light mode `profile[9..11]` + per-mode records, `profile[1]` system/layout byte) | cmd 132 | cmd 4 | likely (factory) | unlikely (keymap-only) | layout code-verified (`protocol-khub916.md:422–438`); reset coverage unverified |
| 3 | Macro region ≤512 B (headers + 4 B steps) | cmd 133 | cmd 5 | likely (factory) | unlikely | codec live-verified for writes (`schema spec §3.1`); reset coverage unverified |
| 4 | Custom light colours, 378 B (126×RGB planes) | cmd 134 | cmd 6 | likely (factory) | unlikely | write live-verified (`protocol-khub916.md:244–245`); reset coverage unverified |
| 5 | Light colour data ~483 B (23 groups × 21 B; only RGB triple decoded, 18 B template opaque) | cmd 138 | cmd 10 | likely (factory) | unlikely | live-verified on K1 Pro (`protocol-khub916.md:446–464`); template bytes must be preserved byte-identical on any rewrite (§Safety 7) |
| 6 | Adv-key history 512 B (SOCD 200 + MT 200 + TGL 112) + adv-key *bindings* inside keymap (tags 0x20/0x21/0x22) | cmd 146 | cmd 18 (+ cmd 3 for bindings) | unknown — and the cmd-18 write **did not persist on K1 Pro** (`protocol-khub916.md:503`, `docs/advkeys-schema.md`, `protocol-behaviors.md` §1 caveat) | type 2 resets *keymap* slots → would clear the tag-0x20/21/22 bindings but probably NOT the history blob | persistence failure live-observed; reset coverage unverified |
| 7 | Fn-layer keymap (arg 0x01) incl. opaque tag-0x08 slots | cmd 131 arg 1 | cmd 3 | likely if "all layers" | yes if type 2 = all layers incl. Fn | incident log (AGENTS.md): after wedge, needed **both** `reset --yes` (type 0) **and** `reset --kind 2 --yes`, plus replug — suggests type 0 alone did not restore keymap layers, or the wedge was deeper. Consistent with type 2 being the keymap-scoped reset. Live-observed recovery, semantics still inferred. |
| 8 | Screen image state (K98, separate HID interface) | none (write-only) | cmds 11/12/13 | unknown — different interface, different MCU path possibly | unknown | `device.rs:96–103`; not part of keyboard config |
| 9 | Wireless dongle state | n/a (transport unimplemented) | wireless cmd 6 | code-verified only ("clears cached state R") | — | `protocol-khub916.md:536` |

Also non-config device state (battery, identity UUID/firmware) is
read-only telemetry (cmds 130/135) — a factory reset should not and
cannot change it; useful as a sanity anchor post-reconnect.

## 4. What "clean reset" would have to mean (spec §1.2/§2.5 restated)

`omg reset` = restore clean/factory state, coverage declared honestly.
Forbidden shortcuts: no "erase all flash", no section-reset masquerading
as factory, no `reset_verified` without post-reset reads. Statuses:
`reset_verified` / `reset_sent_unverified` / `reset_partial` /
`reset_failed` / `reset_unsupported`.

For khub916 today the honest status after `omg kb916 reset --yes` is
**`reset_sent_unverified`** — which is exactly what the CLI already
prints (`main.rs:4710–4716`).

## 5. Proposed `reset_verified` protocol — and whether it's achievable

To ever claim `reset_verified` for cmd-17 type 0 on K1 Pro:

1. **Pre-reset baseline**: read and persist every region — keymap args
   0–7 (note: args 4–7 reads are currently garbled —
   `web/src/keymap-guard.ts:134–143`; verification of the system banks
   is blocked until that read shape is understood), profile (132),
   macro (133), custom light (134), light data (138), adv-key (146).
   Store raw bytes + decoded forms.
2. **Dirty the device deliberately** (or use a device already in a known
   non-default state), snapshot, send `reset_keyboard(0)`.
3. **Reconnect**: the device reboots and drops off the bus
   (`lib.rs:845–846`); re-open HID, re-run `device_info` (cmd 130) to
   confirm same UUID/model.
4. **Post-reset reads** of every region in step 1.
5. **Diff against factory defaults** — this is the hard part:
   - *Keymap*: vendor keyModel JSONs exist
     (`docs/research/khub-webapp/index-cV1Bl4gC.js`, ~60 layouts; the
     K1 Pro model has 126 entries) → a default-image comparison is
     *possible* for args 0–3. Args 4–7 defaults unknown (reads garbled).
   - *Profile/macro/custom-light/light-data*: **no factory-default
     reference exists anywhere in the repo.** A "reset" can only be
     verified as "returned to the state captured from a factory-fresh
     device" — which requires either a sacrificial/fresh device or
     vendor documentation of defaults. Absent that, the best available
     claim is `reset_partial`: "all readable regions changed/returned to
     *a* consistent state", not "factory".
   - *Adv-key history*: already known non-persistent on K1 Pro — a
     reset cannot be verified there at all until persistence is
     re-proven.
6. Report per-region coverage; any region unreadable or without a
   default reference caps the result at `reset_partial` or
   `reset_sent_unverified`.

**Achievability today: code-tested at best; live verification pending.**
The read commands all exist and are exercised; the missing pieces are
(a) a live run on a recoverable K1 Pro, (b) factory-default reference
images for regions 2–5, (c) a fix/understanding of system-bank (args
4–7) reads, (d) the policy decision to unblock cmd 17 for a controlled
test. The AGENTS.md incident log already demonstrates the *recovery*
half live (type 0 + type 2 + replug restored a wedged K1 Pro) — but a
recovery is not a coverage proof.

## 6. Explicit non-actions

Per instructions and AGENTS.md §Safety 2: **no reset code was changed.**
cmd 17 remains fire-and-forget, `--kind` unvalidated, and L4-blocked on
all generic surfaces. If the inconsistency in §2 is to be resolved, it
is a docs/policy decision for the parent agent — the minimal honest fix
is updating `device.rs:93–94`'s stale "protocol blacklist" wording to
match `lib.rs:52–54` (which blacklists only the *wireless* reset), while
keeping `supported:false`/`blacklisted:true` for Agent purposes until
`reset_verified` evidence exists.

## 7. Evidence index

- `crates/proto-khub916/src/lib.rs:50–57` blacklist note (wired cmd 17
  implemented; wireless cmd 6 blacklisted); `:92–95` WRITE_SETTLE;
  `:840–850` `reset_keyboard`.
- `crates/omg/src/main.rs:4141–4158` CLI docs ("type 0 = factory, type 2 =
  reset all keymap layers — per the official webapp"); `:4702–4718`
  handler (verified:false, reset_sent).
- `crates/omg/src/device.rs:93–94` capability contradiction.
- `crates/omg/src/plan.rs:10–11, 293–317, 614–617` L4 refusal.
- `crates/omg/src/config/schema.rs:521` excluded area.
- `docs/protocol-khub916.md:270` cmd map; `:503` adv-key persistence
  failure; `:524–545` wireless cmd map (reset = cmd 6).
- `docs/specs/schema-coverage-and-reset-decision.md` §2.1 (the flagged
  conflict + `factory_reset_candidate` recommendation), §2.5 (generic
  reset behavior + status enum), §3.1 (region inventory).
- `docs/research/khub-webapp/home-B-bkOec8.js` — vendor `setKeyboardReset(0)`.
- `AGENTS.md` incident log — live recovery required type 0 AND type 2
  plus replug.
- `web/src/keymap-guard.ts:134–151` — system-bank reads garbled (blocks
  full keymap-bank verification).
