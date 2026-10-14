//! Build script: compile the FreeRDP C shim and link FreeRDP/WinPR.
//!
//! The shim (src/rdp/shim.c) is a thin C layer over the FreeRDP 3.x client
//! API: it owns the freerdp event loop and calls back into Rust for paint,
//! pointer, and lifecycle events. Rust only ever sees opaque pointers and
//! plain C types, so we need no bindgen/libclang.

fn main() {
    // The standard tauri build step: validates tauri.conf.json, parses
    // capabilities/*.json into $OUT_DIR/capabilities.json (which
    // generate_context! embeds as the runtime ACL), and emits the right
    // rerun-if-changed lines. Without this call the macro silently embeds
    // whatever stale capabilities snapshot the OUT_DIR happens to hold —
    // capability edits never reach the binary ("not allowed by ACL").
    tauri_build::build();

    let cfg = pkg_config::Config::new();
    let mut includes = Vec::new();
    for lib in ["freerdp3", "winpr3"] {
        match cfg.probe(lib) {
            Ok(lib) => includes.extend(lib.include_paths),
            Err(e) => panic!("pkg-config probe failed for {lib}: {e}"),
        }
    }

    let mut build = cc::Build::new();
    build.file("src/rdp/shim.c").warnings(false);
    for inc in &includes {
        build.include(inc);
    }
    build.compile("trdcfreerdpshim");

    println!("cargo:rerun-if-changed=src/rdp/shim.c");
    println!("cargo:rerun-if-changed=src/rdp/shim.h");
}
