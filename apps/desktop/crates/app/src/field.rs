//! A deliberately small single-line text field: typing, backspace, paste, tab, enter. No
//! selection or IME (v1 forms are short); the real input lives in the OS once we need it.

use gpui::prelude::*;
use gpui::{
    ClipboardItem, Context, EventEmitter, FocusHandle, Focusable, IntoElement, KeyDownEvent,
    Render, SharedString, Window, div, px,
};

use crate::theme;

pub enum FieldEvent {
    Submit,
    Changed,
}

pub struct TextField {
    text: String,
    placeholder: SharedString,
    masked: bool,
    focus: FocusHandle,
}

impl EventEmitter<FieldEvent> for TextField {}

impl Focusable for TextField {
    fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
        self.focus.clone()
    }
}

impl TextField {
    pub fn new(placeholder: impl Into<SharedString>, masked: bool, cx: &mut Context<Self>) -> Self {
        Self {
            text: String::new(),
            placeholder: placeholder.into(),
            masked,
            focus: cx.focus_handle().tab_stop(true),
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    #[cfg(test)]
    pub fn set_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.text = text.to_owned();
        cx.notify();
    }

    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.text.clear();
        cx.notify();
    }

    pub fn focus(&self, window: &mut Window) {
        window.focus(&self.focus);
    }

    fn key_down(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let k = &ev.keystroke;
        let m = &k.modifiers;
        match k.key.as_str() {
            "backspace" => {
                self.text.pop();
            }
            "enter" => {
                cx.emit(FieldEvent::Submit);
                return;
            }
            "tab" => {
                if m.shift {
                    window.focus_prev()
                } else {
                    window.focus_next()
                }
                return;
            }
            "v" if m.control || m.platform => {
                if let Some(t) = cx.read_from_clipboard().and_then(|c| c.text()) {
                    self.text.push_str(t.lines().next().unwrap_or(""));
                }
            }
            "c" if m.control || m.platform => {
                cx.write_to_clipboard(ClipboardItem::new_string(self.text.clone()));
                return;
            }
            _ => match &k.key_char {
                Some(ch) if !m.control && !m.platform && !ch.chars().any(char::is_control) => {
                    self.text.push_str(ch)
                }
                _ => return,
            },
        }
        cx.emit(FieldEvent::Changed);
        cx.notify();
    }
}

impl Render for TextField {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let focused = self.focus.is_focused(window);
        let shown: SharedString = if self.masked {
            "\u{2022}".repeat(self.text.chars().count()).into()
        } else {
            self.text.clone().into()
        };
        let empty = self.text.is_empty();
        div()
            .id(("field", cx.entity_id()))
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::key_down))
            .on_click(cx.listener(|this, _, window, _| window.focus(&this.focus)))
            .flex()
            .flex_row()
            .items_center()
            .h(px(36.))
            .w_full()
            .px_3()
            .rounded_md()
            .border_1()
            .border_color(if focused {
                theme::accent()
            } else {
                theme::line()
            })
            .bg(theme::panel())
            .text_color(theme::text())
            .text_sm()
            .cursor_text()
            .child(if empty && !focused {
                div()
                    .text_color(theme::muted())
                    .child(self.placeholder.clone())
            } else {
                div().child(shown)
            })
            .when(focused, |d| {
                d.child(div().w(px(1.)).h(px(16.)).ml(px(1.)).bg(theme::accent()))
            })
    }
}
