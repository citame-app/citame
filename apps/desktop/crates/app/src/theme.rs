//! Colour tokens (light theme only in v1).

use gpui::{Rgba, rgb};

pub fn bg() -> Rgba {
    rgb(0xfaf6f3)
}
pub fn panel() -> Rgba {
    rgb(0xffffff)
}
pub fn line() -> Rgba {
    rgb(0xe6dde0)
}
pub fn line_soft() -> Rgba {
    rgb(0xf0e9eb)
}
pub fn text() -> Rgba {
    rgb(0x2b2228)
}
pub fn muted() -> Rgba {
    rgb(0x7b6f76)
}
pub fn accent() -> Rgba {
    rgb(0xb4457a)
}
pub fn accent_hover() -> Rgba {
    rgb(0x9c3868)
}
pub fn accent_soft() -> Rgba {
    rgb(0xf7e4ee)
}
pub fn on_accent() -> Rgba {
    rgb(0xffffff)
}
pub fn pending_bg() -> Rgba {
    rgb(0xfff3d6)
}
pub fn pending_fg() -> Rgba {
    rgb(0x8a5a00)
}
pub fn conflict_bg() -> Rgba {
    rgb(0xfde7e7)
}
pub fn conflict_fg() -> Rgba {
    rgb(0xb42323)
}
pub fn online() -> Rgba {
    rgb(0x2e9e6b)
}
pub fn offline() -> Rgba {
    rgb(0x8f858b)
}
pub fn warn() -> Rgba {
    rgb(0xd98a00)
}
pub fn backdrop() -> Rgba {
    gpui::rgba(0x2b222866)
}
