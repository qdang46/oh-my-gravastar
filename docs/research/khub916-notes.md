# khub916 reverse-engineering notes (bead F5a)

How the protocol spec in `docs/protocol-khub916.md` was produced, plus dead ends
so future agents don't repeat the work.

## Materials

- `docs/research/khub-webapp/` — mirror of the vendor khub web configurator.
- The ONLY obfuscated file is `index-M8-m9qFR.js` (207 KB): the entire HID engine.
  All other chunks (`BasicFunctions`, `LightingEffect`, `MacroConfiguration`,
  `AdvancedKey`, `deviceAdapter`, `devicesInit`, `index.js` catalog) are plain JS.
- `index-M8-m9qFR.deob.js` — my deobfuscated output (5573 string lookups resolved).
  Generated locally with `/tmp/deob/deob.js`; **not committed** (derived vendor
  code). Regenerate with the recipe below if needed.

## Obfuscation scheme (javascript-obfuscator, string-array + rotation)

Per scope: `function T(){const l=[...];return T=function(){return l},T()}` then
an IIFE `(function(l,a){const e=IDXFN,t=l();for(;;)try{if(EXPR===a)break;
t.push(t.shift())}catch{t.push(t.shift())}})(TABLE,CHECK)` rotates the array
until a checksum expression equals `CHECK`. Lookups are
`function IDX(l,a){return l=l-BASE,TAB()[l]}` — the second arg is unused.
Top-level aliases like `const V=Oe`, `K=Se` chain index functions; inside
functions `const e=K` aliases are everywhere.

## Deobfuscator (/tmp/deob/deob.js) — working recipe

1. Extract each `function NAME(){const|var V=[...]}` array literal (string-aware
   bracket matcher — strings contain `]`).
2. For each table find its index function(s) via
   `function IDX(x,y){return x=x-BASE,TAB()[x]}` (also a `var e=TAB(),t=e[x]`
   variant for `Bt`/`Aa`).
3. Find the rotation IIFE by locating `})(TAB,CHECK)` and walking back to the
   nearest `(function(` — do NOT regex the body with `[^}]` (the catch block
   contains braces) and do NOT forget to **escape `$` in table names** (`$e`
   silently broke all regexes the first time — cost an hour).
4. In a Node `vm` sandbox: define table fns → define index fns → **then** run
   the rotation IIFEs (they call the index fns for checksum exprs) → index fn
   `n` decodes `TAB()[n-BASE]`.
5. Parse with `acorn` (installed in /tmp/deob via npm), walk with a hand-rolled
   scope tracker: `const/let X = IDENT` binds alias→identifier (transitively
   resolved), function params/unknowns bind null, Program/Block/FunctionBody
   pre-scan declarations. Replace `IDENT(<integer>)` call nodes textually with
   `JSON.stringify(decoded)` using node.start/end offsets.

Pitfalls hit: phantom initial scope offsetting debug output; `const V=Oe`
top-level aliases needing transitive resolution; function-declaration self-name
binding; unrotated tables produce *plausible but wrong* strings (looks like
`e["padStart"]` for byteLength) — always sanity-check a known string.

Result: 5573 replacements; the only leftover `IDENT(num)` calls are inside the
rotation checksum IIFEs themselves (correct to leave) and `Wt(4)`/`delay(n)`
real functions.

## Engine map (exports of index-M8-m9qFR.js)

`Ht`=O (916 wired, feature reports 519 B), `zt`=z (916_wireLess, output reports
19 B + input stream), `Ot`=Y (8815 wired, same envelope as Ht), `Yt`=V
(8815_wireLess, same envelope as zt), `Gt`=G (901, feature reports different
header), `jt`=j (WebHID requestDevice/getDevices helper), `nn`=o (screen/image
transfer helper, setKeyBoardImg 512-B frames).

`devicesInit-CDKz8T4Y.js` `setDevice()` picks the class via `y(vid,pid)` →
protocol string "916"/"916_wireLess"/"8815"/"8815_wireLess"/"901".

## Key structural findings

- **Auth = UUID lookup, not a handshake.** `getDeviceBasicAttributes` returns
  uuid(6B)+version(2B)+screenSize(1B); catalog `password` field IS the UUID
  (e.g. K1 `0x0300000001b4`, K1 Pro `0x030000000197`, K98 Pro `0x0600000000b3`).
- Wired response echoes the 7-byte request header verbatim (verified live);
  JS strips report-ID byte then `slice(7)` for payload.
- Wireless packets are 19 B: 7-B query header or chunked `[cmd,total,idx,len,…]`
  writes with 14-B chunks; additive checksum `sum(reportId+body)&0xFF`.
- Wireless multi-packet responses reassemble by index byte; keepalive
  `[10,1,0,4,2,…]` feeds battery/online listeners.
- K98 Pro screen is a SEPARATE HID device (VID 9610 PID 436), not in the
  keyboard protocol.

## Live verification (K1 Pro, macOS)

`hidapi` via `/tmp/hidprobe/.venv` (pip `hidapi`). Device path
`DevSrvsID:4295306107`, usage_page 0xFF00 collection, reportId 6.
This binding's API: `send_feature_report(buff)` takes the WHOLE buffer with
report ID as byte 0 (pad to 520); `get_feature_report(rid,len)`;
`set_feature_report` does NOT exist.
Only query commands sent (130 info, 132 profile, 135 power, 138 light, 133
macro, 131 keys) — all are what the driver sends on connect.

## Dead ends / don't repeat

- `index-DSyCB7dO.js` (imported by devicesInit for `y()` vid→protocol map and
  catalog `w`/`T`) is NOT in the mirror — protocolKey strings were recovered
  from `index.js` `Ts`/`Dp` tables and devicesInit call sites instead.
- `Bt`/`Aa` table+index at end of index-M8-m9qFR.js is dead code (never called).
- Ot (8815) reuses the 916 wired envelope with a different profile layout
  (`e[33]` vs `e[10]` indexing); Yt reuses the zt envelope. If 8815 work comes
  later, diff Ot/Yt against Ht/zt rather than re-reversing.
- Gt (901) is a third, older envelope (`[cmd]` or `[1,sys,0,1,1,248,0,…]`).
