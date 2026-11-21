use super::*;

const NOTICE_DURATION: Duration = Duration::from_secs(12);

impl Root {
    pub(super) fn refresh_notices(&mut self) {
        let store = &self.svc.store;
        self.notices.retain_mut(|(appointment, _)| {
            let Ok(Some(current)) = store.appointment(&appointment.id) else {
                return false;
            };
            *appointment = current;
            appointment.status == AppointmentStatus::Booked
        });
        let Ok(fresh) = store.booking_notices_after(self.notice_cursor) else {
            return;
        };
        let deadline = Instant::now() + NOTICE_DURATION;
        for (cursor, appointment) in fresh.into_iter().rev() {
            self.notice_cursor = cursor;
            self.notices.insert(0, (appointment, deadline));
        }
        self.notices.truncate(3);
    }

    fn dismiss_notice(&mut self, id: &str, cx: &mut Context<Self>) {
        self.notices.retain(|(appointment, _)| appointment.id != id);
        cx.notify();
    }

    pub(super) fn show_notice(&mut self, id: &str, cx: &mut Context<Self>) {
        self.dismiss_notice(id, cx);
        let Ok(Some(appointment)) = calendar::effective_appointment(&self.svc.store, id) else {
            return;
        };
        self.pending_local_today = false;
        self.calendar_mode = CalendarMode::Day;
        self.overview_staff.clear();
        self.date = appointment.starts_at.with_timezone(&self.tz).date_naive();
        self.reload(cx);
        self.open_details(id, cx);
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
            .children(self.notices.iter().map(|(appointment, _)| {
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
                            .child(self.t(Key::NewBookingNotice)),
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
