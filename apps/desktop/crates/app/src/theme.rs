//! Palette selected on the UI thread; all views and native input share the same tokens.
use gpui::{Rgba, rgb};
use std::cell::Cell;
thread_local! { static DARK: Cell<bool> = const { Cell::new(false) }; }
pub fn is_dark() -> bool {
    DARK.get()
}
pub fn set_dark(dark: bool) {
    DARK.set(dark);
}
pub fn bg() -> Rgba {
    rgb(if is_dark() { 0x1b161a } else { 0xfaf6f3 })
}
pub fn panel() -> Rgba {
    rgb(if is_dark() { 0x241e22 } else { 0xffffff })
}
pub fn line() -> Rgba {
    rgb(if is_dark() { 0x44373f } else { 0xe6dde0 })
}
pub fn line_soft() -> Rgba {
    rgb(if is_dark() { 0x30262d } else { 0xf0e9eb })
}
pub fn text() -> Rgba {
    rgb(if is_dark() { 0xf8edf2 } else { 0x2b2228 })
}
pub fn muted() -> Rgba {
    rgb(if is_dark() { 0xc1adb7 } else { 0x7b6f76 })
}
pub fn accent() -> Rgba {
    rgb(if is_dark() { 0xd36a9b } else { 0xb4457a })
}
pub fn accent_hover() -> Rgba {
    rgb(if is_dark() { 0xe17faf } else { 0x9c3868 })
}
pub fn accent_soft() -> Rgba {
    rgb(if is_dark() { 0x452b39 } else { 0xf7e4ee })
}
pub fn on_accent() -> Rgba {
    rgb(if is_dark() { 0x25151e } else { 0xffffff })
}
pub fn pending_bg() -> Rgba {
    rgb(if is_dark() { 0x342b1b } else { 0xfff3d6 })
}
pub fn pending_fg() -> Rgba {
    rgb(if is_dark() { 0xf1cd81 } else { 0x8a5a00 })
}
pub fn conflict_bg() -> Rgba {
    rgb(if is_dark() { 0x382020 } else { 0xfde7e7 })
}
pub fn conflict_fg() -> Rgba {
    rgb(if is_dark() { 0xffb3b3 } else { 0xb42323 })
}
pub fn online() -> Rgba {
    rgb(if is_dark() { 0x91e4b3 } else { 0x2e9e6b })
}
pub fn offline() -> Rgba {
    rgb(if is_dark() { 0xc1adb7 } else { 0x8f858b })
}
pub fn warn() -> Rgba {
    rgb(if is_dark() { 0xf1cd81 } else { 0xd98a00 })
}
pub fn backdrop() -> Rgba {
    gpui::rgba(if is_dark() { 0x00000099 } else { 0x2b222866 })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn luminance(c: Rgba) -> f64 {
        let linear = |v: f32| {
            let v = f64::from(v);
            if v <= 0.04045 {
                v / 12.92
            } else {
                ((v + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b)
    }
    #[test]
    fn both_palettes_keep_text_readable_and_dark_surfaces_are_distinct() {
        let original = is_dark();
        set_dark(false);
        let light = luminance(bg());
        for dark in [false, true] {
            set_dark(dark);
            for (fg, bg) in [
                (text(), bg()),
                (muted(), panel()),
                (on_accent(), accent()),
                (pending_fg(), pending_bg()),
                (conflict_fg(), conflict_bg()),
            ] {
                let a = luminance(fg);
                let b = luminance(bg);
                assert!((a.max(b) + 0.05) / (a.min(b) + 0.05) >= 4.5);
            }
        }
        assert!(luminance(bg()) < light);
        set_dark(original);
    }
}
