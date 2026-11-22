//! Sisters of Beauty front-desk client: GPUI shell over the offline-first `sob-core`.

mod config;
mod field;
#[cfg(target_os = "linux")]
mod linux_window;
mod root;
mod services;
mod theme;

use gpui::{
    App, Application, Bounds, TitlebarOptions, WindowBounds, WindowOptions, prelude::*, px, size,
};
use sob_core::store::Store;

fn check_installation() -> Result<(), Box<dyn std::error::Error>> {
    let directory = tempfile::Builder::new()
        .prefix("citame-installation-")
        .tempdir()?;
    let path = directory.path().join("replica.sqlite3");
    let store = Store::open(&path)?;
    let version = store.schema_version()?;
    if version <= 0 {
        return Err("the replica schema was not initialized".into());
    }
    store.set_meta("installation_probe", "ready")?;
    drop(store);

    let reopened = Store::open(&path)?;
    if reopened.schema_version()? != version
        || reopened.get_meta("installation_probe")?.as_deref() != Some("ready")
    {
        return Err("the replica data did not survive reopening SQLite".into());
    }
    drop(reopened);
    directory.close()?;
    Ok(())
}

fn main() {
    if std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == "--check-installation")
    {
        match check_installation() {
            Ok(()) => {
                println!("Citame {} SQLite ready", env!("CARGO_PKG_VERSION"))
            }
            Err(error) => {
                eprintln!("Citame could not verify its local SQLite replica: {error}");
                std::process::exit(1);
            }
        }
        return;
    }
    #[cfg(target_os = "linux")]
    linux_window::prefer_native_gnome_decorations();

    let startup = std::time::Instant::now();
    let report_startup = std::env::var_os("SOB_STARTUP_TIMINGS").is_some();
    let config = config::Config::from_env();
    Application::new().run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1280.), px(800.)), cx);
        let title = sob_core::i18n::t(config.locale, sob_core::i18n::Key::AppTitle);
        cx.open_window(
            WindowOptions {
                app_id: Some("app.citame.desktop".into()),
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                #[cfg(target_os = "linux")]
                window_decorations: Some(linux_window::requested_decorations()),
                titlebar: Some(TitlebarOptions {
                    title: Some(title.into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            move |window, cx| {
                let root = cx.new(|cx| root::Root::new(config, window, cx));
                if report_startup {
                    window.on_next_frame(move |_, _| {
                        eprintln!(
                            "citame startup first frame callback: {} ms",
                            startup.elapsed().as_millis()
                        );
                    });
                }
                root
            },
        )
        .expect("open the main window");
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        cx.activate(true);
    });
}
