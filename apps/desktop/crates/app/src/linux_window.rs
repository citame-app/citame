use std::os::unix::process::CommandExt;
use std::process::Command;

use gpui::{
    Decorations, FontWeight, MouseButton, Pixels, SharedString, Stateful, Window, div, prelude::*,
    px,
};
use sob_core::i18n::{Key, Locale, t};
use x11rb::protocol::xproto::ConnectionExt as _;

use crate::theme;

pub(crate) const CLIENT_TITLE_HEIGHT: Pixels = px(36.);

fn uses_gnome_wayland() -> bool {
    gpui::guess_compositor() == "Wayland"
        && std::env::var("XDG_CURRENT_DESKTOP")
            .unwrap_or_default()
            .split(':')
            .any(|name| name.eq_ignore_ascii_case("GNOME"))
}

pub(crate) fn requested_decorations() -> gpui::WindowDecorations {
    if uses_gnome_wayland() {
        // Without the decoration protocol, GPUI 0.2.2 keeps the requested mode.
        gpui::WindowDecorations::Client
    } else {
        gpui::WindowDecorations::Server
    }
}

fn local_xwayland_display(display: &str) -> bool {
    let Some(local) = display.strip_prefix(':') else {
        return false;
    };
    let (number, screen) = local.split_once('.').unwrap_or((local, "0"));
    !number.is_empty()
        && !screen.is_empty()
        && number.bytes().all(|byte| byte.is_ascii_digit())
        && screen.bytes().all(|byte| byte.is_ascii_digit())
}

fn has_dri3(display: &str) -> bool {
    let Ok((connection, _)) = x11rb::connect(Some(display)) else {
        return false;
    };
    connection
        .query_extension(b"DRI3")
        .ok()
        .and_then(|request| request.reply().ok())
        .is_some_and(|reply| reply.present)
}

pub(crate) fn prefer_native_gnome_decorations() {
    if !uses_gnome_wayland() {
        return;
    }
    let Ok(display) = std::env::var("DISPLAY") else {
        return;
    };
    // Only try the local XWayland server. Mesa's X11 presentation requires DRI3.
    if !local_xwayland_display(&display) || !has_dri3(&display) {
        return;
    }
    if let Ok(executable) = std::env::current_exe() {
        let error = Command::new(executable)
            .args(std::env::args_os().skip(1))
            .env_remove("WAYLAND_DISPLAY")
            .env_remove("WAYLAND_SOCKET")
            .exec();
        eprintln!("Citame could not start through XWayland: {error}");
    }
}

pub(crate) fn client_title_bar(window: &Window, locale: Locale) -> Option<gpui::Div> {
    if window.is_fullscreen() || !matches!(window.window_decorations(), Decorations::Client { .. })
    {
        return None;
    }
    let controls = window.window_controls();
    let maximize_label = if window.is_maximized() {
        Key::RestoreWindow
    } else {
        Key::MaximizeWindow
    };
    Some(
        div()
            .h(CLIENT_TITLE_HEIGHT)
            .flex_shrink_0()
            .flex()
            .items_center()
            .bg(theme::panel())
            .border_b_1()
            .border_color(theme::line())
            .child(
                div()
                    .flex_1()
                    .h_full()
                    .flex()
                    .items_center()
                    .px_3()
                    .text_sm()
                    .font_weight(FontWeight::MEDIUM)
                    .on_mouse_down(MouseButton::Left, move |event, window, _| {
                        if event.click_count == 2 && controls.maximize {
                            window.zoom_window();
                        } else {
                            window.start_window_move();
                        }
                    })
                    .child(t(locale, Key::AppTitle)),
            )
            .when(controls.minimize, |bar| {
                bar.child(control(
                    "window-minimize",
                    "−",
                    t(locale, Key::MinimizeWindow),
                    |window| window.minimize_window(),
                ))
            })
            .when(controls.maximize, |bar| {
                bar.child(control(
                    "window-maximize",
                    "□",
                    t(locale, maximize_label),
                    |window| window.zoom_window(),
                ))
            })
            .child(control(
                "window-close",
                "×",
                t(locale, Key::Close),
                Window::remove_window,
            )),
    )
}

fn control(
    id: &'static str,
    glyph: &'static str,
    label: &'static str,
    action: impl Fn(&mut Window) + 'static,
) -> Stateful<gpui::Div> {
    div()
        .id(id)
        .h_full()
        .w(px(40.))
        .flex()
        .items_center()
        .justify_center()
        .text_base()
        .cursor_pointer()
        .hover(|style| style.bg(theme::accent_soft()))
        .on_click(move |_, window, _| action(window))
        .tooltip(move |_, cx| cx.new(|_| WindowControlTooltip(label.into())).into())
        .child(glyph)
}

struct WindowControlTooltip(SharedString);

impl gpui::Render for WindowControlTooltip {
    fn render(&mut self, _window: &mut Window, _cx: &mut gpui::Context<Self>) -> impl IntoElement {
        div()
            .px_2()
            .py_1()
            .rounded_md()
            .bg(theme::panel())
            .text_color(theme::text())
            .text_sm()
            .shadow_md()
            .child(self.0.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_local_xwayland_displays_and_rejects_forwarded_ones() {
        for display in [":0", ":123", ":42.0"] {
            assert!(local_xwayland_display(display));
        }
        for display in [
            "",
            ":x",
            ":.0",
            ":2.",
            "localhost:10.0",
            "unix/:42",
            "machine:0",
        ] {
            assert!(!local_xwayland_display(display));
        }
    }
}
