use std::path::Path;
use std::process::{Command, Output};

fn check_installation(temp_directory: &Path, salon_data: &Path) -> std::io::Result<Output> {
    Command::new(env!("CARGO_BIN_EXE_sob-desktop"))
        .arg("--check-installation")
        .env("TMPDIR", temp_directory)
        .env("SOB_DATA_DIR", salon_data)
        .output()
}

#[test]
fn the_packaged_entry_point_requires_writable_storage_and_leaves_no_replica() {
    let temp = tempfile::tempdir().unwrap();
    let salon_data = temp.path().join("salon");
    let unavailable = check_installation(&temp.path().join("missing"), &salon_data).unwrap();
    assert!(!unavailable.status.success());
    assert!(
        String::from_utf8_lossy(&unavailable.stderr)
            .contains("could not verify its local SQLite replica")
    );

    let available = check_installation(temp.path(), &salon_data).unwrap();
    assert!(
        available.status.success(),
        "{}",
        String::from_utf8_lossy(&available.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&available.stdout).trim_end(),
        concat!("Citame ", env!("CARGO_PKG_VERSION"), " SQLite ready")
    );
    assert!(temp.path().read_dir().unwrap().next().is_none());
}
