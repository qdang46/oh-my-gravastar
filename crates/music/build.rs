// Link the Swift runtime for the ScreenCaptureKit bridge on macOS.
// The screencapturekit crate compiles a Swift static library whose
// objects reference swiftCore + the compatibility archives; rustc does
// not auto-link them, so binaries/tests using this crate must.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    // Command Line Tools layout (no full Xcode needed):
    //  - dylib stubs (.tbd) live in the SDK at `usr/lib/swift`
    //    (`xcrun --show-sdk-path`); the real dylibs resolve from
    //    /usr/lib/swift at runtime.
    //  - static compat archives live in `usr/lib/swift/macosx`.
    let dev = std::env::var("DEVELOPER_DIR").unwrap_or_else(|_| {
        std::process::Command::new("xcode-select")
            .arg("-p")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|| "/Library/Developer/CommandLineTools".into())
    });
    let sdk = std::process::Command::new("xcrun")
        .args(["--show-sdk-path"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| format!("{dev}/SDKs/MacOSX.sdk"));
    let swift_libs = format!("{sdk}/usr/lib/swift");
    let compat = format!("{dev}/usr/lib/swift/macosx");
    println!("cargo:rustc-link-search=native={swift_libs}");
    println!("cargo:rustc-link-search=native={compat}");
    println!("cargo:rustc-link-lib=dylib=swiftCore");
    println!("cargo:rustc-link-lib=dylib=swiftObjectiveC");
    for lib in [
        "swiftCompatibility56",
        "swiftCompatibilityConcurrency",
        "swiftCompatibilityDynamicReplacements",
        "swiftCompatibilityPacks",
    ] {
        println!("cargo:rustc-link-lib=static={lib}");
    }
    // @rpath resolution for the Swift runtime dylibs at runtime:
    // /usr/lib/swift covers OS-shipped libs (dyld cache); the toolchain
    // swift-5.5 dir covers libswift_Concurrency and friends.
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    let swift55 = format!("{dev}/usr/lib/swift-5.5/macosx");
    println!("cargo:rustc-link-search=native={swift55}");
    println!("cargo:rustc-link-arg=-Wl,-rpath,{swift55}");
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
}
