# khub916 advanced keys — SOCD / MT / TGL schema

User-facing spec for the `omg kb916 adv` subcommand and the
`omg_proto_khub916::advkey` codec. Wire-level detail lives in
`docs/protocol-khub916.md` §6/§7; this document is the *data model*:
what the 512-byte blob and the keymap binding values mean, and how
`adv list|get|set` maps onto them.

Provenance: decoded from the vendor khub webapp
(`docs/research/khub-webapp/index-M8-m9qFR.deob.js`, class `Ht` wired /
`zt` wireless; UI param names from `deviceAdapter-1I3s9kbL.js` and
`AdvancedKey-YMbKTFT4.js`). Verification level on K1 Pro
(`916_K1_PRO`, live-tested):

- cmd 146 blob read + cmd 131 keymap read + all decoders: **live-verified**.
- Keymap half of `set` (cmd 3 `sendKeyConfiguration` header): **live-verified** —
  binding persisted and read-back verified on both the 248/1 and 0/2 channels.
- History half of `set` (cmd 18 `sendAdvanKeyHistory`): **code-verified,
  persistence unconfirmed** — the packet is byte-identical to the vendor's,
  the device accepts it without error, but on this K1 Pro the write did
  **not** persist (fresh-session cmd-146 reads still returned the old blob)
  and in-session cmd-146 reads return unrelated firmware-memory pages for
  ~60 s afterwards. Possibly this firmware lacks adv-key storage or needs
  a vendor-session step we have not identified; retest on other khub916
  hardware before trusting `adv set` end-to-end.

## Commands

```
omg kb916 adv list                      # read-only
omg kb916 adv get <index>               # read-only, keymap slot index
omg kb916 adv set mt     <key> --tap V --hold V [--time N] --yes
omg kb916 adv set socd  <key-a> <key-b> [--direction D] --yes
omg kb916 adv set tgl   <key> --toggle <index> --yes
```

`--json` on all of them. `index`/`key` arguments are **keymap slot
indices** (0-based; vendor `pos = 8 + index*4`, same convention as
`omg kb916 keys`). Key values for `--tap`/`--hold` use the same parser
as `omg kb916 set key` (`0x` hex, decimal, or `none`).

## The two halves of an adv key

An adv key always consists of **two device writes**, in vendor order:

1. **Keymap** — one or two keymap slots are rewritten to reference the
   history entry (wired: cmd 3 `sendKeyConfiguration` header
   `[3,0,0,1,0,0,2]`; wireless: chunked cmd 1).
2. **History blob** — a 512-byte table gains the entry holding the
   keys' original values (wired: cmd 18; wireless: chunked cmd 18).

Both writes are read-back verified; `adv set` refuses to run without
`--yes`.

### History blob (512 B)

| region | blob offset | slot size | slots | contents |
|---|---|---|---|---|
| SOCD | 0..200 | 8 B | 25 | `[keyA u32 BE][keyB u32 BE]` — the two physical keys' original values |
| MT   | 200..400 | 8 B | 25 | `[tap u32 BE][hold u32 BE]` |
| TGL  | 400..512 | 4 B | 28 | `[toggle-target u32 BE]` — the *value* of the slot passed as `--toggle` |

- Slot index = byte offset / slot size within the region.
- **Free-slot rule** (vendor `processHistory`): scan slots from offset 0;
  the first slot whose bytes are all zero receives the entry. The
  pre-check is "any run of 4 consecutive zero bytes" — applied to all
  three kinds even though TGL slots are 4 B.
- There is **no delete**: the vendor UI's delete only edits a
  localStorage cache. Full regions fail with "no available … slot
  found". TGL region bytes 510/511 (last two of blob) are zeroed on
  every write (vendor footer quirk).
- A slot index only stays stable because nothing is ever removed;
  entries are never reordered.

### Keymap binding values

A bound keymap slot holds one u32:

```
0xKKSSPPPP   (conceptually)
KK = kind tag: 0x20 SOCD, 0x21 MT, 0x22 TGL
SS = slot index (bits 16..23) — see "base address" below
PPPP/PP… = kind-specific parameters in the low bits
```

The vendor computes the value as `base + params` where `base` encodes
the *history slot* indirectly:

| kind | base | param bits |
|---|---|---|
| SOCD | `0x20000000` | key A: `+ direction`; key B: `+ 256 + direction` |
| MT   | `0x21000000` | `+ time` (low 16 bits) |
| TGL  | `0x22000000` | none |

`base` is `kind_base + (nonzero_slot_groups − 1) * 0x10000` for ≥2
non-zero groups, else `kind_base` — the vendor counts *non-zero
groups*, bug-compatible (see `base_address` in advkey.rs). In practice
with dense packing `SS` = slot index.

**Dense-packing caveat (live-observed):** the vendor has no delete, so
history is always dense and `SS` reliably addresses the slot. On devices
whose blob contains orphaned/non-dense entries (this K1 Pro ships 49
history entries with empty leading slots), a new entry can land in an
earlier free slot than the binding's `SS` field addresses — the port is
bug-compatible with the vendor here, which has the same limitation.

Kind parameters (vendor UI names):

| kind | params | notes |
|---|---|---|
| SOCD | `direction` 0–3 | 0 last-input priority, 1 absolute priority key A, 2 absolute priority key B, 3 all-cancel. Key B's value has bit 8 set (`+256`). |
| MT | `time` | hold threshold in **10 ms units**; UI slider 0–100 (default 50 = 500 ms). CLI `--time` takes the raw unit. |
| TGL | — | binding value is exactly the base. |

Vendor refuses to bind a keymap slot whose current value already
carries tag `0x03` (macro) or `0x20/0x21/0x22` (another adv key) —
unbind/rebind through `omg kb916 set key` first.

## `adv list` output

`history` = non-empty slots per kind (`slot`, `values` with u32 +
label); `bindings` = every keymap slot with a `0x20/0x21/0x22` tag,
resolved to `{kind, slot, detail, payload}` where `payload` is the
history entry it points at (`null`/empty when the slot is zero — a
stale binding).

## Known limitations

- **No delete/clear** — mirrors the vendor; there is no wire command
  for it. To "remove" an adv key you can only overwrite the keymap
  binding (`omg kb916 set key <index> <value> --yes`); the history
  entry stays and wastes a slot.
- MT stores only `[tap, hold]`; the vendor UI's third param
  (`keyC`/`shortCode` distinction) collapses into these two values.
- SOCD `direction` accepts `0-3` or `last`/`key-a`/`key-b`/`cancel`.
- Wireless (`916_wireLess`) adv keys are codec-ready but were never
  exercised — no wireless hardware attached.
