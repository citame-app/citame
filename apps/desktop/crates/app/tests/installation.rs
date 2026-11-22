use std::fs::File;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

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

#[test]
fn a_second_process_exits_before_opening_an_occupied_profile() {
    let profile = tempfile::tempdir().unwrap();
    let owner = File::create(profile.path().join(".profile.lock")).unwrap();
    owner.lock().unwrap();

    let mut duplicate = Command::new(env!("CARGO_BIN_EXE_sob-desktop"))
        .env("SOB_DATA_DIR", profile.path())
        .env("SOB_API_URL", "http://127.0.0.1:1")
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_DISPLAY")
        .env_remove("WAYLAND_SOCKET")
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    while duplicate.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            let _ = duplicate.kill();
            let _ = duplicate.wait();
            panic!("a duplicate launch did not exit");
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    let result = duplicate.wait_with_output().unwrap();
    let error = String::from_utf8_lossy(&result.stderr);
    assert!(result.status.success(), "{error}");
    assert!(error.contains("Citame is already open with this local profile."));
    assert_eq!(profile.path().read_dir().unwrap().count(), 1);
}
