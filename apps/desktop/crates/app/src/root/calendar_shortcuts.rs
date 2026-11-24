use super::*;

#[derive(Clone, Copy)]
enum Action {
    Today,
    Shift(i64),
    Page(f32),
    View(CalendarMode),
    New,
    Refresh,
    Help,
}

struct Shortcut {
    input: &'static [&'static str],
    display: &'static str,
    label: Key,
    action: Action,
}

impl Shortcut {
    const fn new(
        input: &'static [&'static str],
        display: &'static str,
        label: Key,
        action: Action,
    ) -> Self {
        Self {
            input,
            display,
            label,
            action,
        }
    }
}

const SHORTCUTS: &[Shortcut] = &[
    Shortcut::new(&["t"], "T", Key::Today, Action::Today),
    Shortcut::new(
        &["left", "["],
        "← / [",
        Key::CalendarPreviousPeriod,
        Action::Shift(-1),
    ),
    Shortcut::new(
        &["right", "]"],
        "→ / ]",
        Key::CalendarNextPeriod,
        Action::Shift(1),
    ),
    Shortcut::new(&["d"], "D", Key::ViewDay, Action::View(CalendarMode::Day)),
    Shortcut::new(&["w"], "W", Key::ViewWeek, Action::View(CalendarMode::Week)),
    Shortcut::new(
        &["m"],
        "M",
        Key::ViewMonth,
        Action::View(CalendarMode::Month),
    ),
    Shortcut::new(&["l"], "L", Key::ViewList, Action::View(CalendarMode::List)),
    Shortcut::new(&["n"], "N", Key::NewAppointment, Action::New),
    Shortcut::new(&["r"], "R", Key::SyncNow, Action::Refresh),
    Shortcut::new(&["?"], "?", Key::CalendarShortcuts, Action::Help),
    Shortcut::new(
        &["pageup"],
        "PgUp",
        Key::CalendarScrollBack,
        Action::Page(1.),
    ),
    Shortcut::new(
        &["pagedown"],
        "PgDn",
        Key::CalendarScrollForward,
        Action::Page(-1.),
    ),
];

impl Root {
    pub(super) fn sync_calendar(&mut self, cx: &mut Context<Self>) {
        self.svc.wake(Wake::Manual);
        self.force_resource_calendar_refresh(cx);
    }

    pub(super) fn open_calendar_shortcuts(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.overlay = Overlay::CalendarShortcuts;
        self.shortcuts_close_focus.focus(window);
        cx.notify();
    }

    pub(super) fn handle_calendar_shortcut(
        &mut self,
        event: &gpui::KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = &event.keystroke;
        if !matches!(self.screen, Screen::Main)
            || self.login.server_editor
            || !matches!(self.overlay, Overlay::None)
            || self.slot_drag.is_some()
            || key.modifiers.control
            || key.modifiers.platform
            || key.modifiers.alt
            || key.modifiers.function
        {
            return;
        }
        let input = key.key_char.as_deref().unwrap_or(&key.key);
        let Some(shortcut) = SHORTCUTS.iter().find(|shortcut| {
            shortcut
                .input
                .iter()
                .any(|candidate| input.eq_ignore_ascii_case(candidate))
        }) else {
            return;
        };
        cx.stop_propagation();
        if event.is_held && !matches!(shortcut.action, Action::Shift(_) | Action::Page(_)) {
            return;
        }
        match shortcut.action {
            Action::Today => self.today(cx),
            Action::Shift(direction) => self.shift_day(direction, cx),
            Action::Page(direction) => {
                if matches!(self.calendar_mode, CalendarMode::Day | CalendarMode::Week)
                    && !self.team_calendar_visible()
                {
                    let horizontal = key.modifiers.shift;
                    let handle = if horizontal {
                        &self.horizontal_scroll.handle
                    } else {
                        &self.vertical_scroll.handle
                    };
                    let mut offset = handle.offset();
                    let size = handle.bounds().size;
                    let max = handle.max_offset();
                    if horizontal {
                        offset.x = (offset.x + size.width * direction).clamp(-max.width, px(0.));
                    } else {
                        offset.y = (offset.y + size.height * direction).clamp(-max.height, px(0.));
                    }
                    handle.set_offset(offset);
                    self.focus.focus(window);
                    cx.notify();
                }
            }
            Action::View(mode) => self.set_calendar_mode(mode, cx),
            Action::New => self.open_new(window, cx),
            Action::Refresh => self.sync_calendar(cx),
            Action::Help => self.open_calendar_shortcuts(window, cx),
        }
    }

    pub(super) fn move_from_calendar_key(
        &mut self,
        id: &str,
        reviewed: &ops::ReviewedAppointment,
        date: NaiveDate,
        event: &gpui::KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = &event.keystroke;
        let mods = key.modifiers;
        if !mods.alt
            || mods.control
            || mods.platform
            || mods.shift
            || mods.function
            || !matches!(self.overlay, Overlay::None)
            || self.slot_drag.is_some()
        {
            return;
        }
        let (starts_at, staff) = match key.key.as_str() {
            "up" | "down" => {
                let direction = if key.key == "up" { -1 } else { 1 };
                let Some(start) = reviewed
                    .starts_at
                    .checked_add_signed(Span::minutes(direction * self.calendar_slot_step()))
                else {
                    return;
                };
                (Some(start), None)
            }
            "left" | "right"
                if self
                    .calendar_scope
                    .as_deref()
                    .is_none_or(|scope| scope == "all") =>
            {
                let direction = if key.key == "left" { -1 } else { 1 };
                let columns = self.calendar_columns();
                let Some((_, next)) = columns
                    .iter()
                    .position(|(day, column)| *day == date && column.staff.id == reviewed.staff_id)
                    .and_then(|index| index.checked_add_signed(direction))
                    .and_then(|index| columns.get(index))
                    .filter(|(day, _)| *day == date)
                else {
                    return;
                };
                (None, Some(next.staff.id.clone()))
            }
            _ => return,
        };
        cx.stop_propagation();
        if event.is_held {
            return;
        }
        let result = ops::queue_reviewed_appointment_edit(
            &mut self.svc.store,
            id,
            reviewed,
            ops::AppointmentEdit::Move {
                starts_at,
                staff_id: staff.as_deref(),
            },
            None,
        );
        if result.is_err() {
            self.open_details(id, cx);
            self.focus.focus(window);
            if matches!(self.overlay, Overlay::None) {
                self.reload(cx);
            }
        }
        self.finish_appointment_edit(result, cx);
    }

    pub(super) fn render_calendar_shortcuts(
        &self,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        self.modal_with_height(
            div()
                .child(
                    div()
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .text_lg()
                                .font_weight(FontWeight::BOLD)
                                .child(self.t(Key::CalendarShortcuts)),
                        )
                        .child(
                            self.button(
                                "close-calendar-shortcuts",
                                self.t(Key::Close),
                                Kind::Ghost,
                                cx.listener(|this, _, window, cx| {
                                    this.dismiss_overlay(cx);
                                    this.focus.focus(window);
                                }),
                            )
                            .track_focus(&self.shortcuts_close_focus)
                            .tab_index(0)
                            .focus(|style| style.border_color(theme::accent())),
                        ),
                )
                .child(
                    div()
                        .id("calendar-shortcuts-list")
                        .min_h_0()
                        .overflow_y_scroll()
                        .child(div().flex().flex_col().children(SHORTCUTS.iter().map(
                            |shortcut| {
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .gap_2()
                                    .py_1()
                                    .child(self.t(shortcut.label))
                                    .child(
                                        div()
                                            .flex_none()
                                            .text_color(theme::muted())
                                            .child(shortcut.display),
                                    )
                            },
                        ))),
                )
                .when(self.calendar_edits_allowed, |body| {
                    body.child(
                        div()
                            .flex()
                            .flex_none()
                            .flex_col()
                            .gap_2()
                            .pt_3()
                            .border_t_1()
                            .border_color(theme::line())
                            .children(
                                [
                                    (Key::CalendarMoveFocusedAppointment, "Alt + ↑ ↓"),
                                    (Key::CalendarMoveFocusedStaff, "Alt + ← →"),
                                ]
                                .into_iter()
                                .map(|(label, keys)| {
                                    div()
                                        .flex()
                                        .justify_between()
                                        .gap_3()
                                        .child(self.t(label))
                                        .child(
                                            div()
                                                .flex_none()
                                                .text_color(theme::muted())
                                                .child(keys),
                                        )
                                }),
                            ),
                    )
                }),
            px(560.).min((viewport.width - px(24.)).max(px(0.))),
            px(720.).min((viewport.height - px(24.)).max(px(0.))),
            None,
        )
    }
}
