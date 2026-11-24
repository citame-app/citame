use super::*;

const NOTICE_DURATION: Duration = Duration::from_secs(12);

pub(super) fn title_key(kind: CalendarNoticeKind) -> Key {
    match kind {
        CalendarNoticeKind::New => Key::NewBookingNotice,
        CalendarNoticeKind::Rescheduled => Key::InboxRescheduled,
        CalendarNoticeKind::Cancelled => Key::InboxCancelled,
    }
}

impl Root {
    pub(super) fn expire_notices(&mut self, now: Instant) {
        if matches!(self.overlay, Overlay::None) {
            self.notices.retain(|(_, _, deadline)| *deadline > now);
        } else {
            for (_, _, deadline) in &mut self.notices {
                *deadline = now + NOTICE_DURATION;
            }
        }
    }

    pub(super) fn refresh_notices(&mut self) {
        let store = &self.svc.store;
        self.notices.retain_mut(|(kind, appointment, _)| {
            let Ok(Some(current)) = store.appointment(&appointment.id) else {
                return false;
            };
            if current.status != kind.appointment_status()
                || current.starts_at != appointment.starts_at
                || current.staff_id != appointment.staff_id
            {
                return false;
            }
            *appointment = current;
            true
        });
        let Ok(fresh) = store.booking_notices_after(self.notice_cursor) else {
            return;
        };
        let deadline = Instant::now() + NOTICE_DURATION;
        for (cursor, kind, appointment) in fresh.into_iter().rev() {
            self.notice_cursor = cursor;
            self.notices
                .retain(|(_, shown, _)| shown.id != appointment.id);
            self.notices.insert(0, (kind, appointment, deadline));
        }
        self.notices.truncate(3);
    }

    fn dismiss_notice(&mut self, id: &str, cx: &mut Context<Self>) {
        self.notices
            .retain(|(_, appointment, _)| appointment.id != id);
        cx.notify();
    }

    pub(super) fn show_notice(&mut self, id: &str, cx: &mut Context<Self>) {
        if !matches!(self.overlay, Overlay::None) {
            return;
        }
        self.dismiss_notice(id, cx);
        self.open_notice_appointment(id, None, cx);
    }

    pub(super) fn open_notice_appointment(
        &mut self,
        id: &str,
        placement: Option<(DateTime<Utc>, &str)>,
        cx: &mut Context<Self>,
    ) -> bool {
        let Ok(Some(appointment)) = calendar::effective_appointment(&self.svc.store, id) else {
            return false;
        };
        self.pending_local_today = false;
        self.calendar_mode = CalendarMode::Day;
        self.overview_staff.clear();
        let starts_at = placement.map_or(appointment.starts_at, |(starts, _)| starts);
        if let Some((_, staff)) = placement {
            self.overview_staff.insert(staff.to_owned());
        }
        self.date = starts_at.with_timezone(&self.tz).date_naive();
        self.reload(cx);
        self.open_details(id, cx);
        true
    }

    pub(super) fn render_notices(&self, cx: &mut Context<Self>) -> gpui::Div {
        div()
            .absolute()
            .top(px(72.))
            .right(px(16.))
            .w(px(320.))
            .max_w(relative(0.9))
            .flex()
            .flex_col()
            .gap_2()
            .children(self.notices.iter().map(|(kind, appointment, _)| {
                let title = self.t(title_key(*kind));
                let id = appointment.id.clone();
                let open_id = id.clone();
                let dismiss_id = id.clone();
                let client = self.appointment_client_name(appointment);
                let services = appointment
                    .services
                    .iter()
                    .map(|s| s.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .p_3()
                    .rounded_lg()
                    .border_1()
                    .border_color(theme::line())
                    .bg(theme::panel())
                    .shadow_md()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme::accent())
                            .child(title),
                    )
                    .child(div().truncate().child(SharedString::from(client)))
                    .child(
                        div()
                            .text_sm()
                            .truncate()
                            .child(SharedString::from(services)),
                    )
                    .child(div().text_sm().truncate().text_color(theme::muted()).child(
                        SharedString::from(format!(
                            "{} · {}",
                            self.date_time_label(appointment.starts_at),
                            self.staff_name(&appointment.staff_id),
                        )),
                    ))
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(self.button(
                                SharedString::from(format!("open-notice-{id}")),
                                self.t(Key::ViewBookingNotice),
                                Kind::Primary,
                                cx.listener(move |this, _, _, cx| this.show_notice(&open_id, cx)),
                            ))
                            .child(self.button(
                                SharedString::from(format!("dismiss-notice-{id}")),
                                self.t(Key::DismissBookingNotice),
                                Kind::Ghost,
                                cx.listener(move |this, _, _, cx| {
                                    this.dismiss_notice(&dismiss_id, cx)
                                }),
                            )),
                    )
            }))
    }
}
