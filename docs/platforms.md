# Platform notes — HID access for `omg`

`omg` talks to devices through `hidapi` (`omg-hid` → `hidapi` crate), which
maps to the native HID stack on each OS. No vendor drivers are needed on any
platform; the sections below cover permissions and quirks.

## macOS

Backend: hidapi → IOHIDManager / IOHIDDevice.

- **Input Monitoring permission.** Opening feature reports and some vendor
  collections requires the *calling process* (your terminal, or the `omg`
  binary when launched directly) to be allowed under
  **System Settings → Privacy & Security → Input Monitoring**. If `omg
  devices` lists nothing or `omg kb`/`omg mouse` time out, grant the
  permission to your terminal app and **fully quit and relaunch it** — macOS
  does not re-check permissions for already-running processes.
- **Verified:** GravaStar Mercury K1 Pro wired, `258A:010C`, product string
  "Gaming Keyboard", manufacturer "BY Tech". It exposes several HID
  interfaces (keyboard, consumer control, the vendor `0xFF00` feature-report
  collection used by khub916, etc.) — `omg devices` lists each interface
  separately, so one physical keyboard can appear multiple times.
- **Selector quirk:** all interfaces of one physical device share the same
  macOS path (`DevSrvsID:…`), so `--device` cannot currently pick between
  collections of the same keyboard by path. `--device VID:PID` matching
  several interfaces reports "matches N devices; be more specific". This is
  a known limitation until per-collection selection lands (F8/F5c work).
- hidapi on macOS strips the report-id byte for numbered-report devices;
  `omg-hid` handles this via the `numbered` flag (Compx mice only).

## Linux

Backend: hidapi → hidraw (`/dev/hidrawN`).

- **Permissions.** By default only root (or udev `uaccess`) can open hidraw
  nodes. The recommended approach mirrors the OmaGravastar project's udev
  rule (upstream: `../oh-my-gravastar-upstream/OmaGravastar/udev/70-gravastar-mouse.rules`):

  ```sh
  sudo tee /etc/udev/rules.d/70-gravastar.rules <<'EOF'
  # Let the logged-in seat user talk to GravaStar vendor interfaces.
  # TAG+="uaccess" grants access to the active local user only — it does
  # NOT open the device to other users (no MODE="0666").
  SUBSYSTEM=="hidraw", ATTRS{idVendor}=="3554", ATTRS{idProduct}=="f54b", TAG+="uaccess"
  SUBSYSTEM=="hidraw", ATTRS{idVendor}=="3554", ATTRS{idProduct}=="f576", TAG+="uaccess"
  SUBSYSTEM=="hidraw", ATTRS{idVendor}=="258a", ATTRS{idProduct}=="010c", TAG+="uaccess"
  # …add further VID:PID pairs from crates/hid/src/devices.rs as needed
  EOF
  sudo udevadm control --reload-rules && sudo udevadm trigger
  ```

  Keep the rules scoped to the exact VID:PID pairs you use; do not use a
  wildcard on `idVendor`/`idProduct`.

- hidraw exposes one node per HID *interface*, same as macOS — a keyboard
  with several collections appears as several nodes. `omg devices` lists
  them all; use `--device` with the path or `VID:PID`.
- If `omg` still gets "permission denied", check `ls -l /dev/hidraw*` and
  `udevadm info -a /dev/hidrawN | grep -E 'idVendor|idProduct'`.

## Windows

Backend: hidapi → HIDClass (`HidD_*`/`HidP_*` via SetupAPI).

- No driver installation or permission prompts: Windows exposes vendor HID
  collections to user-mode applications by default.
- GravaStar devices are not on the Windows "blocked device" list; if a
  device fails to enumerate, check Device Manager for an unknown device
  and reinstall the official driver first (some boards need their vendor
  driver to expose the vendor usage page).
- The SparkPlayJoy 6x21 interface has no HID report ID: the wire format is
  64 bytes but Win32 reports are 65 bytes (report-id byte 0 = 0x00).
  `omg-proto-sparkplayjoy` handles both envelopes
  (`docs/protocol-sparkplayjoy.md` §1).

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `omg devices` prints "no GravaStar devices detected", exit 2 | Device not connected / driver missing / filtered out by `classify` | Check `lsusb`/Device Manager; confirm the VID:PID is in `crates/hid/src/devices.rs` |
| Device visible in OS but not in `omg devices` | Identity table gap or wrong usage page | Run `omg probe --device …` (stub), compare usage page with the tables; add the identity with a source comment |
| `error: selector '…' matches N devices` | Multi-interface device (macOS shares one path; Linux shares VID:PID) | Use a more specific selector (product substring, or exact hidraw path). Known gap on macOS — see above |
| `no answer to …` / timeouts | Sleeping wireless link, or wrong interface | For 2.4 GHz mice, move the mouse to wake the link; `omg mouse` appends this hint automatically |
| Writes report `verified: false` | Device rebooted (polling change) or read-back raced | Re-run the read command; `kb polling set` unverified is expected |
| Keyboard vanished after `kb polling set` | Firmware restarts on rate change | Reconnect / wait a few seconds; the setting was still applied |
| `omg kb` says "not an HE keyboard" | `--device` resolved to a khub916 interface, or no HE board attached | `omg devices` shows each interface's `kind`; pick the `he_keyboard_v2` one |
