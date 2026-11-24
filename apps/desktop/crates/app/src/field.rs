//! Single-line native text input with Unicode selection, clipboard editing and IME composition.
use crate::theme;
use gpui::prelude::*;
use gpui::{
    Bounds, ClipboardItem, Context, ElementInputHandler, EntityInputHandler, EventEmitter,
    FocusHandle, Focusable, IntoElement, KeyDownEvent, MouseButton, Pixels, Point, Render,
    ShapedLine, SharedString, TextRun, UTF16Selection, Window, canvas, div, fill, point, px, size,
};
use std::cell::Cell;
use std::ops::Range;
use std::rc::Rc;
use unicode_segmentation::UnicodeSegmentation;

pub enum FieldEvent {
    Submit,
    Changed,
    PasteLines(Vec<String>),
    PasteTooLong,
    InvalidPaste,
}
pub struct TextField {
    text: String,
    placeholder: SharedString,
    masked: bool,
    focus: FocusHandle,
    anchor: usize,
    cursor: usize,
    marked: Option<Range<usize>>,
    layout: Option<ShapedLine>,
    bounds: Option<Bounds<Pixels>>,
    scroll: Pixels,
    selecting: bool,
    line_paste_limit: Option<usize>,
    paste_newlines_remaining: Option<Rc<Cell<usize>>>,
    paste_validation: Option<fn(&str) -> bool>,
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
            anchor: 0,
            cursor: 0,
            marked: None,
            layout: None,
            bounds: None,
            scroll: px(0.),
            selecting: false,
            line_paste_limit: None,
            paste_newlines_remaining: None,
            paste_validation: None,
        }
    }
    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn with_line_paste(mut self, limit: usize) -> Self {
        self.line_paste_limit = Some(limit);
        self
    }
    pub fn with_bounded_line_paste(mut self, limit: usize, remaining: Rc<Cell<usize>>) -> Self {
        self.line_paste_limit = Some(limit);
        self.paste_newlines_remaining = Some(remaining);
        self
    }
    pub fn with_paste_validation(mut self, validate: fn(&str) -> bool) -> Self {
        self.paste_validation = Some(validate);
        self
    }
    pub fn set_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.text = text.to_owned();
        self.cursor = self.text.len();
        self.anchor = self.cursor;
        self.marked = None;
        self.scroll = px(0.);
        cx.notify();
    }
    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.text.clear();
        self.anchor = 0;
        self.cursor = 0;
        self.marked = None;
        self.layout = None;
        self.bounds = None;
        self.scroll = px(0.);
        cx.notify();
    }
    pub fn focus(&self, window: &mut Window) {
        window.focus(&self.focus);
    }
    fn selection(&self) -> Range<usize> {
        self.anchor.min(self.cursor)..self.anchor.max(self.cursor)
    }
    fn utf16_offset(&self, byte: usize) -> usize {
        self.text[..byte].encode_utf16().count()
    }
    fn byte_offset(text: &str, offset: usize, round_up: bool) -> usize {
        let mut units = 0;
        for (byte, ch) in text.char_indices() {
            if units >= offset {
                return byte;
            }
            units += ch.len_utf16();
            if units > offset {
                return if round_up { byte + ch.len_utf8() } else { byte };
            }
        }
        text.len()
    }
    fn byte_range(&self, range: Range<usize>) -> Range<usize> {
        let start = Self::byte_offset(&self.text, range.start, false);
        start..Self::byte_offset(&self.text, range.end, true).max(start)
    }
    fn utf16_range(&self, range: Range<usize>) -> Range<usize> {
        self.utf16_offset(range.start)..self.utf16_offset(range.end)
    }
    fn move_cursor(&mut self, offset: usize, extend: bool, cx: &mut Context<Self>) {
        self.cursor = offset;
        if !extend {
            self.anchor = offset;
        }
        self.marked = None;
        cx.notify();
    }
    fn previous(&self) -> usize {
        self.text
            .grapheme_indices(true)
            .rev()
            .find_map(|(i, _)| (i < self.cursor).then_some(i))
            .unwrap_or(0)
    }
    fn next(&self) -> usize {
        self.text
            .grapheme_indices(true)
            .find_map(|(i, _)| (i > self.cursor).then_some(i))
            .unwrap_or(self.text.len())
    }
    fn replace(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        mark: bool,
        selected: Option<Range<usize>>,
        cx: &mut Context<Self>,
    ) {
        let range = range
            .map(|r| self.byte_range(r))
            .or_else(|| self.marked.clone())
            .unwrap_or_else(|| self.selection());
        let text: String = text
            .lines()
            .next()
            .unwrap_or("")
            .chars()
            .filter(|c| !c.is_control() || (*c == '\t' && self.line_paste_limit.is_some()))
            .collect();
        self.text.replace_range(range.clone(), &text);
        self.marked = (mark && !text.is_empty()).then_some(range.start..range.start + text.len());
        let selected = selected
            .map(|r| {
                let from = Self::byte_offset(&text, r.start, false);
                from..Self::byte_offset(&text, r.end, true).max(from)
            })
            .unwrap_or(text.len()..text.len());
        self.anchor = range.start + selected.start;
        self.cursor = range.start + selected.end;
        cx.emit(FieldEvent::Changed);
        cx.notify();
    }

    fn paste(&mut self, text: &str, cx: &mut Context<Self>) {
        let Some(limit) = self.line_paste_limit else {
            self.replace(None, text, false, None, cx);
            return;
        };
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        if self
            .paste_validation
            .is_some_and(|validate| !validate(&text))
        {
            cx.emit(FieldEvent::InvalidPaste);
            return;
        }
        if text.encode_utf16().count() > limit {
            cx.emit(FieldEvent::PasteTooLong);
            return;
        }
        let Some((first, rest)) = text.split_once('\n') else {
            self.replace(None, &text, false, None, cx);
            return;
        };
        if let Some(remaining) = &self.paste_newlines_remaining {
            let newlines = 1 + rest.bytes().filter(|byte| *byte == b'\n').count();
            let Some(next) = remaining.get().checked_sub(newlines) else {
                cx.emit(FieldEvent::PasteTooLong);
                return;
            };
            remaining.set(next);
        }
        let selection = self.selection();
        let suffix = &self.text[selection.end..];
        let tail = format!("{rest}{suffix}")
            .split('\n')
            .map(str::to_owned)
            .collect();
        let range = self.utf16_range(selection.start..self.text.len());
        self.replace(Some(range), first, false, None, cx);
        cx.emit(FieldEvent::PasteLines(tail));
    }

    fn key_down(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let k = &ev.keystroke;
        let shortcut = k.modifiers.control || k.modifiers.platform;
        let extend = k.modifiers.shift;
        match k.key.as_str() {
            "a" if shortcut => {
                self.anchor = 0;
                self.cursor = self.text.len();
                cx.notify();
            }
            "c" | "x" if shortcut => {
                if !self.masked && !self.selection().is_empty() {
                    cx.write_to_clipboard(ClipboardItem::new_string(
                        self.text[self.selection()].to_owned(),
                    ));
                    if k.key == "x" {
                        self.replace(None, "", false, None, cx);
                    }
                }
            }
            "v" if shortcut => {
                if let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) {
                    self.paste(&text, cx);
                }
            }
            "left" => {
                let pos = if !extend && !self.selection().is_empty() {
                    self.selection().start
                } else {
                    self.previous()
                };
                self.move_cursor(pos, extend, cx);
            }
            "right" => {
                let pos = if !extend && !self.selection().is_empty() {
                    self.selection().end
                } else {
                    self.next()
                };
                self.move_cursor(pos, extend, cx);
            }
            "home" => self.move_cursor(0, extend, cx),
            "end" => self.move_cursor(self.text.len(), extend, cx),
            "backspace" => {
                if self.selection().is_empty() {
                    self.anchor = self.previous();
                }
                self.replace(None, "", false, None, cx);
            }
            "delete" => {
                if self.selection().is_empty() {
                    self.anchor = self.next();
                }
                self.replace(None, "", false, None, cx);
            }
            "enter" if self.marked.is_none() => cx.emit(FieldEvent::Submit),
            "tab" => {
                if extend {
                    window.focus_prev();
                } else {
                    window.focus_next();
                }
            }
            _ => return, // Printable input is delivered exactly once by the platform input handler.
        }
        cx.stop_propagation();
    }
    fn display_index(&self, byte: usize) -> usize {
        if self.masked {
            self.text[..byte].graphemes(true).count() * "•".len()
        } else {
            byte
        }
    }
    fn index_at(&self, position: Point<Pixels>) -> usize {
        let (Some(bounds), Some(line)) = (self.bounds, self.layout.as_ref()) else {
            return 0;
        };
        let index = line.closest_index_for_x(position.x - bounds.left() + self.scroll);
        if self.masked {
            self.text
                .grapheme_indices(true)
                .nth(index / "•".len())
                .map(|(byte, _)| byte)
                .unwrap_or(self.text.len())
        } else {
            index.min(self.text.len())
        }
    }
}
impl EntityInputHandler for TextField {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        if self.masked {
            return None;
        }
        let range = self.byte_range(range);
        *actual = Some(self.utf16_range(range.clone()));
        Some(self.text[range].to_owned())
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.utf16_range(self.selection()),
            reversed: self.cursor < self.anchor,
        })
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.clone().map(|r| self.utf16_range(r))
    }
    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        cx.notify();
    }
    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.replace(range, text, false, None, cx);
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.replace(range, text, true, selected, cx);
    }
    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let line = self.layout.as_ref()?;
        let range = self.byte_range(range);
        Some(Bounds::from_corners(
            point(
                bounds.left() - self.scroll + line.x_for_index(self.display_index(range.start)),
                bounds.top(),
            ),
            point(
                bounds.left() - self.scroll + line.x_for_index(self.display_index(range.end)),
                bounds.bottom(),
            ),
        ))
    }
    fn character_index_for_point(
        &mut self,
        position: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        self.bounds?;
        Some(self.utf16_offset(self.index_at(position)))
    }
}
impl Render for TextField {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let focused = self.focus.is_focused(window);
        let prepaint_entity = cx.entity();
        let paint_entity = cx.entity();
        div()
            .id(("field", cx.entity_id()))
            .track_focus(&self.focus)
            .on_key_down(cx.listener(Self::key_down))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &gpui::MouseDownEvent, window, cx| {
                    this.focus(window);
                    this.selecting = true;
                    let index = this.index_at(event.position);
                    this.move_cursor(index, event.modifiers.shift, cx);
                }),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, _| this.selecting = false),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(|this, _, _, _| this.selecting = false),
            )
            .on_mouse_move(cx.listener(|this, event: &gpui::MouseMoveEvent, _, cx| {
                if this.selecting {
                    let index = this.index_at(event.position);
                    this.move_cursor(index, true, cx);
                }
            }))
            .flex()
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
            .overflow_hidden()
            .child(
                canvas(
                    move |bounds, window, cx| {
                        let field = prepaint_entity.read(cx);
                        let style = window.text_style();
                        let text: SharedString = if field.text.is_empty() {
                            field.placeholder.clone()
                        } else if field.masked {
                            "•".repeat(field.text.graphemes(true).count()).into()
                        } else {
                            field.text.clone().into()
                        };
                        let color = if field.text.is_empty() {
                            theme::muted().into()
                        } else {
                            style.color
                        };
                        let run = TextRun {
                            len: text.len(),
                            font: style.font(),
                            color,
                            background_color: None,
                            underline: None,
                            strikethrough: None,
                        };
                        let line = window.text_system().shape_line(
                            text,
                            style.font_size.to_pixels(window.rem_size()),
                            &[run],
                            None,
                        );
                        let cursor = line.x_for_index(field.display_index(field.cursor));
                        let available = bounds.size.width - px(2.);
                        let scroll = if cursor > available {
                            cursor - available
                        } else {
                            px(0.)
                        };
                        (line, scroll)
                    },
                    move |bounds, (line, scroll), window, cx| {
                        let (focus, selection, cursor, marked) = {
                            let field = paint_entity.read(cx);
                            let range = field.selection();
                            (
                                field.focus.clone(),
                                field.display_index(range.start)..field.display_index(range.end),
                                field.display_index(field.cursor),
                                field.marked.as_ref().map(|r| {
                                    field.display_index(r.start)..field.display_index(r.end)
                                }),
                            )
                        };
                        window.handle_input(
                            &focus,
                            ElementInputHandler::new(bounds, paint_entity.clone()),
                            cx,
                        );
                        let x = |index| bounds.left() - scroll + line.x_for_index(index);
                        if focused && !selection.is_empty() {
                            window.paint_quad(fill(
                                Bounds::from_corners(
                                    point(x(selection.start), bounds.top()),
                                    point(x(selection.end), bounds.bottom()),
                                ),
                                theme::accent_soft(),
                            ));
                        }
                        let _ = line.paint(
                            point(bounds.left() - scroll, bounds.top()),
                            window.line_height(),
                            window,
                            cx,
                        );
                        if focused {
                            window.paint_quad(fill(
                                Bounds::new(
                                    point(x(cursor), bounds.top()),
                                    size(px(1.), bounds.size.height),
                                ),
                                theme::accent(),
                            ));
                        }
                        if let Some(marked) = marked {
                            window.paint_quad(fill(
                                Bounds::from_corners(
                                    point(x(marked.start), bounds.bottom() - px(1.)),
                                    point(x(marked.end), bounds.bottom()),
                                ),
                                theme::accent(),
                            ));
                        }
                        paint_entity.update(cx, |field, _| {
                            field.layout = Some(line);
                            field.bounds = Some(bounds);
                            field.scroll = scroll;
                        });
                    },
                )
                .w_full()
                .h(px(22.)),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{EntityInputHandler, Keystroke, TestAppContext};
    #[gpui::test]
    async fn a_multiline_paste_keeps_the_first_line_and_rejects_overlarge_input(
        cx: &mut TestAppContext,
    ) {
        let window = cx.add_window(|_, cx| TextField::new("", false, cx).with_line_paste(20));
        window
            .update(cx, |field, _, cx| {
                field.set_text("Start", cx);
                field.paste("\tFirst\r\nSecond", cx);
                assert_eq!(field.text(), "Start\tFirst");
                field.paste(&"x".repeat(21), cx);
                assert_eq!(field.text(), "Start\tFirst");
            })
            .unwrap();
    }

    #[gpui::test]
    async fn a_paste_over_the_shared_line_limit_preserves_text_and_selection(
        cx: &mut TestAppContext,
    ) {
        let budget = Rc::new(Cell::new(0));
        let window = cx.add_window(|_, cx| {
            TextField::new("", false, cx).with_bounded_line_paste(5, budget.clone())
        });
        window
            .update(cx, |field, _, cx| {
                field.set_text("ab", cx);
                field.move_cursor(0, false, cx);
                field.paste("x\ny", cx);
                assert_eq!(field.text(), "ab");
                assert_eq!(field.selection(), 0..0);
                assert_eq!(budget.get(), 0);
                budget.set(1);
                field.paste("x\ny", cx);
                assert_eq!(field.text(), "x");
                assert_eq!(budget.get(), 0);
            })
            .unwrap();
    }
    fn key(field: &mut TextField, key: &str, window: &mut Window, cx: &mut Context<TextField>) {
        field.key_down(
            &KeyDownEvent {
                keystroke: Keystroke::parse(key).unwrap(),
                is_held: false,
            },
            window,
            cx,
        );
    }
    #[gpui::test]
    async fn selection_replaces_text_and_backspace_removes_whole_graphemes(
        cx: &mut TestAppContext,
    ) {
        let window = cx.add_window(|_, cx| TextField::new("Name", false, cx));
        window
            .update(cx, |field, window, cx| {
                field.set_text("María 👩‍💻", cx);
                key(field, "backspace", window, cx);
                assert_eq!(field.text(), "María ");
                key(field, "ctrl-a", window, cx);
                field.replace_text_in_range(None, "José", window, cx);
                assert_eq!(field.text(), "José");
                key(field, "home", window, cx);
                key(field, "shift-right", window, cx);
                field.replace_text_in_range(None, "R", window, cx);
                assert_eq!(field.text(), "Rosé");
            })
            .unwrap();
    }
    #[gpui::test]
    async fn ime_composition_uses_utf16_ranges_and_commits_without_duplicate_input(
        cx: &mut TestAppContext,
    ) {
        let window = cx.add_window(|_, cx| TextField::new("Name", false, cx));
        window
            .update(cx, |field, window, cx| {
                field.set_text("a😀b", cx);
                field.replace_and_mark_text_in_range(Some(1..3), "に", Some(1..1), window, cx);
                assert_eq!(field.text(), "aにb");
                assert_eq!(field.marked_text_range(window, cx), Some(1..2));
                assert_eq!(
                    field.selected_text_range(false, window, cx).unwrap().range,
                    2..2
                );
                field.replace_text_in_range(None, "日本", window, cx);
                assert_eq!(field.text(), "a日本b");
                assert_eq!(field.marked_text_range(window, cx), None);
                assert_eq!(
                    field.selected_text_range(false, window, cx).unwrap().range,
                    3..3
                );
            })
            .unwrap();
    }
    #[gpui::test]
    async fn password_fields_never_copy_or_expose_surrounding_text(cx: &mut TestAppContext) {
        let window = cx.add_window(|_, cx| TextField::new("Password", true, cx));
        window
            .update(cx, |field, window, cx| {
                field.set_text("secret", cx);
                cx.write_to_clipboard(ClipboardItem::new_string("unchanged".to_owned()));
                key(field, "ctrl-a", window, cx);
                key(field, "ctrl-c", window, cx);
                assert_eq!(
                    cx.read_from_clipboard().unwrap().text().unwrap(),
                    "unchanged"
                );
                assert_eq!(field.text_for_range(0..6, &mut None, window, cx), None);
            })
            .unwrap();
    }
    #[gpui::test]
    async fn platform_input_is_registered_and_real_key_events_edit_the_field(
        cx: &mut TestAppContext,
    ) {
        let window = cx.add_window(|window, cx| {
            let field = TextField::new("Name", false, cx);
            field.focus(window);
            field
        });
        cx.run_until_parked();
        cx.simulate_input(window.into(), "José");
        cx.simulate_keystrokes(window.into(), "ctrl-a");
        cx.simulate_input(window.into(), "Lucía");
        window
            .update(cx, |field, _, _| assert_eq!(field.text(), "Lucía"))
            .unwrap();
    }
}
