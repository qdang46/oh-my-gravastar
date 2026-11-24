# SparkPlayJoy 6x21 wire protocol — GravaStar HE keyboards

Status: firmware-proven for GravaStar Mercury V75 / V75 Pro / V75 Lite;
physically validated on V75 (identity, board, map, scale, direct travel).
Source of truth: HallJoy `aula_win60he_protocol.{h,cpp}`,
`aula_win60he_client.{h,cpp}`, `aula_win60he_backend.cpp`, and
`docs/research/GRAVASTAR_MERCURY_V75_FIRMWARE_STATIC_ANALYSIS_2026-08-22.md`.
Verified = implemented and tested in HallJoy; inferred = firmware-only.

## 1. Frame format [verified]

Logical protocol report = 64 bytes:

    offset 0      1            2        3          4 .. 4+len-1   rest
    +------------+------------+--------+----------+----------------+--------+
    | 0x5C head  | payload len | command| checksum|    payload     | zero   |
    +------------+------------+--------+----------+----------------+--------+

- `payload len` = payload bytes only (does NOT include the 4-byte header).
- Max payload per report: 60 bytes (4+60=64). Longer responses span
  multiple 64-byte reports; the frame is parsed on the concatenated stream.
  Frame size = `4 + payloadLen`; report count = `ceil(frameBytes / 64)`,
  max 3 reports = 192 bytes (`kMaximumResponseReports = 3`).
- Response command byte = `request_command | 0x80`.
- Checksum (low byte):
      cs = (0x35 + 0x5C + payloadLen + command + payload[payloadLen-1]) & 0xFF
  For payloadLen==0 the last-payload term is omitted.
- All multi-byte integers are little-endian.

### Win32 HID envelope [verified on V75 trace]

The device declares NO HID report ID. Win32 buffers are
`HIDP_CAPS.*ReportByteLength = 65`: byte 0 = report ID (must be 0x00),
bytes 1..64 = the 64-byte protocol report. Both directions are 65 bytes.

## 2. Commands [verified unless noted]

| Cmd (req) | Resp | Name | Req payload | Resp payload |
|-----------|------|------|-------------|--------------|
| 0x01 | 0x81 | Sync / device info | 6 B | 60 B |
| 0x00 (order 0x25) | 0x80 | Precision & travel scale | 3 B | 7 B |
| 0x2B | 0xAB | Default physical key map (2 rows) | 3 B | 45 B |
| 0x23 | 0xA3 | Active Fn0 key functions (14 records) | 57 B | 57 B |
| 0x12 sel 0x02 | 0x92 | Live travel half | 4 B | 128 B |
| 0x12 sel 0x03 | 0x93 | Status matrix (implemented, unused in poll) | 4 B | 130 B |

### 2.1 Sync — cmd 0x01

Request payload: `01 02 03 04 FF FF`
Frame: `5C 06 01 <cs> 01 02 03 04 FF FF` (14 bytes used of 64)

Response payload (60 bytes, payload[0]==0):

    p[0]        = 0x00 status
    p[1..4]     = boardId u32 LE  (e.g. 0x16052201 V75)
    p[5..7]     = platform bytes — V75 reports 00 04 00; Aula reports C0 01 00
                  (semantics unknown; do NOT pin them in exact-known-board gate)
    p[8]        = 0x10 (descriptor length 16)
    p[9..24]    = serial descriptor, 16 bytes, printable ASCII
    p[25]       = 0x10; p[26..41] = app descriptor 16 B ("App V1.0.8" + NUL pad)
    p[42]       = 0x10; p[43..58] = build descriptor 16 B (7-byte label + tail)
    p[59]       = 0xFF trailer

Structural proof: p[0]==0, boardId!=0, all three length bytes==16,
trailer==0xFF, appVersion starts "App V", printable ASCII.

### 2.2 Travel scale — cmd 0x00, order 0x25

Request payload: `25 FF FF`  (command 0x00 = "API/order" class)
Frame: `5C 03 00 <cs> 25 FF FF`

Response payload (7 bytes):
    p[0]=0x00, p[1]=0x25 (order echo), p[2]=precisionUm u8,
    p[3..4]=minimumTravelUm u16 LE, p[5..6]=maximumTravelUm u16 LE

Observed values:
- Aula WIN 60 HE MAX: 10 / 10 / 3400 µm (exact gate)
- GravaStar V75 & V75 Pro: 5 µm precision, 5 µm min, max from live response
  (static code reports up to 3500 µm) [inferred max; live-read required]
- V75 Lite: 5 / 5 / 3500 µm [firmware-proven]

Family plausibility: precision 1..100 µm, min<=max, max 500..10000 µm.

### 2.3 Default physical map — cmd 0x2B

Request payload: `00 <firstRow> <secondRow>` (row indexes 0..5)
Frame: `5C 03 2B <cs> 00 RR SS`

Response payload (45 bytes):
    p[0]=0x00, p[1]=firstRow echo,
    p[2..22]  = 21 HID usage bytes for firstRow
    p[23]=secondRow echo, p[24..44] = 21 usages for secondRow

Full map = 3 reads: (0,1), (2,3), (4,5). Usages are the keyboard's own
stored matrix mapped to factory key identifiers (HID usages).

### 2.4 Active Fn0 functions — cmd 0x23

Request payload (57 bytes): `00` then 14 × 4-byte query records:
    { key u8, layout u8, 0x00, 0x00 }
layout = 0x00 = Fn0 base layer. Batch count = ceil(physicalKeys/14)
(5 batches for 61 keys; up to 9 for the 126-position matrix). The final
short batch is padded by repeating its last real key; EVERY returned echo
must carry that same key and all duplicate echoes must return identical
function values.

Response payload (57 bytes): `00` then 14 records `{key, layout, funcLo, funcHi}`
— func is u16 LE at record bytes 2..3. All key/layout echoes correlated.

Function semantics:
- 0x0004..0x00E7 → USB HID keyboard usage (incl. Menu = 0x0065)
- 0xF001 → physical Fn (vendor 16-bit value; MUST NOT be truncated to 0x01)
- other 0xFxxx / macro / internal → filtered out, never published

### 2.5 Live travel — cmd 0x12, selector 0x02

Exact requests (verified byte-for-byte):
    5C 04 12 A6 02 01 FF FF    (half 1 = matrix rows 0..2)
    5C 04 12 A6 02 02 FF FF    (half 2 = matrix rows 3..5)

Request payload: `02 <half 01|02> FF FF`, command 0x12.

Response payload (128 bytes = 2 + 63×2):
    p[0]=0x00, p[1]=0x02, p[2..127] = 63 little-endian u16 travel samples
Frame = 132 bytes → 3 HID reports (192-byte stream capacity).

Half layout: each half is 3 rows × 21 cols row-major u16.
Half1 → rows 0-2, half2 → rows 3-5 (MergeTravelHalves).
Units: raw travel in micrometres (per scale response). HallJoy normalizes
to 0..1000 milli: `round(travelUm*1000/maxUm)`, clamped; 0→0, >=max→1000.

### 2.6 Status — cmd 0x12, selector 0x03

Request payload: `03 01 FF FF` (same command, different selector).
Response payload 130 bytes: `00 03` + 126 status bytes + `FF FF` trailer.
Implemented in client (`QueryStatus`) but not used in the steady-state poll.

## 3. HID transport [verified]

- Enumerate HID device interfaces (Windows: SetupAPI HID GUID + HidD/HidP).
- Required caps: UsagePage 0xFFA0, Usage 0x0001; InputReportByteLength ==
  OutputReportByteLength == 65 (both directions).
- Admission pre-filter (before any command): exact VID/PID in the identity
  table, OR VID 0x1CA2, OR "aula"/"sparkplayjoy"/"spark play joy" token in
  SetupAPI manufacturer/friendly-name/device-desc. Brand-token path still
  requires the full wire proof.
- Open the command interface EXCLUSIVELY. Re-verify instance ID and re-read
  HID attributes/caps/strings through that handle (TOCTOU close).
- Input queue: request ≥3 buffers (64 requested, minimum = 3 = one max-size response).
- Per transaction: flush input queue → write 65-byte report (1 s write
  timeout) → read N reports where N = expected response report count,
  under ONE shared 1000 ms deadline.
- No transaction ID, no half ID in travel replies → any flush/write/read/
  parse/correlation error permanently poisons the session; close and reopen.
- Steady state: per loop iteration read travel half1+half2 (2 transactions,
  6 reports); refresh the full active Fn0 map every 2000 ms.

## 4. GravaStar identity table [verified]

| Model | VID:PID | Board ID (sync p[1..4]) | App version |
|-------|---------|--------------------------|-------------|
| Mercury V75 | 1CA5:2201 | 0x16052201 | V1.0.8 |
| Mercury V75 Pro | 1CA5:2202 | 0x16052202 | V1.0.8 |
| Mercury V75 Lite | 1CA2:2201 | 0x2E022201 | V0.2.5 |

(V75/Lite share VID families with Aula 1CA5/1CA2 — board ID disambiguates.)
V75 physical trace: 79 physical positions, 78 default mappings, 79 active
mappings, 5 µm precision, 3500 µm max, valid F001 retention.

## 5. Admission / structural proof (ExactKnownBoard6x21Family)

For exact-table identities, ALL required:
1. HID caps FFA0:0001, 65/65-byte reports.
2. Sync response: boardId == expected table value AND structured 60-byte
   descriptors (serial/app/build, "App V" prefix, 0xFF trailer).
   Platform bytes p[5..7] are NOT compared (V75=00 04 00 vs Aula=C0 01 00).
3. Precision response within family plausibility bounds.
4. Default map: ≥2 non-zero unique keys, all unique, inside 6×21.
5. Two complete active-map generations (all 0x23 batches each) byte-identical.
6. Both travel halves decode and every populated position ≤
   maxUm + max(8×precisionUm, 200).
Only then is the HID path claimed and analogue values published.

## 6. Data semantics

- Matrix: fixed 6 rows × 21 cols = 126 positions; row-major.
- Travel units: micrometres, u16 raw; normalize per-session to 0..1000
  against live maxUm (3500 µm on V75; never hardcode).
- Fn0 = base layer only (layout byte 0x00). Other layers unimplemented.
- Fn = function 0xF001 → extended key domain (HallJoy keycode 0x409);
  Menu = HID usage 0x0065 ordinary key.
- No digital key event participates in mapping or gating.

## 7. NOT implemented / unknown

- WRITE commands: none implemented; HallJoy's path is strictly read-only.
  The V75 updater firmware contains config/write paths but they were not
  protocol-extracted.
- Layouts other than Fn0, status-selector semantics, sync p[5..7]
  platform bytes, and V75 Pro/Lite runtime behaviour are unverified.
- The protocol cannot distinguish a perfectly repeated ABA torn map;
  two-generation equality is the accepted bound.

## 8. Porting notes

- Endianness: ALL integers little-endian (boardId, travel u16, function u16,
  min/max u16). Checksum/length/command are u8.
- Continuation: responses are NOT self-delimiting per report — concatenate
  ceil((4+len)/64) full 64-byte reports, then parse the single frame at
  offset 0. First report alone must match head/command/length echoes.
- The `5C` head byte appears only in the FIRST 64-byte block; continuation
  reports are raw continuation bytes. Treat each HID report as 64 payload
  bytes appended in order (strip the 65-byte envelope per report).
- Timing: flush input queue before EVERY request (no transaction IDs);
  share one deadline across continuation reads; any anomaly = session poison.
- Payload length byte is u8 — max observed is 128 (travel) / 130 (status).
- Publishable filter: default-map bytes are raw HID usages; active functions
  0x04..0xE7 publish directly, 0xF001→Fn, everything else dropped.
- Request builders zero-pad the full 64-byte report.
