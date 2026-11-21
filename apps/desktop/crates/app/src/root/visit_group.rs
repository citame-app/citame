use super::*;

fn can_switch(details: &Details) -> bool {
    details.start == details.reviewed.starts_at
        && details.staff_id == details.reviewed.staff_id
        && !details.confirm_cancel
        && details.price_review.is_none()
        && details.settlement_review.is_none()
        && details.checkout.is_none()
        && !matches!(
            details.annotations,
            Some(annotations::Annotations::Editing(_))
        )
}

impl Root {
    pub(super) fn render_related_visit(
        &self,
        appointment: &Appointment,
        details: &Details,
        cx: &mut Context<Self>,
    ) -> Option<Stateful<gpui::Div>> {
        let related = calendar::related_visit_appointments(&self.svc.store, appointment).ok()?;
        if related.is_empty() {
            return None;
        }
        let can_open = can_switch(details);
        Some(
            div()
                .id("related-visit-appointments")
                .flex()
                .flex_col()
                .gap_2()
                .p_3()
                .rounded_lg()
                .border_1()
                .border_color(theme::line())
                .child(self.label(Key::CalendarRelatedVisit))
                .when(!can_open, |section| {
                    section.child(
                        div()
                            .text_sm()
                            .text_color(theme::muted())
                            .child(self.t(Key::CalendarRelatedVisitEdit)),
                    )
                })
                .children(related.into_iter().map(|other| {
                    let service_names = other
                        .services
                        .iter()
                        .map(|service| service.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ");
                    let status = match other.status {
                        AppointmentStatus::Booked => Key::WaitlistBooked,
                        AppointmentStatus::Cancelled => Key::CalendarCancelled,
                        AppointmentStatus::Completed => Key::Completed,
                        AppointmentStatus::NoShow => Key::NoShow,
                    };
                    let row = div()
                        .id(SharedString::from(format!(
                            "related-appointment-{}",
                            other.id
                        )))
                        .flex()
                        .flex_col()
                        .gap_1()
                        .p_2()
                        .rounded_md()
                        .bg(theme::bg())
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(service_names),
                        )
                        .child(div().text_sm().text_color(theme::muted()).child(format!(
                            "{} · {} · {}",
                            self.date_time_label(other.starts_at),
                            self.staff_name(&other.staff_id),
                            self.t(status),
                        )));
                    row.when(can_open, |row| {
                        row.tab_index(0)
                            .cursor_pointer()
                            .hover(|style| style.bg(theme::accent_soft()))
                            .focus(|style| style.bg(theme::accent_soft()))
                            .on_click(cx.listener(move |root, _, _, cx| {
                                root.open_related_visit(&other.id, cx)
                            }))
                    })
                })),
        )
    }

    fn open_related_visit(&mut self, id: &str, cx: &mut Context<Self>) {
        let Overlay::Details(details) = &mut self.overlay else {
            return;
        };
        if !can_switch(details) {
            return;
        }
        let Ok(Some(current)) = calendar::effective_appointment(&self.svc.store, &details.id)
        else {
            return;
        };
        let Some(related) = calendar::related_visit_appointments(&self.svc.store, &current)
            .ok()
            .and_then(|group| group.into_iter().find(|a| a.id == id))
        else {
            return;
        };
        let return_to = details.return_to.take();
        self.show_appointment_details(related, return_to, cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sob_core::model::RawChange;

    #[gpui::test]
    async fn offline_visit_navigation_respects_the_open_appointment_edit(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_dir, config) = crate::root::tests::desk();
        let (view, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        view.update(cx, |root, cx| {
            root.svc.stop_sync();
            root.status.connectivity = Connectivity::Offline;
            let mut current = root
                .svc
                .store
                .appointments_between(0, i64::MAX)
                .unwrap()
                .remove(0);
            current.visit_group_id = Some("group".into());
            let mut other = current.clone();
            other.id = uuid::Uuid::now_v7().to_string();
            other.starts_at += Span::days(1);
            other.ends_at += Span::days(1);
            root.svc
                .store
                .apply_page(
                    &[
                        RawChange {
                            seq: 10,
                            entity: "appointment".into(),
                            id: current.id.clone(),
                            op: "upsert".into(),
                            data: Some(serde_json::to_value(&current).unwrap()),
                        },
                        RawChange {
                            seq: 11,
                            entity: "appointment".into(),
                            id: other.id.clone(),
                            op: "upsert".into(),
                            data: Some(serde_json::to_value(&other).unwrap()),
                        },
                    ],
                    11,
                )
                .unwrap();
            root.open_details(&current.id, cx);
            let Overlay::Details(details) = &mut root.overlay else {
                panic!("details");
            };
            details.start += Span::minutes(15);
            root.open_related_visit(&other.id, cx);
            let Overlay::Details(details) = &mut root.overlay else {
                panic!("details");
            };
            assert_eq!(details.id, current.id);
            details.start = details.reviewed.starts_at;
            root.open_related_visit(&other.id, cx);
            let Overlay::Details(details) = &root.overlay else {
                panic!("details");
            };
            assert_eq!(details.id, other.id);
            assert!(root.svc.store.outbox(10).unwrap().is_empty());
        });
    }
}
