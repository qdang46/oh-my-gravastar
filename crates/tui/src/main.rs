//! `omg-tui` — ratatui TUI dashboard for GravaStar devices.
//!
//! Screens: device list, HE keyboard layout/perf editor, Compx mouse
//! summary, SparkPlayJoy 6x21 travel heatmap, khub916 K1/K98 read-only
//! browser (info/keymap/lighting/macros/profile). Vim-style navigation
//! (hjkl/arrows), `Tab`/`1`-`5` screen switching, `?` help, `q` quit.
//!
//! Safety contract (docs/plan.md §2): the TUI is read-only by default.
//! The only write path is the HE actuation-point edit, which goes through
//! an explicit in-TUI `y/n` confirm, validates the range before sending,
//! and verifies by read-back — the same contract as `omg kb perf set`.
//! The factory-reset / firmware / wipe / gamepad / restart blacklist is
//! never reachable from this binary.
//!
//! `--demo` renders the device screen with synthetic data (no hardware,
//! no TTY required) for smoke testing.

use std::collections::{BTreeMap, HashMap};
use std::io::{self, Stdout};
use std::process::ExitCode;
use std::time::Duration;

use anyhow::{Context, Result};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use crossterm::ExecutableCommand;
use omg_hid::{find_devices, DeviceInfo, DeviceKind};
use omg_proto_he as he;
use omg_proto_khub916 as khub;
use omg_proto_mouse as pm;
use omg_proto_sparkplayjoy as spj;
use ratatui::backend::CrosstermBackend;
use ratatui::buffer::Buffer;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Widget};
use ratatui::{Frame, Terminal};

// ── args ───────────────────────────────────────────────────────────────

const USAGE: &str = "\
omg-tui — ratatui dashboard for GravaStar devices

USAGE:
    omg-tui [--demo] [--help]

OPTIONS:
    --demo    Render one static frame with synthetic devices (no TTY needed)
    --help    Show this help
    -h         Show this help

KEYS (inside the TUI):
    Tab / 1-5   switch screen (devices / keyboard / mouse / sparkplayjoy / k1-k98)
    hjkl/arrows navigate (keyboard layout, k1-k98 keymap scroll)
    [ / ]       cycle khub916 keymap layer (read-only)
    + / -       adjust HE actuation point (asks y/n before writing)
    r           refresh the current screen's device data
    ?           help overlay        Esc/?   close overlay / cancel prompt
    q           quit
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    let demo = args.iter().any(|a| a == "--demo");
    if args.iter().any(|a| a.starts_with('-') && a != "--demo") {
        eprintln!("unknown argument; try --help");
        return ExitCode::from(2);
    }

    let devices = if demo {
        demo_devices()
    } else {
        match find_devices() {
            Ok(d) => d,
            Err(e) => {
                eprintln!("device enumeration failed: {e:#}");
                return ExitCode::from(1);
            }
        }
    };

    let mut app = App::new(devices, demo);
    if demo {
        return demo_render(&mut app);
    }
    match run(&mut app) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("omg-tui: {e:#}");
            ExitCode::from(1)
        }
    }
}

fn demo_devices() -> Vec<DeviceInfo> {
    let mk =
        |vid: u16, pid: u16, page: u16, usage: u16, kind: DeviceKind, product: &str| DeviceInfo {
            path: "demo".into(),
            vid,
            pid,
            product: Some(product.into()),
            manufacturer: Some("GravaStar (demo)".into()),
            usage_page: page,
            usage,
            kind,
        };
    vec![
        mk(
            0x1ca6,
            11272,
            0xffb0,
            0,
            DeviceKind::HeKeyboardV2,
            "Mercury HE (demo)",
        ),
        mk(
            0x3554,
            0xf54b,
            0xff02,
            0,
            DeviceKind::CompxMouse,
            "Mercury X Pro (demo)",
        ),
        mk(
            0x1ca5,
            0x2201,
            0xffa0,
            1,
            DeviceKind::SparkPlayJoy,
            "Mercury HE analog (demo)",
        ),
        mk(
            0x258a,
            0x010c,
            0xff00,
            0,
            DeviceKind::Khub916Wired,
            "Mercury K1 Pro (demo)",
        ),
    ]
}

/// Synthetic khub916 screen state for `--demo` (K1 Pro identity, the
/// live-verified UUID `0x030000000197` → catalog `916_K1_PRO`).
fn demo_khub916(mut st: Khub916Screen) -> Khub916Screen {
    use khub::macro916::{MacroEntry, MacroStep, StepKind};
    st.info = Some(khub::DeviceInfo {
        uuid: khub::Uuid([0x03, 0x00, 0x00, 0x00, 0x01, 0x97]),
        version: 0x0100,
        screen_size: 0,
        screen: None,
        catalog_model: Some("916_K1_PRO".into()),
        catalog_name: Some("GravaStar Mercury K1 PRO".into()),
    });
    st.power = Some(khub::PowerInfo {
        percent: 87,
        flags: 0x11,
    });
    // Synthetic profile blob: mode 2 (breathing) at raw[9..11], sleep 30 s
    // at raw[24], FF FF marker at 40 so decode_light_state finds base 42,
    // brightness 15 at 44, packed speed 8 / mixing at 45.
    let mut raw = vec![0u8; 135];
    raw[10] = 2;
    raw[24] = 30;
    raw[40] = 0xFF;
    raw[41] = 0xFF;
    raw[44] = 15;
    raw[45] = (8 << 4) | 7;
    let profile = khub::Profile { raw };
    st.light_state = khub::light::decode_light_state(&profile);
    st.profile = Some(profile);
    // Synthetic 483-byte light-data blob (23 groups of 21); mode 2's group
    // colour sits at offset 42.
    let mut light = vec![0u8; 483];
    light[42] = 0x40;
    light[43] = 0x80;
    light[44] = 0xFF;
    st.light_data = Some(light);
    // 126-slot synthetic keymap: letters cycle a-z, with a few special
    // values sprinkled in (Fn, macro ref, SOCD, unassigned).
    let mut km = Vec::with_capacity(khub::KEYMAP_ENTRIES);
    for i in 0..126usize {
        km.push(match i {
            10 => khub::KeyValue::Fn { layer: 0 },
            20 => khub::KeyValue::Macro {
                macro_type: 0,
                number: 1,
                index: 0,
            },
            30 => khub::KeyValue::Socd { raw: 0x20000000 },
            40 => khub::KeyValue::SecondaryLayer { raw: 0x07000001 },
            100..=105 => khub::KeyValue::Empty,
            _ => khub::KeyValue::Normal {
                usage: 0x04 + (i % 26) as u16,
                ctrl: i % 17 == 0,
                shift: false,
                alt: false,
                gui: false,
            },
        });
    }
    st.keymap = Some(km);
    st.macros = Some(vec![
        MacroEntry {
            name: "demo-greeting".into(),
            steps: vec![
                MacroStep {
                    action: 0,
                    delay_ms: 40,
                    usage: 11,
                    kind: StepKind::Key,
                },
                MacroStep {
                    action: 1,
                    delay_ms: 30,
                    usage: 11,
                    kind: StepKind::Key,
                },
                MacroStep {
                    action: 0,
                    delay_ms: 50,
                    usage: 5,
                    kind: StepKind::Key,
                },
                MacroStep {
                    action: 1,
                    delay_ms: 40,
                    usage: 5,
                    kind: StepKind::Key,
                },
            ],
        },
        MacroEntry {
            name: "demo-mouse".into(),
            steps: vec![MacroStep {
                action: 0,
                delay_ms: 120,
                usage: 8,
                kind: StepKind::Mouse,
            }],
        },
    ]);
    st
}

// ── app state ──────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum Screen {
    Devices,
    Keyboard,
    Mouse,
    Spark,
    Kh916,
}

impl Screen {
    const ALL: [Screen; 5] = [
        Screen::Devices,
        Screen::Keyboard,
        Screen::Mouse,
        Screen::Spark,
        Screen::Kh916,
    ];
    fn label(self) -> &'static str {
        match self {
            Screen::Devices => "Devices",
            Screen::Keyboard => "Keyboard",
            Screen::Mouse => "Mouse",
            Screen::Spark => "SparkPlayJoy",
            Screen::Kh916 => "K1/K98",
        }
    }
}

/// A pending write awaiting the in-TUI y/n confirm (docs/plan.md §2).
enum Pending {
    /// HE actuation point edit: full read-modify-write `KeyPerf` packet.
    HePerf { row: u8, col: u8, perf: he::KeyPerf },
}

struct Confirm {
    summary: String,
    pending: Pending,
}

struct KbScreen {
    kb: Option<he::HeKeyboard>,
    device_label: String,
    layout: Vec<omg_model::KeyDef>,
    selected: usize,
    perf_cache: HashMap<(u8, u8), he::KeyPerf>,
    step_mm: f32,
    info: Option<he::KeyboardInfo>,
    info_err: Option<String>,
    error: Option<String>,
}

struct MouseScreen {
    mouse: Option<pm::CompxMouse>,
    device_label: String,
    /// LOD table of the identified sensor (`Identity::sensor.lod`).
    sensor_lod: &'static [(u8, &'static str)],
    lines: Vec<String>,
    error: Option<String>,
}

struct Khub916Screen {
    /// Live session; `None` in demo mode (all display data is synthetic).
    kb: Option<khub::Khub916>,
    device_label: String,
    info: Option<khub::DeviceInfo>,
    info_err: Option<String>,
    power: Option<khub::PowerInfo>,
    profile: Option<khub::Profile>,
    light_state: Option<khub::light::LightState>,
    light_data: Option<Vec<u8>>,
    /// Keymap arg (`layer & 3 | (system & 1) << 2`), 0..8.
    keymap_arg: u8,
    keymap: Option<Vec<khub::KeyValue>>,
    keymap_err: Option<String>,
    keymap_scroll: usize,
    macros: Option<Vec<khub::macro916::MacroEntry>>,
    macros_err: Option<String>,
    error: Option<String>,
}

impl Khub916Screen {
    /// Fetch + decode the keymap for `arg` via the live session.
    fn fetch_keymap(&mut self, kb: &mut khub::Khub916, arg: u8) {
        match fetch_keymap(kb, arg) {
            Ok(kv) => {
                self.keymap = Some(kv);
                self.keymap_err = None;
            }
            Err(e) => self.keymap_err = Some(e),
        }
    }
}

/// One read-only cmd-131 round trip; errors are strings for display.
fn fetch_keymap(kb: &mut khub::Khub916, arg: u8) -> std::result::Result<Vec<khub::KeyValue>, String> {
    kb.keymap(arg).map_err(|e| format!("{e:#}"))
}

struct SparkScreen {
    sp: Option<spj::SparkPlayJoy>,
    device_label: String,
    board_id: Option<u32>,
    app_version: Option<String>,
    scale: Option<spj::TravelScale>,
    travel: Option<spj::TravelMatrix>,
    map: Option<spj::KeyMap>,
    error: Option<String>,
}

struct App {
    devices: Vec<DeviceInfo>,
    screen: Screen,
    help: bool,
    demo: bool,
    status: String,
    confirm: Option<Confirm>,
    kb: Option<KbScreen>,
    mouse: Option<MouseScreen>,
    spark: Option<SparkScreen>,
    kh916: Option<Khub916Screen>,
    quit: bool,
}

impl App {
    fn new(devices: Vec<DeviceInfo>, demo: bool) -> Self {
        Self {
            devices,
            screen: Screen::Devices,
            help: false,
            demo,
            status: if demo {
                "demo mode — synthetic devices, hardware I/O disabled".into()
            } else {
                String::new()
            },
            confirm: None,
            kb: None,
            mouse: None,
            spark: None,
            kh916: None,
            quit: false,
        }
    }

    fn first_of(&self, kind: DeviceKind) -> Option<&DeviceInfo> {
        self.devices.iter().find(|d| d.kind == kind)
    }

    /// (Re)load the state for `screen`. Cancels any pending write — a
    /// confirm belongs to the screen that raised it.
    fn enter(&mut self, screen: Screen) {
        self.screen = screen;
        self.confirm = None;
        match screen {
            Screen::Devices => {}
            Screen::Keyboard => {
                if self.kb.is_none() {
                    self.kb = Some(self.load_kb());
                }
            }
            Screen::Mouse => {
                if self.mouse.is_none() {
                    self.mouse = Some(self.load_mouse());
                }
            }
            Screen::Spark => {
                if self.spark.is_none() {
                    self.spark = Some(self.load_spark());
                }
            }
            Screen::Kh916 => {
                if self.kh916.is_none() {
                    self.kh916 = Some(self.load_khub916());
                }
            }
        }
    }

    fn refresh(&mut self) {
        match self.screen {
            Screen::Devices => {}
            Screen::Keyboard => {
                self.kb = Some(self.load_kb());
            }
            Screen::Mouse => {
                self.mouse = Some(self.load_mouse());
            }
            Screen::Spark => {
                self.spark = Some(self.load_spark());
            }
            Screen::Kh916 => {
                self.kh916 = Some(self.load_khub916());
            }
        }
        self.status = format!("{} refreshed", self.screen.label());
    }

    // ── device loaders ────────────────────────────────────────────────

    fn load_kb(&self) -> KbScreen {
        let mut st = KbScreen {
            kb: None,
            device_label: String::new(),
            layout: Vec::new(),
            selected: 0,
            perf_cache: HashMap::new(),
            step_mm: 0.1,
            info: None,
            info_err: None,
            error: None,
        };
        if self.demo {
            st.error = Some("demo mode — keyboard I/O disabled".into());
            return st;
        }
        let Some(d) = self.first_of(DeviceKind::HeKeyboardV2) else {
            st.error = Some("no HE keyboard (v2 protocol) detected — see Devices screen".into());
            return st;
        };
        st.device_label = format!("{} ({})", d.vid_pid(), d.kind.label());
        let link = match d.open_link() {
            Ok(l) => l,
            Err(e) => {
                st.error = Some(format!("open {}: {e:#}", d.vid_pid()));
                return st;
            }
        };
        let mut kb = he::HeKeyboard::new(Box::new(link));
        match kb.info() {
            Ok(i) => st.info = Some(i),
            Err(e) => st.info_err = Some(format!("{e:#}")),
        }
        match kb.rt_precision() {
            Ok(p) if p > 0.0 => st.step_mm = p.clamp(0.01, 0.5),
            _ => {}
        }
        match kb.key_slots() {
            Ok(slots) => {
                // Layer-0 keycodes for every row that has keys (as `omg kb layout`).
                let mut rows: Vec<u8> = slots.iter().map(|s| s.row).collect();
                rows.sort_unstable();
                rows.dedup();
                let mut codes: BTreeMap<u8, [u16; 21]> = BTreeMap::new();
                let mut code_err = None;
                for &row in &rows {
                    match kb.key_codes(0, row) {
                        Ok(c) => {
                            codes.insert(row, c);
                        }
                        Err(e) => {
                            code_err = Some(format!("key_codes row {row}: {e:#}"));
                            break;
                        }
                    }
                }
                if let Some(e) = code_err {
                    st.error = Some(e);
                }
                // he::KeySlot and omg_model::KeySlot are distinct types
                // with identical fields; convert explicitly.
                let model_slots: Vec<omg_model::KeySlot> = slots
                    .iter()
                    .map(|s| omg_model::KeySlot {
                        row: s.row,
                        col: s.col,
                        x: s.x,
                        y: s.y,
                        size: s.size,
                    })
                    .collect();
                st.layout = omg_model::build_layout(
                    &model_slots,
                    &|row, col| codes.get(&row).map(|c| c[col as usize]).unwrap_or(0),
                    false,
                );
            }
            Err(e) => st.error = Some(format!("key_slots: {e:#}")),
        }
        st.kb = Some(kb);
        st
    }

    fn load_mouse(&self) -> MouseScreen {
        let mut st = MouseScreen {
            mouse: None,
            device_label: String::new(),
            sensor_lod: &[],
            lines: Vec::new(),
            error: None,
        };
        if self.demo {
            st.error = Some("demo mode — mouse I/O disabled".into());
            return st;
        }
        let Some(d) = self.first_of(DeviceKind::CompxMouse) else {
            st.error = Some("no Compx mouse detected — see Devices screen".into());
            return st;
        };
        st.device_label = format!("{} ({})", d.vid_pid(), d.kind.label());
        let link = match d.open_link() {
            Ok(l) => l,
            Err(e) => {
                st.error = Some(format!("open {}: {e:#}", d.vid_pid()));
                return st;
            }
        };
        let mut m = pm::CompxMouse::new(Box::new(link));
        match m.identify() {
            Ok(id) => st.sensor_lod = id.sensor.lod,
            Err(e) => {
                st.error = Some(format!("identify: {e:#}"));
                return st;
            }
        }
        st.mouse = Some(m);
        st.refresh_lines();
        st
    }

    fn load_spark(&self) -> SparkScreen {
        let mut st = SparkScreen {
            sp: None,
            device_label: String::new(),
            board_id: None,
            app_version: None,
            scale: None,
            travel: None,
            map: None,
            error: None,
        };
        if self.demo {
            st.error = Some("demo mode — SparkPlayJoy I/O disabled".into());
            return st;
        }
        let Some(d) = self.first_of(DeviceKind::SparkPlayJoy) else {
            st.error = Some("no SparkPlayJoy device detected — see Devices screen".into());
            return st;
        };
        st.device_label = format!("{} ({})", d.vid_pid(), d.kind.label());
        let link = match d.open_link() {
            Ok(l) => l,
            Err(e) => {
                st.error = Some(format!("open {}: {e:#}", d.vid_pid()));
                return st;
            }
        };
        let mut sp = spj::SparkPlayJoy::new(Box::new(link));
        // Serial numbers are never displayed (privacy rule, AGENTS.md §5).
        match sp.sync() {
            Ok(s) => {
                st.board_id = Some(s.board_id);
                st.app_version = Some(s.app_version);
            }
            Err(e) => st.error = Some(format!("sync: {e:#}")),
        }
        match sp.scale() {
            Ok(s) => st.scale = Some(s),
            Err(e) => st.error = Some(format!("scale: {e:#}")),
        }
        match sp.default_map() {
            Ok(m) => st.map = Some(m),
            Err(e) => st.error = Some(format!("default_map: {e:#}")),
        }
        match sp.travel() {
            Ok(t) => st.travel = Some(t),
            Err(e) => st.error = Some(format!("travel: {e:#}")),
        }
        st.sp = Some(sp);
        st
    }

    fn load_khub916(&self) -> Khub916Screen {
        let mut st = Khub916Screen {
            kb: None,
            device_label: String::new(),
            info: None,
            info_err: None,
            power: None,
            profile: None,
            light_state: None,
            light_data: None,
            keymap_arg: 0,
            keymap: None,
            keymap_err: None,
            keymap_scroll: 0,
            macros: None,
            macros_err: None,
            error: None,
        };
        let label = self
            .first_of(DeviceKind::Khub916Wired)
            .map(|d| format!("{} ({})", d.vid_pid(), d.kind.label()))
            .unwrap_or_else(|| "khub916 (no device)".into());
        st.device_label = label;
        if self.demo {
            return demo_khub916(st);
        }
        let Some(d) = self.first_of(DeviceKind::Khub916Wired) else {
            st.error = Some("no khub916 wired keyboard detected — see Devices screen".into());
            return st;
        };
        let mut link = match d.open_link() {
            Ok(l) => l,
            Err(e) => {
                st.error = Some(format!("open {}: {e:#}", d.vid_pid()));
                return st;
            }
        };
        // hidapi does not expose report descriptors; probe for the feature
        // report id with the read-only device-info query (spec §1).
        let report_id = match khub::probe_report_id(&mut link) {
            Ok(id) => id,
            Err(e) => {
                st.error = Some(format!("report id probe: {e:#}"));
                return st;
            }
        };
        let mut kb = khub::Khub916::new(Box::new(link), report_id);
        match kb.device_info() {
            Ok(i) => st.info = Some(i),
            Err(e) => st.info_err = Some(format!("{e:#}")),
        }
        match kb.power() {
            Ok(p) => st.power = Some(p),
            Err(e) => st.error = Some(format!("power: {e:#}")),
        }
        match kb.profile() {
            Ok(p) => {
                st.light_state = khub::light::decode_light_state(&p);
                st.profile = Some(p);
            }
            Err(e) => st.error = Some(format!("profile: {e:#}")),
        }
        match kb.light_color_data() {
            Ok(d) => st.light_data = Some(d),
            Err(e) => st.error = Some(format!("light data: {e:#}")),
        }
        st.fetch_keymap(&mut kb, 0);
        match kb.macro_region() {
            Ok(region) => match khub::macro916::parse_macro_region(&region) {
                Ok(entries) => st.macros = Some(entries),
                Err(e) => st.macros_err = Some(format!("{e:#}")),
            },
            Err(e) => st.macros_err = Some(format!("{e:#}")),
        }
        st.kb = Some(kb);
        st
    }

    /// (Re)fetch the keymap for `arg` through the live session. In demo
    /// mode the synthetic keymap is kept as-is.
    fn kh916_keymap(&mut self, arg: u8) {
        let Some(st) = self.kh916.as_mut() else { return };
        st.keymap_arg = arg;
        st.keymap_scroll = 0;
        // Split the borrows: the session and the display fields are
        // disjoint, but `fetch_keymap` needs `&mut self` for its result.
        let fetched = st.kb.as_mut().map(|kb| fetch_keymap(kb, arg));
        if let Some(res) = fetched {
            match res {
                Ok(kv) => {
                    st.keymap = Some(kv);
                    st.keymap_err = None;
                }
                Err(e) => st.keymap_err = Some(e),
            }
        }
    }

    // ── HE keyboard editing (the only write path) ────────────────────

    /// `+`/`-`: stage an actuation-point change behind the y/n confirm.
    fn stage_actuation_edit(&mut self, delta: f32) {
        let (row, col, label) = {
            let Some(kb) = self.kb.as_ref() else { return };
            let Some(k) = kb.layout.get(kb.selected) else {
                return;
            };
            (k.row, k.col, k.label.clone())
        };
        let Some(perf) = self.kb.as_mut().and_then(|k| k.selected_perf()) else {
            self.status = "could not read key perf".into();
            return;
        };
        let max_travel = omg_model::max_travel(perf.axis_v2_id);
        // The mode's primary actuation field, same rule as `omg kb perf set`.
        let rt = perf.mode == he::MODE_RAPID;
        let old = if rt {
            perf.rt_first_touch
        } else {
            perf.normal_press
        };
        let step = self.kb.as_ref().map(|k| k.step_mm).unwrap_or(0.1);
        let new = (old + delta * step).clamp(step, max_travel);
        if (new - old).abs() < 0.0005 {
            self.status = format!("actuation already at limit ({old:.3} mm)");
            return;
        }
        let mut p = perf;
        if rt {
            p.rt_first_touch = new;
        } else {
            p.normal_press = new;
        }
        let field = if rt { "rt_first_touch" } else { "normal_press" };
        self.confirm = Some(Confirm {
            summary: format!(
                "r{row} c{col} '{label}': {field} {old:.3} -> {new:.3} mm ({}) on {}",
                if rt {
                    "rapid trigger"
                } else {
                    "fixed actuation"
                },
                self.kb
                    .as_ref()
                    .map(|k| k.device_label.as_str())
                    .unwrap_or("")
            ),
            pending: Pending::HePerf { row, col, perf: p },
        });
    }

    /// Execute the confirmed write: send, read back, verify (plan.md §2.3).
    fn run_confirm(&mut self) {
        let Some(c) = self.confirm.take() else { return };
        let Pending::HePerf { row, col, perf } = c.pending;
        let Some(kb) = self.kb.as_mut() else {
            self.status = "no keyboard session".into();
            return;
        };
        let Some(dev) = kb.kb.as_mut() else {
            self.status = "no keyboard session".into();
            return;
        };
        match dev.set_key_perf(row, col, &perf) {
            Ok(()) => match dev.key_perf(row, col) {
                Ok(actual) => {
                    let verified = actual == perf;
                    kb.perf_cache.insert((row, col), actual);
                    self.status = format!(
                        "r{row} c{col}: write {} ({})",
                        if verified {
                            "verified"
                        } else {
                            "MISMATCH — read-back differs"
                        },
                        c.summary
                    );
                }
                Err(e) => {
                    self.status = format!("r{row} c{col}: write sent, read-back failed: {e:#}")
                }
            },
            Err(e) => self.status = format!("r{row} c{col}: write failed: {e:#}"),
        }
    }

    // ── keyboard navigation ───────────────────────────────────────────

    fn kb_move(&mut self, dx: i32, dy: i32) {
        let Some(kb) = self.kb.as_mut() else { return };
        let n = kb.layout.len();
        if n == 0 {
            return;
        }
        let cur = kb.layout[kb.selected.min(n - 1)].clone();
        kb.selected = kb.selected.min(n - 1);
        let idx = kb.selected;
        let next = if dx != 0 {
            // Same matrix row, nearest key left/right by x.
            let mut best: Option<(f32, usize)> = None;
            for (i, k) in kb.layout.iter().enumerate() {
                if k.row != cur.row {
                    continue;
                }
                let d = k.x - cur.x;
                if (dx < 0 && d < -0.01) || (dx > 0 && d > 0.01) {
                    let score = d.abs();
                    if best.map(|(s, _)| score < s).unwrap_or(true) {
                        best = Some((score, i));
                    }
                }
            }
            best.map(|(_, i)| i).unwrap_or(idx)
        } else {
            // Nearest row up/down, closest x within that row.
            let mut rows: Vec<u8> = kb.layout.iter().map(|k| k.row).collect();
            rows.sort_unstable();
            rows.dedup();
            let pos = rows.iter().position(|&r| r == cur.row).unwrap_or(0);
            let target = if dy < 0 {
                pos.checked_sub(1)
            } else {
                (pos + 1 < rows.len()).then_some(pos + 1)
            };
            let Some(t) = target else { return };
            let row = rows[t];
            let mut best: Option<(f32, usize)> = None;
            for (i, k) in kb.layout.iter().enumerate() {
                if k.row != row {
                    continue;
                }
                let score = (k.x - cur.x).abs();
                if best.map(|(s, _)| score < s).unwrap_or(true) {
                    best = Some((score, i));
                }
            }
            best.map(|(_, i)| i).unwrap_or(idx)
        };
        kb.selected = next;
        // Drop the perf cache entry pressure: perf is read lazily on draw.
    }

    // ── input ─────────────────────────────────────────────────────────

    fn handle_key(&mut self, key: KeyEvent) {
        if key.kind == KeyEventKind::Release {
            return; // Windows also emits release events; act on press only.
        }
        if self.confirm.is_some() {
            match key.code {
                KeyCode::Char('y') | KeyCode::Char('Y') => self.run_confirm(),
                KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => {
                    self.confirm = None;
                    self.status = "write cancelled".into();
                }
                _ => {}
            }
            return;
        }
        if self.help {
            match key.code {
                KeyCode::Char('?') | KeyCode::Esc => self.help = false,
                KeyCode::Char('q') => self.quit = true,
                _ => {}
            }
            return;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Char('q') | KeyCode::Char('Q') if !ctrl => self.quit = true,
            KeyCode::Char('c') if ctrl => self.quit = true,
            KeyCode::Char('?') => self.help = true,
            KeyCode::Tab => {
                let i = Screen::ALL
                    .iter()
                    .position(|&s| s == self.screen)
                    .unwrap_or(0);
                self.enter(Screen::ALL[(i + 1) % Screen::ALL.len()]);
            }
            KeyCode::Char('1') => self.enter(Screen::Devices),
            KeyCode::Char('2') => self.enter(Screen::Keyboard),
            KeyCode::Char('3') => self.enter(Screen::Mouse),
            KeyCode::Char('4') => self.enter(Screen::Spark),
            KeyCode::Char('5') => self.enter(Screen::Kh916),
            KeyCode::Char('r') | KeyCode::Char('R') => self.refresh(),
            _ => self.screen_key(key),
        }
    }

    fn screen_key(&mut self, key: KeyEvent) {
        match self.screen {
            Screen::Keyboard => match key.code {
                KeyCode::Char('h') | KeyCode::Left => self.kb_move(-1, 0),
                KeyCode::Char('l') | KeyCode::Right => self.kb_move(1, 0),
                KeyCode::Char('k') | KeyCode::Up => self.kb_move(0, -1),
                KeyCode::Char('j') | KeyCode::Down => self.kb_move(0, 1),
                KeyCode::Char('+') => self.stage_actuation_edit(1.0),
                KeyCode::Char('-') => self.stage_actuation_edit(-1.0),
                _ => {}
            },
            Screen::Kh916 => self.kh916_key(key),
            _ => {}
        }
    }

    /// khub916 screen keys: j/k scroll the keymap, [ / ] cycle the keymap
    /// arg (read-only fetches only — this screen never writes).
    fn kh916_key(&mut self, key: KeyEvent) {
        let arg = {
            let Some(st) = self.kh916.as_mut() else { return };
            match key.code {
                KeyCode::Char('j') | KeyCode::Down => {
                    st.keymap_scroll = st.keymap_scroll.saturating_add(1);
                    return;
                }
                KeyCode::Char('k') | KeyCode::Up => {
                    st.keymap_scroll = st.keymap_scroll.saturating_sub(1);
                    return;
                }
                KeyCode::Char(']') | KeyCode::Char('}') => (st.keymap_arg + 1) % 8,
                KeyCode::Char('[') | KeyCode::Char('{') => (st.keymap_arg + 7) % 8,
                _ => return,
            }
        };
        self.kh916_keymap(arg);
    }
}

// ── event loop ─────────────────────────────────────────────────────────

fn run(app: &mut App) -> Result<()> {
    enable_raw_mode().context("enable raw mode")?;
    let mut stdout = io::stdout();
    stdout
        .execute(EnterAlternateScreen)
        .context("enter alternate screen")?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend).context("init terminal")?;

    let result = event_loop(&mut terminal, app);

    disable_raw_mode().ok();
    terminal.backend_mut().execute(LeaveAlternateScreen).ok();
    terminal.show_cursor().ok();
    result
}

fn event_loop(terminal: &mut Terminal<CrosstermBackend<Stdout>>, app: &mut App) -> Result<()> {
    loop {
        terminal.draw(|f| draw(f, app))?;
        if !event::poll(Duration::from_millis(200))? {
            continue;
        }
        match event::read()? {
            Event::Key(key) => app.handle_key(key),
            Event::Resize(_, _) => {}
            _ => {}
        }
        if app.quit {
            break;
        }
    }
    Ok(())
}

// ── demo render (no TTY) ────────────────────────────────────────────────

fn demo_render(app: &mut App) -> ExitCode {
    let backend = ratatui::backend::TestBackend::new(110, 36);
    let mut terminal = Terminal::new(backend).expect("test backend");
    terminal.draw(|f| draw(f, app)).expect("draw");
    let buf = terminal.backend().buffer();
    let mut out = String::new();
    for y in 0..buf.area.height {
        let mut line = String::new();
        for x in 0..buf.area.width {
            line.push(buf[(x, y)].symbol().chars().next().unwrap_or(' '));
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    print!("{out}");
    ExitCode::SUCCESS
}

// ── drawing ────────────────────────────────────────────────────────────

fn draw(f: &mut Frame, app: &mut App) {
    let area = f.area();
    // Header: title + screen tabs.
    let header = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .split(area);
    let tabs = Screen::ALL
        .iter()
        .map(|s| {
            let n = Screen::ALL.iter().position(|x| x == s).unwrap() + 1;
            if *s == app.screen {
                Span::styled(
                    format!(" {n}:{} ", s.label()),
                    Style::default()
                        .add_modifier(Modifier::BOLD)
                        .fg(Color::Black)
                        .bg(Color::Cyan),
                )
            } else {
                Span::styled(
                    format!(" {n}:{} ", s.label()),
                    Style::default().fg(Color::DarkGray),
                )
            }
        })
        .collect::<Vec<_>>();
    f.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(" omg-tui ", Style::default().add_modifier(Modifier::BOLD)),
            Span::raw("GravaStar dashboard — "),
        ]))
        .style(Style::default()),
        Rect {
            x: 0,
            y: 0,
            width: area.width,
            height: 1,
        },
    );
    // Draw tabs on the same row after the title.
    // Tabs start after the title text (" omg-tui GravaStar dashboard — ").
    let tab_area = Rect {
        x: 30.min(area.width),
        y: 0,
        width: area.width.saturating_sub(30),
        height: 1,
    };
    if tab_area.width > 0 {
        f.render_widget(Paragraph::new(Line::from(tabs)), tab_area);
    }

    let body = header[1];
    match app.screen {
        Screen::Devices => draw_devices(f, body, app),
        Screen::Keyboard => draw_keyboard(f, body, app),
        Screen::Mouse => draw_mouse(f, body, app),
        Screen::Spark => draw_spark(f, body, app),
        Screen::Kh916 => draw_khub916(f, body, app),
    }

    // Status / hint bar.
    let hint = if app.confirm.is_some() {
        "confirm: y write / n cancel".to_string()
    } else {
        format!(
            "{}  |  Tab screens · hjkl nav · +/- actuation · r refresh · ? help · q quit",
            app.status
        )
    };
    f.render_widget(
        Paragraph::new(hint).style(Style::default().fg(Color::DarkGray)),
        header[2],
    );

    if app.help {
        draw_help(f, area);
    }
    if let Some(c) = &app.confirm {
        draw_confirm(f, area, c);
    }
}

fn draw_devices(f: &mut Frame, area: Rect, app: &App) {
    if app.devices.is_empty() {
        f.render_widget(
            Paragraph::new("no GravaStar devices detected\n\nconnect a supported keyboard or mouse and press r").block(Block::default().borders(Borders::ALL).title(" Devices ")),
            area,
        );
        return;
    }
    let mut lines = Vec::new();
    for (i, d) in app.devices.iter().enumerate() {
        lines.push(Line::from(vec![
            Span::styled(format!(" {:>2} ", i + 1), Style::default().fg(Color::Cyan)),
            Span::styled(
                format!(" {:<10} ", d.vid_pid()),
                Style::default().add_modifier(Modifier::BOLD),
            ),
            Span::styled(format!("{:<38} ", d.kind.label()), Style::default()),
            Span::styled(
                d.product.clone().unwrap_or_default(),
                Style::default().fg(Color::DarkGray),
            ),
        ]));
        let mut detail = vec![
            Span::raw("      path: "),
            Span::styled(d.path.clone(), Style::default().fg(Color::DarkGray)),
            Span::raw("   usage_page: "),
            Span::styled(
                format!("0x{:04x}", d.usage_page),
                Style::default().fg(Color::DarkGray),
            ),
            Span::raw(" usage: "),
            Span::styled(
                format!("0x{:04x}", d.usage),
                Style::default().fg(Color::DarkGray),
            ),
        ];
        if let Some(m) = &d.manufacturer {
            detail.push(Span::raw("   mfr: "));
            detail.push(Span::styled(
                m.clone(),
                Style::default().fg(Color::DarkGray),
            ));
        }
        lines.push(Line::from(detail));
        lines.push(Line::from(""));
    }
    f.render_widget(
        Paragraph::new(lines).block(Block::default().borders(Borders::ALL).title(" Devices ")),
        area,
    );
}

impl KbScreen {
    /// Perf of the selected key: cache first, then one HID read.
    fn selected_perf(&mut self) -> Option<he::KeyPerf> {
        let k = self.layout.get(self.selected)?;
        let key = (k.row, k.col);
        if let Some(&p) = self.perf_cache.get(&key) {
            return Some(p);
        }
        let p = self.kb.as_mut()?.key_perf(k.row, k.col).ok()?;
        self.perf_cache.insert(key, p);
        Some(p)
    }
}

// ── keyboard screen ────────────────────────────────────────────────────

/// Renders the physical layout: KeyDef x/y/w/h in key units → terminal
/// cells. A char cell is ~2× taller than wide, so the vertical scale is
/// half the horizontal one to keep keys visually square.
struct KeyGrid<'a> {
    defs: &'a [omg_model::KeyDef],
    selected: usize,
}

impl Widget for KeyGrid<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.width < 4 || area.height < 2 || self.defs.is_empty() {
            return;
        }
        let units_w = self
            .defs
            .iter()
            .map(|k| k.x + k.w)
            .fold(0.0f32, f32::max)
            .max(0.1);
        let units_h = self
            .defs
            .iter()
            .map(|k| k.y + k.h)
            .fold(0.0f32, f32::max)
            .max(0.1);
        let sx = (area.width as f32 / units_w).floor();
        let sy = (sx * 0.5).min(area.height as f32 / units_h).max(1.0);
        for (i, k) in self.defs.iter().enumerate() {
            let x0 = area.x + (k.x * sx).round() as u16;
            let y0 = area.y + (k.y * sy).round() as u16;
            let w = ((k.w * sx).round() as u16).max(1);
            let h = ((k.h * sy).round() as u16).max(1);
            let r = Rect {
                x: x0,
                y: y0,
                width: w.min(area.right().saturating_sub(x0)),
                height: h.min(area.bottom().saturating_sub(y0)),
            };
            if r.width == 0 || r.height == 0 {
                continue;
            }
            let selected = i == self.selected;
            let style = if selected {
                Style::default()
                    .bg(Color::Rgb(58, 95, 160))
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().bg(Color::Rgb(38, 38, 48)).fg(Color::Gray)
            };
            buf.set_style(r, style);
            // Centre the legend on the key's middle row.
            let label = truncate(&k.label, r.width.saturating_sub(1) as usize);
            if !label.is_empty() && r.height > 0 {
                let lw = label.chars().count() as u16;
                let lx = r.x + r.width.saturating_sub(lw) / 2;
                let ly = r.y + r.height / 2;
                buf.set_stringn(lx, ly, label, r.width as usize, style);
            }
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

fn perf_lines(kb: &KbScreen, perf: Option<&he::KeyPerf>) -> Vec<Line<'static>> {
    let mut v = Vec::new();
    if let Some(info) = &kb.info {
        v.push(Line::from(vec![
            Span::raw("fw "),
            Span::styled(info.firmware.clone(), Style::default().fg(Color::Cyan)),
            Span::raw("  pcb "),
            Span::styled(info.pcb.clone(), Style::default().fg(Color::Cyan)),
            Span::raw("  proto "),
            Span::styled(info.protocol.clone(), Style::default().fg(Color::Cyan)),
        ]));
    } else if let Some(e) = &kb.info_err {
        v.push(Line::from(Span::styled(
            format!("info: {e}"),
            Style::default().fg(Color::Yellow),
        )));
    }
    v.push(Line::from(""));
    let Some(k) = kb.layout.get(kb.selected) else {
        v.push(Line::from(Span::styled(
            "no keys in layout",
            Style::default().fg(Color::Yellow),
        )));
        return v;
    };
    v.push(Line::from(vec![
        Span::styled(
            format!("key r{} c{}", k.row, k.col),
            Style::default().add_modifier(Modifier::BOLD),
        ),
        Span::raw(format!("  '{}'  ({}x{})", k.label, k.w, k.h)),
    ]));
    match perf {
        Some(p) => {
            let mode = if p.mode == he::MODE_RAPID {
                "rapid trigger"
            } else {
                "fixed actuation"
            };
            let act = if p.mode == he::MODE_RAPID {
                p.rt_first_touch
            } else {
                p.normal_press
            };
            v.push(Line::from(format!("  mode:          {mode}")));
            v.push(Line::from(format!(
                "  actuation:     {act:.3} mm   (+/- step {:.3})",
                kb.step_mm
            )));
            v.push(Line::from(format!(
                "  normal press:  {:.3} mm",
                p.normal_press
            )));
            v.push(Line::from(format!(
                "  normal release:{:.3} mm",
                p.normal_release
            )));
            v.push(Line::from(format!(
                "  rt first:      {:.3} mm",
                p.rt_first_touch
            )));
            v.push(Line::from(format!("  rt press:      {:.3} mm", p.rt_press)));
            v.push(Line::from(format!(
                "  rt release:    {:.3} mm",
                p.rt_release
            )));
            v.push(Line::from(format!(
                "  deadzones:     {:.3} / {:.3} mm",
                p.press_deadzone, p.release_deadzone
            )));
            v.push(Line::from(format!(
                "  switch:        id {} max {:.1} mm",
                p.axis_v2_id,
                omg_model::max_travel(p.axis_v2_id)
            )));
        }
        None => {
            v.push(Line::from(Span::styled(
                "  perf: (unavailable)",
                Style::default().fg(Color::Yellow),
            )));
        }
    }
    v.push(Line::from(""));
    v.push(Line::from(Span::styled(
        "hjkl/arrows move · +/- actuation (y/n confirm) · r reload layout",
        Style::default().fg(Color::DarkGray),
    )));
    v
}

fn draw_keyboard(f: &mut Frame, area: Rect, app: &mut App) {
    let Some(kb) = app.kb.as_mut() else {
        f.render_widget(
            Paragraph::new("keyboard screen not initialised")
                .block(Block::default().borders(Borders::ALL)),
            area,
        );
        return;
    };
    let cols = Layout::horizontal([Constraint::Min(30), Constraint::Length(38)]).split(area);
    let grid_area = Rect {
        x: cols[0].x + 1,
        y: cols[0].y + 1,
        width: cols[0].width.saturating_sub(2),
        height: cols[0].height.saturating_sub(2),
    };
    let selected = kb.selected.min(kb.layout.len().saturating_sub(1));
    let perf = kb.selected_perf();
    let mut lines = perf_lines(kb, perf.as_ref());
    if let Some(e) = &kb.error {
        lines.insert(
            0,
            Line::from(Span::styled(
                format!("error: {e}"),
                Style::default().fg(Color::Red),
            )),
        );
        lines.insert(1, Line::from(""));
    }
    if kb.layout.is_empty() {
        lines.push(Line::from(""));
        lines.push(Line::from("no layout data — press r to retry"));
    }
    f.render_widget(
        Paragraph::new(lines).block(
            Block::default()
                .borders(Borders::ALL)
                .title(" Performance "),
        ),
        cols[1],
    );
    if !kb.layout.is_empty() {
        f.render_widget(
            KeyGrid {
                defs: &kb.layout,
                selected,
            },
            grid_area,
        );
    } else {
        f.render_widget(
            Paragraph::new(if kb.error.is_some() {
                "layout unavailable — see Performance panel"
            } else {
                "no keys"
            })
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(format!(" Keyboard — {} ", kb.device_label)),
            ),
            cols[0],
        );
    }
}

// ── mouse screen ───────────────────────────────────────────────────────

impl MouseScreen {
    fn refresh_lines(&mut self) {
        self.lines.clear();
        let Some(m) = self.mouse.as_mut() else { return };
        // identity
        match m.identify() {
            Ok(id) => {
                self.lines
                    .push(format!("model:      {}", id.model.unwrap_or("unknown")));
                self.lines.push(format!(
                    "sensor:     {} (max {} DPI)",
                    id.sensor.name, id.sensor.max_dpi
                ));
                self.lines.push(format!(
                    "link:       {} · max poll {} Hz",
                    if id.wired {
                        "wired"
                    } else {
                        "2.4 GHz receiver"
                    },
                    id.max_rate
                ));
            }
            Err(e) => self.lines.push(format!("identify: error — {e:#}")),
        }
        if let Ok((mouse, dongle)) = m.firmware() {
            self.lines.push(format!(
                "firmware:   mouse {mouse} · receiver {}",
                dongle.unwrap_or_else(|| "?".into())
            ));
        }
        // battery (may be absent on wired-only units)
        match m.battery() {
            Ok(b) => self.lines.push(format!(
                "battery:    {}% · {} mV{}",
                b.level,
                b.millivolts,
                if b.charging { " · charging" } else { "" }
            )),
            Err(e) => self.lines.push(format!("battery:    unavailable ({e:#})")),
        }
        match m.read_config() {
            Ok(cfg) => {
                self.lines.push(String::new());
                self.lines.push(format!(
                    "polling:    {} Hz (stage {})",
                    cfg.report_rate,
                    cfg.current_stage + 1
                ));
                self.lines.push(format!("stages:     {}", cfg.stage_count));
                for i in 0..cfg.stage_count.min(pm::MAX_STAGES) {
                    let mark = if i == cfg.current_stage { "*" } else { " " };
                    self.lines
                        .push(format!("  {mark} DPI {}: {}", i + 1, cfg.dpi[i]));
                }
                let lod_label = self
                    .sensor_lod
                    .iter()
                    .find(|(v, _)| *v == cfg.lod)
                    .map(|(_, l)| (*l).to_string())
                    .unwrap_or_else(|| format!("raw {}", cfg.lod));
                self.lines.push(format!("LOD:        {}", lod_label));
                self.lines.push(format!(
                    "light:      mode {} · brightness {} · speed {}",
                    cfg.light.mode, cfg.light.brightness, cfg.light.speed
                ));
                self.lines.push(format!("debounce:   {} ms", cfg.debounce));
                self.lines.push(format!(
                    "flags:      motion_sync={} angle_snap={} ripple={} sleep={}x10s",
                    cfg.motion_sync, cfg.angle_snap, cfg.ripple, cfg.sleep
                ));
            }
            Err(e) => self.lines.push(format!("config:     error — {e:#}")),
        }
    }
}

fn draw_mouse(f: &mut Frame, area: Rect, app: &mut App) {
    let Some(st) = app.mouse.as_mut() else {
        f.render_widget(
            Paragraph::new("mouse screen not initialised")
                .block(Block::default().borders(Borders::ALL)),
            area,
        );
        return;
    };
    if st.mouse.is_none() {
        f.render_widget(
            Paragraph::new(format!("error: {}", st.error.clone().unwrap_or_default()))
                .block(Block::default().borders(Borders::ALL).title(" Mouse ")),
            area,
        );
        return;
    }
    let mut lines: Vec<Line> = st.lines.iter().map(|s| Line::from(s.as_str())).collect();
    if let Some(e) = &st.error {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            format!("note: {e}"),
            Style::default().fg(Color::Yellow),
        )));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "read-only summary — r refresh",
        Style::default().fg(Color::DarkGray),
    )));
    f.render_widget(
        Paragraph::new(lines).block(
            Block::default()
                .borders(Borders::ALL)
                .title(format!(" Mouse — {} ", st.device_label)),
        ),
        area,
    );
}

// ── sparkplayjoy screen ────────────────────────────────────────────────

fn heat_color(milli: u16) -> Color {
    // 0 → near-black, 1000 → hot red; blue→cyan→yellow→red ramp.
    if milli == 0 {
        return Color::Rgb(18, 18, 24);
    }
    let t = milli as f32 / 1000.0;
    let (r, g, b) = if t < 0.33 {
        (0.0, t * 3.0 * 220.0, 80.0 + t * 3.0 * 120.0)
    } else if t < 0.66 {
        let u = (t - 0.33) / 0.33;
        (u * 255.0, 220.0 + u * 35.0, (1.0 - u) * 200.0)
    } else {
        let u = (t - 0.66) / 0.34;
        (255.0, (1.0 - u) * 255.0, 0.0)
    };
    Color::Rgb(r.min(255.0) as u8, g.min(255.0) as u8, b.min(255.0) as u8)
}

struct HeatMap<'a> {
    travel: &'a spj::TravelMatrix,
    max_um: u16,
    map: Option<&'a spj::KeyMap>,
}

impl Widget for HeatMap<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        if area.width < spj::COLS as u16 || area.height < spj::ROWS as u16 {
            return;
        }
        // Two terminal cells per matrix cell keeps the aspect roughly square.
        for r in 0..spj::ROWS {
            for c in 0..spj::COLS {
                let um = self.travel.samples_um[r][c];
                let milli = spj::normalize_travel_to_milli(um, self.max_um);
                let color = heat_color(milli);
                let x = area.x + (c * 2) as u16;
                let y = area.y + r as u16;
                // Legend char: first char of the key label when a map is known.
                let ch = self
                    .map
                    .and_then(|m| {
                        let code = m[r][c];
                        (code != 0).then(|| omg_model::key_label(code as u16, false))
                    })
                    .and_then(|l| l.chars().next())
                    .unwrap_or('█');
                let style = Style::default().fg(color).bg(Color::Black);
                buf.set_stringn(x, y, ch.to_string(), 1, style);
                buf.set_stringn(x + 1, y, "█", 1, style);
            }
        }
    }
}

fn draw_spark(f: &mut Frame, area: Rect, app: &mut App) {
    let Some(st) = app.spark.as_mut() else {
        f.render_widget(
            Paragraph::new("spark screen not initialised")
                .block(Block::default().borders(Borders::ALL)),
            area,
        );
        return;
    };
    if st.sp.is_none() || (st.travel.is_none() && st.error.is_some()) {
        let msg = st
            .error
            .clone()
            .unwrap_or_else(|| "no SparkPlayJoy device detected".into());
        f.render_widget(
            Paragraph::new(format!("{msg}\n\nsee Devices screen for detected hardware")).block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(" SparkPlayJoy "),
            ),
            area,
        );
        return;
    }
    let cols = Layout::horizontal([Constraint::Min(30), Constraint::Length(46)]).split(area);
    // Left: info + heatmap.
    let mut lines = Vec::new();
    if let Some(b) = st.board_id {
        lines.push(Line::from(format!("board id:   0x{b:08X}")));
    }
    if let Some(v) = &st.app_version {
        lines.push(Line::from(format!("app:        {v}")));
    }
    if let Some(s) = &st.scale {
        lines.push(Line::from(format!(
            "travel:     {}..{} µm (precision {} µm)",
            s.minimum_travel_um, s.maximum_travel_um, s.precision_um
        )));
    }
    if let Some(t) = &st.travel {
        let nonzero = t.samples_um.iter().flatten().filter(|&&v| v != 0).count();
        let max = t.samples_um.iter().flatten().copied().max().unwrap_or(0);
        lines.push(Line::from(format!(
            "samples:    {nonzero} nonzero · max {max} µm"
        )));
    }
    if let Some(e) = &st.error {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            format!("note: {e}"),
            Style::default().fg(Color::Yellow),
        )));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "6x21 live travel (µm → colour) · r refresh · serial never shown",
        Style::default().fg(Color::DarkGray),
    )));
    f.render_widget(
        Paragraph::new(lines).block(Block::default().borders(Borders::TOP)),
        Rect {
            x: cols[0].x,
            y: cols[0].y,
            width: cols[0].width,
            height: 8.min(cols[0].height),
        },
    );
    if let (Some(t), Some(s)) = (&st.travel, &st.scale) {
        let map_area = Rect {
            x: cols[0].x,
            y: cols[0].y + 8,
            width: cols[0].width,
            height: cols[0].height.saturating_sub(8),
        };
        f.render_widget(
            HeatMap {
                travel: t,
                max_um: s.maximum_travel_um,
                map: st.map.as_ref(),
            },
            map_area,
        );
    }
    // Right: legend.
    let legend = vec![
        Line::from("travel colour scale:"),
        Line::from(""),
        Line::from(Span::styled("░░░", Style::default().fg(heat_color(0)))),
        Line::from(Span::styled("░░░", Style::default().fg(heat_color(250)))),
        Line::from(Span::styled("░░░", Style::default().fg(heat_color(500)))),
        Line::from(Span::styled("░░░", Style::default().fg(heat_color(750)))),
        Line::from(Span::styled("░░░", Style::default().fg(heat_color(1000)))),
        Line::from(""),
        Line::from("0 µm ──────────── max µm"),
        Line::from(""),
        Line::from(Span::styled(
            "cell char = key label (default map)",
            Style::default().fg(Color::DarkGray),
        )),
        Line::from(Span::styled(
            "block char = unmapped position",
            Style::default().fg(Color::DarkGray),
        )),
    ];
    f.render_widget(
        Paragraph::new(legend).block(Block::default().borders(Borders::ALL).title(" Legend ")),
        cols[1],
    );
}

// ── khub916 (K1/K98) screen ─────────────────────────────────────────────

fn draw_khub916(f: &mut Frame, area: Rect, app: &mut App) {
    let Some(st) = app.kh916.as_mut() else {
        f.render_widget(
            Paragraph::new("khub916 screen not initialised")
                .block(Block::default().borders(Borders::ALL)),
            area,
        );
        return;
    };
    if st.info.is_none() && st.keymap.is_none() && st.power.is_none() {
        let msg = st
            .error
            .clone()
            .or_else(|| st.info_err.clone())
            .unwrap_or_else(|| "no khub916 wired keyboard detected".into());
        f.render_widget(
            Paragraph::new(format!("{msg}\n\nsee Devices screen for detected hardware")).block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(" K1/K98 "),
            ),
            area,
        );
        return;
    }
    let cols = Layout::horizontal([Constraint::Length(46), Constraint::Min(34)]).split(area);

    // Left: device info, power, profile/lighting, macros.
    let mut lines: Vec<Line> = Vec::new();
    if let Some(info) = &st.info {
        lines.push(Line::from(format!(
            "model:      {}",
            info.catalog_name
                .clone()
                .unwrap_or_else(|| "unknown (UUID not in catalog)".into())
        )));
        if let Some(m) = &info.catalog_model {
            lines.push(Line::from(format!("catalog:    {m}")));
        }
        lines.push(Line::from(format!("firmware:   0x{:04X}", info.version)));
        // The 6-byte UUID is the vendor license/password — never shown
        // (privacy rule, AGENTS.md §5); the catalog name identifies it.
        lines.push(Line::from("uuid:       [redacted]"));
        match info.screen {
            Some((w, h)) => lines.push(Line::from(format!("screen:     {w}x{h} (code {})", info.screen_size))),
            None => lines.push(Line::from("screen:     none on this interface")),
        }
    } else if let Some(e) = &st.info_err {
        lines.push(Line::from(Span::styled(
            format!("device info: {e}"),
            Style::default().fg(Color::Yellow),
        )));
    }
    lines.push(Line::from(""));
    if let Some(p) = &st.power {
        lines.push(Line::from(format!(
            "battery:    {}% · flags 0x{:02X}",
            p.percent, p.flags
        )));
    }
    if let Some(p) = &st.profile {
        if let Some(mode) = p.light_mode() {
            lines.push(Line::from(format!("light mode: raw {mode}")));
        }
        if let Some(s) = p.sleep_seconds() {
            lines.push(Line::from(format!("sleep:      {s} s")));
        }
    }
    if let Some(ls) = &st.light_state {
        lines.push(Line::from(""));
        let name = khub::light::light_mode_info(ls.mode)
            .map(|m| m.name)
            .unwrap_or("(unknown effect)");
        lines.push(Line::from(format!(
            "effect:     {} (mode {})",
            name, ls.mode
        )));
        lines.push(Line::from(format!(
            "speed {} · brightness {} · {}",
            ls.speed,
            ls.brightness,
            if ls.color_model == khub::light::color_model::MIXING {
                "colour mixing"
            } else {
                "monochrome"
            }
        )));
        if let (Some(data), Some(mode)) = (&st.light_data, st.profile.as_ref().and_then(|p| p.light_mode()))
        {
            if let Some(c) = khub::light::group_color(data, mode) {
                lines.push(Line::from(format!(
                    "colour:     #{:02X}{:02X}{:02X}",
                    c.r, c.g, c.b
                )));
            }
        }
    }
    lines.push(Line::from(""));
    match &st.macros {
        Some(ms) => {
            lines.push(Line::from(format!(
                "macros:     {}",
                if ms.len() == 1 {
                    "1 entry".to_string()
                } else {
                    format!("{} entries", ms.len())
                }
            )));
            for m in ms.iter().take(8) {
                let total_ms: u32 = m.steps.iter().map(|s| s.delay_ms).sum();
                lines.push(Line::from(format!(
                    "  {} — {} steps (~{} ms)",
                    m.name,
                    m.steps.len(),
                    total_ms
                )));
            }
            if ms.len() > 8 {
                lines.push(Line::from(format!("  … {} more", ms.len() - 8)));
            }
        }
        None => {
            if let Some(e) = &st.macros_err {
                lines.push(Line::from(Span::styled(
                    format!("macros:     {e}"),
                    Style::default().fg(Color::Yellow),
                )));
            }
        }
    }
    if let Some(e) = &st.error {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            format!("note: {e}"),
            Style::default().fg(Color::Yellow),
        )));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "read-only — [ ] keymap layer · j/k scroll · r refresh",
        Style::default().fg(Color::DarkGray),
    )));
    f.render_widget(
        Paragraph::new(lines).block(Block::default().borders(Borders::ALL).title(" Device ")),
        cols[0],
    );

    // Right: keymap slots decoded via omg-model labels.
    let mut klines: Vec<Line> = Vec::new();
    klines.push(Line::from(Span::styled(
        format!(
            "keymap arg {} — layer {} · system {}",
            st.keymap_arg,
            st.keymap_arg & 3,
            (st.keymap_arg >> 2) & 1
        ),
        Style::default().add_modifier(Modifier::BOLD),
    )));
    klines.push(Line::from(Span::styled(
        "slot: label (NN = keymap index)",
        Style::default().fg(Color::DarkGray),
    )));
    klines.push(Line::from(""));
    match &st.keymap {
        Some(km) => {
            let assigned = km.iter().filter(|kv| !matches!(kv, khub::KeyValue::Empty)).count();
            klines.push(Line::from(format!(
                "{} slots · {} assigned",
                km.len(),
                assigned
            )));
            klines.push(Line::from(""));
            // Grid rows: each cell "NNN label" (~15 cols); columns adapt to
            // panel width. j/k scrolls by row.
            let inner_w = cols[1].width.saturating_sub(4) as usize;
            let ncols = (inner_w / 15).clamp(1, 9);
            let mut rows: Vec<Line> = Vec::new();
            for (r, chunk) in km.chunks(ncols).enumerate() {
                let mut cells = vec![Span::raw("  ")];
                for (c, kv) in chunk.iter().enumerate() {
                    let idx = r * ncols + c;
                    let label = kv.label();
                    let label = if label.is_empty() {
                        "·".to_string()
                    } else {
                        truncate(&label, 10)
                    };
                    let cell = format!("{idx:>3} {label}");
                    let style = if label == "·" {
                        Style::default().fg(Color::DarkGray)
                    } else {
                        Style::default()
                    };
                    cells.push(Span::styled(format!("{cell:<15}"), style));
                }
                rows.push(Line::from(cells));
            }
            let visible = cols[1].height.saturating_sub(5) as usize;
            let max_scroll = rows.len().saturating_sub(visible.max(1));
            let scroll = st.keymap_scroll.min(max_scroll) as u16;
            klines.extend(rows);
            f.render_widget(
                Paragraph::new(klines)
                    .scroll((scroll, 0))
                    .block(
                        Block::default()
                            .borders(Borders::ALL)
                            .title(" Keymap "),
                    ),
                cols[1],
            );
        }
        None => {
            let msg = st
                .keymap_err
                .clone()
                .unwrap_or_else(|| "keymap unavailable".into());
            klines.push(Line::from(Span::styled(
                msg,
                Style::default().fg(Color::Yellow),
            )));
            f.render_widget(
                Paragraph::new(klines).block(
                    Block::default()
                        .borders(Borders::ALL)
                        .title(" Keymap "),
                ),
                cols[1],
            );
        }
    }
}

// ── overlays ───────────────────────────────────────────────────────────

fn draw_help(f: &mut Frame, area: Rect) {
    let w = 64.min(area.width);
    let h = 18.min(area.height);
    let r = Rect {
        x: area.x + (area.width.saturating_sub(w)) / 2,
        y: area.y + (area.height.saturating_sub(h)) / 2,
        width: w,
        height: h,
    };
    f.render_widget(Clear, r);
    let text = vec![
        Line::from(Span::styled(
            " keys ",
            Style::default().add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        Line::from(" Tab / 1-5   switch screen"),
        Line::from(" hjkl/arrows navigate keyboard layout / scroll keymap"),
        Line::from(" [ / ]       cycle khub916 keymap layer (read-only)"),
        Line::from(" + / -       adjust HE actuation ±step (y/n confirm)"),
        Line::from(" r           reload device data on this screen"),
        Line::from(" ?           this help            Esc close"),
        Line::from(" q / Ctrl-C  quit"),
        Line::from(""),
        Line::from(Span::styled(
            "writes are opt-in: every change asks y/n, is range-checked",
            Style::default().fg(Color::DarkGray),
        )),
        Line::from(Span::styled(
            "and read back for verification (same contract as `omg --yes`).",
            Style::default().fg(Color::DarkGray),
        )),
    ];
    f.render_widget(
        Paragraph::new(text).block(Block::default().borders(Borders::ALL).title(" Help ")),
        r,
    );
}

fn draw_confirm(f: &mut Frame, area: Rect, c: &Confirm) {
    let w = (c.summary.len() as u16 + 8).clamp(40, area.width.saturating_sub(4));
    let h = 5.min(area.height);
    let r = Rect {
        x: area.x + (area.width.saturating_sub(w)) / 2,
        y: area.y + (area.height.saturating_sub(h)) / 2,
        width: w,
        height: h,
    };
    f.render_widget(Clear, r);
    f.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(
                " confirm write ",
                Style::default()
                    .add_modifier(Modifier::BOLD)
                    .fg(Color::Yellow),
            )),
            Line::from(""),
            Line::from(c.summary.clone()),
            Line::from(""),
            Line::from(Span::styled(
                "[y] write & verify    [n] cancel",
                Style::default().fg(Color::Cyan),
            )),
        ])
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Yellow)),
        ),
        r,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every screen must render without panic on synthetic demo data —
    /// this is what `omg-tui --demo` smoke-tests for the Devices frame.
    #[test]
    fn demo_draws_all_screens() {
        for screen in Screen::ALL {
            let mut app = App::new(demo_devices(), true);
            app.enter(screen);
            if screen == Screen::Kh916 {
                app.kh916_keymap(3); // exercise the arg-cycle path too
            }
            let backend = ratatui::backend::TestBackend::new(110, 36);
            let mut terminal = Terminal::new(backend).expect("test backend");
            terminal.draw(|f| draw(f, &mut app)).expect("draw");
        }
    }
}
