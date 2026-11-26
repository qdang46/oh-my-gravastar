# Web UI/UX Improvement Specification

**Project:** oh-my-gravastar\
**Status:** Proposed implementation specification\
**Scope:** `web/` only --- independent TypeScript/Vite/WebHID
application\
**Supersedes:** the UI direction in `docs/UIUX-SPEC.md` where it
conflicts with this document\
**Related references:** `docs/UIUX-SPEC.md`, `docs/web-ui-plan.md`,
`docs/vision-full-custom.md`, `docs/SAFETY-SPEC.md`,
`docs/CAPABILITY-MATRIX.md`

------------------------------------------------------------------------

## 1. Product decision

The Web application is a product for people, especially non-technical
users. It is **not** a web frontend for the Rust CLI and must not depend
on the Rust CLI as a backend.

The Web application keeps its own: - TypeScript application and state
model; - WebHID connection and transport lifecycle; - TypeScript
protocol codecs; - capability presentation and feature gating; -
human-oriented validation, preview and confirmation; - browser-side
execution and recovery behavior.

The Web and Rust CLI may implement equivalent device behavior
independently. They should agree on externally observable device
semantics and safety expectations, but must not be forced into a shared
runtime, shared source-code core, or MCP integration.

### Product principles

1.  **Outcome before terminology.** Users ask for an outcome ("make the
    keyboard show HELLO and react to music"), not a protocol operation.
2.  **Simple by default.** Hide protocol IDs, raw keycodes, JSON and
    transport details unless a user explicitly opens advanced details.
3.  **Visual before textual.** Prefer keyboard, lighting, timeline and
    state previews over dense forms.
4.  **Progressive disclosure.** Advanced controls are available where
    supported, but do not dominate the default experience.
5.  **Capability honesty.** Never show a feature as usable unless the
    connected device/firmware/transport supports it.
6.  **Safe by construction.** No write without an explicit user action,
    clear impact, and a truthful recovery statement.
7.  **Offline-first.** Device I/O remains local through WebHID; no cloud
    dependency is introduced by this spec.

## 2. Audit snapshot and known gaps

The inspected implementation is a Vite + vanilla TypeScript PWA with
WebHID and its own `web/src/proto/*` codecs. It already contains
substantial feature modules: dashboard, key remapping, lighting, macro,
advanced keys, music, performance, assistant, diagnostics, profiles,
capability registry, and safety modules.

Observed gaps and inconsistencies:

-   `web/src/pages.ts` currently exposes ten sidebar destinations,
    despite comments/spec text describing a five-item or "at most five"
    navigation.
-   `docs/UIUX-SPEC.md` describes a target Simple/Expert model, but the
    inspected shell does not establish a complete, user-facing
    Simple-first mode system.
-   `web/src/shell.ts` documents an English-only shell; Vietnamese
    localization is not complete.
-   `docs/web-ui-plan.md` still describes a read-only MVP, while the
    current README reports browser writes and read-back verification.
    The document is stale.
-   `docs/UIUX-SPEC.md` and `docs/vision-full-custom.md` contain "one
    shared core/one transaction engine" language. For this product
    decision, interpret this as a Web-local engine only; it must not
    imply a Rust backend or shared runtime with CLI.
-   `web/src/agent/action-schema.ts` and `web/src/agent/*` provide a
    Web-side agent/planning implementation. `docs/agent-api.md`
    describes some of it as library-only/not wired; verify actual route
    and execution wiring during implementation rather than assuming the
    docs are current.
-   Some feature pages are large and mix presentation, editing and
    device behavior. `lighting.ts`, `macro.ts`, `remap.ts` and `perf.ts`
    are candidates for internal decomposition, but avoid a broad rewrite
    without user-visible benefit.
-   Existing capability states and honest "sent, not confirmed" behavior
    are useful foundations and should be retained.

This spec does not assume every listed page or feature is complete. The
implementation phase must reconcile code and documentation before
changing behavior.

## 3. Target information architecture

The primary navigation should represent user goals, not protocol
subsystems.

### Primary navigation

1.  **Home** --- connected device, current state, quick tasks, recent
    activity.
2.  **Lighting** --- colors, effects, scenes and music-reactive
    lighting.
3.  **Keys** --- remapping, layers and per-key behavior.
4.  **Macros** --- create, edit, bind and inspect macros.
5.  **Device** --- connection, profiles, backup/restore, diagnostics and
    settings.

A contextual **Performance** destination may appear only for devices
with relevant Hall-effect capabilities. Do not show an empty or
misleading Performance destination on mechanical keyboards or mice.

The AI assistant should be available as a persistent, clearly
discoverable entry point (for example, a "Describe what you want" action
on Home and feature pages), not necessarily as another permanent
top-level navigation item. Diagnostics and profile history belong under
Device unless user testing proves otherwise.

Existing hash routes must continue to resolve during migration. Old
routes should redirect to the new information architecture rather than
break bookmarks.

### Home screen

Show only useful information: - device name/model and connection type; -
connected / disconnected / read-only / editing-enabled state; - battery
and firmware information when actually available; - current lighting or
active profile summary; - clear quick actions: customize lighting,
change keys, create macro, ask AI, backup; - recent changes and
unresolved warnings.

Do not make raw capability tables or protocol diagnostics the landing
experience.

## 4. First-run and connection experience

### First-run flow

1.  Explain that the app connects directly to the device through the
    browser.
2.  State supported browser/platform requirements before the user clicks
    Connect.
3.  Ask the user to connect/select a device through the browser's WebHID
    picker.
4.  Identify the selected device in plain language.
5.  Load its capabilities and current readable state.
6.  Explain which features are available and which are unavailable, with
    reasons.
7.  Offer a first safe action, such as selecting a lighting preset.
8.  Encourage a backup before the first persistent configuration change.

Do not ask for protocol knowledge, VID/PID, HID usage page, report IDs
or JSON during onboarding.

### Connection states

Model and display these states distinctly: - disconnected; - device
picker open; - connecting; - connected/read-only; - editing enabled; -
reconnect detected/read-only; - device busy with a runtime stream; -
disconnected during operation; - unsupported or partially recognized
device.

A reconnect must never replay queued writes. A reconnect starts
read-only; the user explicitly re-enables editing for that session. If a
write is interrupted, show an uncertain/partial result and require a
fresh read before any retry.

## 5. Feature experience requirements

### 5.1 Lighting Studio

Default flow: 1. Choose a visual preset or "Make my own". 2. Select an
effect using a visual preview. 3. Adjust brightness and speed with
plain-language labels. 4. Select a color or palette. 5. Preview the
result on a representative keyboard. 6. Apply with a concise impact
summary.

Advanced disclosure may expose per-key colors, effect parameters and
supported raw values. Do not expose unsupported controls as disabled
clutter in the default mode.

A scene is a named, reusable composition of all supported lighting
settings, not merely an RGB array. Support local save, rename,
duplicate, delete, import and export with schema validation.

### 5.2 Music-reactive lighting

Treat this as a runtime experience, not just a static lighting setting.

The user-facing flow: 1. Choose a visualizer style. 2. Choose an
available audio source (system audio or microphone, only where the
platform/browser supports it). 3. Explain the browser permission request
before opening it. 4. Show a live audio-level preview before starting
device output. 5. Offer a few understandable controls: sensitivity,
brightness, motion and color palette. 6. Start the effect only after
explicit user action. 7. Show a persistent "Music mode is active"
indicator and a prominent Stop action. 8. On Stop, restore the previous
lighting state when that state was successfully captured. 9. If restore
fails, say so explicitly and provide a recovery action.

The Web app must not imply that every device supports text rendering,
arbitrary pixel animation, music input or real-time frames. Those are
separate capabilities and must be checked individually.

### 5.3 Keymap Studio

Default flow: - show the correct physical keyboard layout; - click a key
to configure it; - offer common actions in plain language; - show a live
before/after keymap preview; - support undo/redo and reset with explicit
scope; - make layer selection understandable.

Advanced disclosure: - full keycode search; - HID usage and raw value
details; - firmware-specific behavior options; - per-layer and system
mapping details.

Physical layout, visual layout and logical key mapping must remain
separate concepts. Never change physical geometry just because a user
remaps a key.

### 5.4 Behavior editor

Start with a small set of understandable choices: - Normal key; - Layer
switch; - Tap one action / hold another; - Toggle; - More customization.

Only show behavior choices the actual device/firmware supports. Explain
timing in human terms before exposing milliseconds. If a behavior is
unverified or cannot be read back, communicate that before the user
applies it.

### 5.5 Macro Studio

Use a timeline or ordered step editor with clear key-down/key-up and
delay visualization. Provide templates for common tasks. Validate: -
missing key release; - stuck modifiers; - unsupported keycodes; -
invalid delays; - device storage limits; - macro binding target and
layer.

Do not silently truncate or rewrite a macro to fit device storage. Show
the exact storage impact before applying.

### 5.6 Performance Studio

Show only on devices with the required Hall-effect capabilities. Use
visual travel/actuation explanations and safe presets before exposing
per-key millimeter values, rapid-trigger thresholds, deadzones or
DKS/MPT details.

Calibration and settings that restart or materially change device
behavior require a stronger, separate confirmation. Hardware-unverified
features must remain clearly labeled and must not be presented as
production-ready.

### 5.7 Device, profiles and safety

Provide: - device identity and firmware information; - connection and
capability summary; - backup/export; - profile compatibility check; -
version history and diff; - section restore where coverage is known; -
diagnostics in a read-only default mode; - activity log with
verified/unverified/partial status.

Never label a restore as guaranteed unless every affected section has a
tested restore path.

## 6. AI interaction in Web

The AI interaction should accept outcomes, ask clarifying questions only
when required, and explain constraints in ordinary language.

Example request: \> "Show HELLO on the LEDs and make the letters bounce
with the bass."

The Web-side assistant should: 1. inspect the currently connected device
and Web capability registry; 2. distinguish static lighting
configuration from real-time animation/audio processing; 3. determine
whether the device supports the required LED addressing/frame output; 4.
determine whether the browser can access the selected audio source; 5.
create a preview/simulation where possible; 6. state unsupported parts
and offer the closest safe alternative; 7. show the exact changes and
impact; 8. execute only after user approval; 9. verify device state and
report runtime status honestly.

Do not promise a result that depends on an unavailable device capability
or browser permission. Do not route the Web assistant through the Rust
CLI.

## 7. Visual design and accessibility

Retain the recognizable dark GravaStar-inspired visual language, but
optimize hierarchy and readability over decorative effects.

Requirements: - consistent spacing, typography, surfaces, control sizes
and semantic colors; - clear contrast for primary, secondary, warning
and destructive actions; - visible focus states and full keyboard
navigation; - accessible names for icon-only controls; - reduced-motion
support; - responsive layout for desktop and tablet; mobile should
remain usable for read/inspect and supported editing; - no information
conveyed by color alone; - loading, empty, unsupported, disconnected,
stale and error states designed explicitly; - no modal stacking; - no
native `window.confirm()` or `window.prompt()` for device mutations.

Use one reusable confirmation surface. It must show: - what will
change; - affected keys/regions/settings; - whether the change is
persistent; - whether a backup was captured; - whether rollback is
supported and its limits; - whether the device may restart/disconnect; -
the confirmation action and cancel action.

For unverified or non-reversible changes, use a stronger confirmation or
block the operation according to policy.

## 8. Capability presentation contract

The Web app keeps its own TypeScript capability registry. This is
independent from the Rust implementation.

Each feature/control should be presented using: - support state:
supported, unsupported hardware, unsupported firmware, unknown protocol,
experimental, unverified; - verification evidence: live, code,
synthetic, none; - reason in plain language; - limits and
dependencies; - read/write availability; - whether persistent; - whether
read-back verified; - recovery coverage.

Default mode: - hide genuinely irrelevant controls; - explain
unavailable features only where users are likely to expect them; - never
advertise an unverified write as fully supported.

Advanced mode: - may expose additional diagnostic detail; - must not
bypass the same safety checks.

## 9. Web-local architecture constraints

Keep the Web implementation independent: - `web/src/hid.ts`: WebHID
connection and transport lifecycle; - `web/src/proto/*`: TypeScript
codecs only, no UI; - `web/src/core/*`: Web device model, capabilities
and feature availability; - `web/src/safety/*`: Web validation, policy,
snapshots, transaction, recovery and audit; - `web/src/agent/*`: Web
assistant planning and execution; - feature modules: user-facing editors
and view models; - UI components: modal, controls, status, preview,
layout and design tokens.

This is not a proposal to import Rust crates into Web, run `omg` as a
backend, or create an MCP layer. The Web and CLI may use separate
implementations while maintaining compatible device semantics and
documented protocol behavior.

Avoid a large framework rewrite. The current app is vanilla
TypeScript/Vite. Introduce reusable components and module boundaries
incrementally without migrating to React/Vue unless a separate technical
decision justifies it.

## 10. Delivery phases

### W0 --- UX foundation

-   reconcile route/navigation and stale docs;
-   define primary navigation and route redirects;
-   implement first-run/connection state presentation;
-   add Vietnamese and English localization infrastructure;
-   establish design tokens, status vocabulary and accessible modal;
-   verify all writes have preview/approval and honest result states.

### W1 --- Human-first core

-   Lighting Studio presets/scenes;
-   Keymap guided flow and diff;
-   Macro timeline and validation;
-   Device backup/history/restore UX;
-   Simple-first progressive disclosure.

### W2 --- Assistant and runtime experiences

-   natural-language outcome flow;
-   device capability explanation;
-   music-reactive permission/preview/start/stop/restore;
-   simulation and safe execution integration.

### W3 --- Device-family expansion

-   expose HE performance only when capability and transport exist;
-   add other families only after protocol and hardware verification;
-   do not let unverified families degrade the K1 Pro experience.

## 11. Acceptance criteria

The Web improvement is accepted only when:

1.  A first-time non-technical user can connect a supported device
    without knowing HID/protocol terms.
2.  Primary navigation contains no more than five user-goal
    destinations, with conditional device-specific areas.
3.  A user can complete common lighting, keymap and macro tasks without
    raw JSON or keycodes.
4.  Unsupported features are not presented as available actions.
5.  Every device write has a clear preview, explicit approval, progress
    and truthful result.
6.  Reconnect never replays a write.
7.  Music-reactive mode explains audio permission, has a visible Stop
    action and reports restore failure honestly.
8.  Backup/restore UI states the exact coverage and limitations.
9.  Core workflows work with keyboard navigation and reduced-motion
    preferences.
10. Web remains independently buildable and usable without the Rust CLI
    installed or running.

## 12. Explicit non-goals

-   Making Web as technically dense or expressive as the Agent CLI.
-   Exposing arbitrary HID reports, raw protocol writes or firmware
    controls to ordinary users.
-   Replacing WebHID with a Rust service.
-   Sharing a compiled runtime/core with Rust.
-   Adding MCP or cloud dependencies.
-   Showing every feature in the navigation regardless of the connected
    device.
