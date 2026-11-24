use super::*;

#[derive(Clone, Copy)]
enum Action {
    Today,
    Shift(i64),
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
        if event.is_held && !matches!(shortcut.action, Action::Shift(_)) {
            return;
        }
        match shortcut.action {
            Action::Today => self.today(cx),
            Action::Shift(direction) => self.shift_day(direction, cx),
            Action::View(mode) => self.set_calendar_mode(mode, cx),
            Action::New => self.open_new(window, cx),
            Action::Refresh => self.sync_calendar(cx),
            Action::Help => self.open_calendar_shortcuts(window, cx),
        }
    }

    pub(super) fn render_calendar_shortcuts(&self, cx: &mut Context<Self>) -> gpui::Div {
        self.modal(
            div()
                .child(
                    div()
                        .flex()
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
                        .flex()
                        .flex_col()
                        .children(SHORTCUTS.iter().map(|shortcut| {
                            div()
                                .flex()
                                .items_center()
                                .justify_between()
                                .py_1()
                                .child(self.t(shortcut.label))
                                .child(div().text_color(theme::muted()).child(shortcut.display))
                        })),
                ),
        )
    }
}
