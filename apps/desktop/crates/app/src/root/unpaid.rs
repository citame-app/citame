use super::*;
use sob_core::billing::{UnpaidAppointments, UnpaidRow};
use sob_core::sync::TransportError;
use uuid::Uuid;

pub(super) struct Desk {
    date: NaiveDate,
    date_field: Entity<TextField>,
    rows: Option<UnpaidAppointments>,
    request: Option<Arc<()>>,
    observation: Option<Observation>,
    error: Option<Key>,
    invalid_date: bool,
    unavailable_id: Option<String>,
    pub(super) needs_refresh: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Observation {
    replica_version: Option<i64>,
    commerce_revision: Option<i64>,
    timezone: Tz,
}

impl Root {
    pub(super) fn open_unpaid(&mut self, cx: &mut Context<Self>) {
        let date = self.date;
        let date_field = cx.new(|cx| {
            let mut field = TextField::new(self.t(Key::ShiftDatePlaceholder), false, cx);
            field.set_text(&date.to_string(), cx);
            field
        });
        self.overlay = Overlay::Unpaid(Box::new(Desk {
            date,
            date_field,
            rows: None,
            request: None,
            observation: None,
            error: None,
            invalid_date: false,
            unavailable_id: None,
            needs_refresh: true,
        }));
        self.load_unpaid(cx);
    }

    fn unpaid_observation(&self) -> Observation {
        Observation {
            replica_version: self.svc.store.data_version().ok(),
            commerce_revision: self.svc.store.live_view_revision("commerce").ok(),
            timezone: self.tz,
        }
    }

    pub(super) fn refresh_unpaid_if_changed(&mut self, reconnected: bool, cx: &mut Context<Self>) {
        let Overlay::Unpaid(desk) = &mut self.overlay else {
            return;
        };
        desk.needs_refresh |= reconnected;
        if self.status.connectivity != Connectivity::Online || desk.request.is_some() {
            return;
        }
        let observation = desk.observation;
        let watch = desk.rows.is_some() && desk.error.is_none();
        if desk.needs_refresh || (watch && observation != Some(self.unpaid_observation())) {
            self.load_unpaid(cx);
        }
    }

    fn apply_unpaid_date(&mut self, cx: &mut Context<Self>) {
        let Overlay::Unpaid(desk) = &mut self.overlay else {
            return;
        };
        let value = desk.date_field.read(cx).text().trim();
        let date = NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .ok()
            .filter(|date| (1..=9998).contains(&date.year()) && date.to_string() == value);
        if let Some(date) = date {
            self.select_unpaid_date(date, cx);
        } else {
            desk.invalid_date = true;
            cx.notify();
        }
    }

    fn select_unpaid_date(&mut self, date: NaiveDate, cx: &mut Context<Self>) {
        let Overlay::Unpaid(desk) = &mut self.overlay else {
            return;
        };
        if desk.date != date {
            desk.rows = None;
            desk.unavailable_id = None;
        }
        desk.date = date;
        desk.invalid_date = false;
        desk.date_field
            .update(cx, |field, cx| field.set_text(&date.to_string(), cx));
        self.load_unpaid(cx);
    }

    fn load_unpaid(&mut self, cx: &mut Context<Self>) {
        let observation = self.unpaid_observation();
        let transport = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online);
        let Overlay::Unpaid(desk) = &mut self.overlay else {
            return;
        };
        desk.needs_refresh = false;
        let Some(transport) = transport else {
            desk.request = None;
            desk.error = Some(Key::CashOffline);
            cx.notify();
            return;
        };
        let date = desk.date;
        let request = Arc::new(());
        desk.request = Some(request.clone());
        desk.error = None;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.unpaid_appointments(date, observation.timezone) })
                .await;
            let _ = root.update(cx, |root, cx| {
                let Overlay::Unpaid(desk) = &mut root.overlay else {
                    return;
                };
                if !desk
                    .request
                    .as_ref()
                    .is_some_and(|actual| Arc::ptr_eq(actual, &request))
                {
                    return;
                }
                desk.request = None;
                desk.observation = Some(observation);
                match result {
                    Ok(rows) => desk.rows = Some(rows),
                    Err(error) => {
                        desk.rows = None;
                        desk.error = Some(match error {
                            TransportError::Forbidden(_) | TransportError::Unauthorized => {
                                Key::DueRestricted
                            }
                            TransportError::Offline(_) => Key::CashOffline,
                            _ => Key::DueUnavailable,
                        });
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn open_unpaid_appointment(&mut self, id: &str, cx: &mut Context<Self>) {
        let Overlay::Unpaid(desk) = &mut self.overlay else {
            return;
        };
        let Ok(Some(appointment)) = calendar::effective_appointment(&self.svc.store, id) else {
            desk.unavailable_id = Some(id.to_owned());
            self.svc.wake(Wake::Manual);
            cx.notify();
            return;
        };
        let Overlay::Unpaid(mut desk) = std::mem::replace(&mut self.overlay, Overlay::None) else {
            unreachable!()
        };
        desk.unavailable_id = None;
        let receipt = id.parse::<Uuid>().ok().and_then(|id| {
            desk.rows
                .as_ref()?
                .appointments
                .iter()
                .find(|appointment| appointment.row.id == id)?
                .receipt_balance
        });
        self.show_appointment_details(appointment, Some(AppointmentReturn::Unpaid(desk)), cx);
        if let Some(receipt) = receipt {
            self.load_appointment_checkout(Some(receipt.id), cx);
        }
    }

    pub(super) fn render_unpaid(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let toolbar = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_2()
            .child(self.button(
                "unpaid-register",
                self.t(Key::CashRegister),
                Kind::Ghost,
                cx.listener(|root, _, _, cx| root.load_register(cx)),
            ))
            .child(self.button(
                "unpaid-close",
                self.t(Key::Close),
                Kind::Ghost,
                cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
            ));
        let date = div()
            .flex()
            .flex_wrap()
            .gap_2()
            .items_center()
            .child(div().w(px(140.)).child(desk.date_field.clone()))
            .child(self.button(
                "unpaid-date-submit",
                self.t(Key::DueLoadDate),
                Kind::Ghost,
                cx.listener(|root, _, _, cx| root.apply_unpaid_date(cx)),
            ))
            .child(self.button(
                "unpaid-today",
                self.t(Key::Today),
                Kind::Ghost,
                cx.listener(|root, _, _, cx| {
                    root.select_unpaid_date(Utc::now().with_timezone(&root.tz).date_naive(), cx)
                }),
            ));
        let online = self.status.connectivity == Connectivity::Online;
        let loading = desk.request.is_some() || desk.needs_refresh;
        let body = div()
            .id("unpaid-scroll")
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_3()
            .when(desk.invalid_date, |body| {
                body.child(
                    div()
                        .text_color(theme::conflict_fg())
                        .child(self.t(Key::ShiftInvalidDate)),
                )
            })
            .when_some(
                if online {
                    desk.error
                } else {
                    Some(Key::DueOffline)
                },
                |body, error| {
                    body.child(div().text_color(theme::conflict_fg()).child(self.t(error)))
                },
            )
            .when(online && loading, |body| {
                body.child(self.t(Key::DueLoading))
            })
            .when_some(
                desk.rows
                    .as_ref()
                    .filter(|_| online && !loading && desk.error.is_none()),
                |body, rows| {
                    body.when(rows.appointments.is_empty(), |body| {
                        body.child(self.t(Key::DueEmpty))
                    })
                    .children(rows.appointments.iter().map(|appointment| {
                        let mut labels = Vec::new();
                        let amount = |key, cents: u32| {
                            i18n::fill(
                                self.t(key),
                                &[("amount", &self.amount_label(cents.into(), "EUR"))],
                            )
                        };
                        if let Some(receipt) = appointment.receipt_balance {
                            if receipt.confirmed_cents > 0 {
                                labels.push(amount(Key::DueConfirmed, receipt.confirmed_cents));
                            }
                            labels.push(receipt.balance_cents.map_or_else(
                                || self.t(Key::DuePricePending).to_owned(),
                                |balance| amount(Key::DueReceiptBalance, balance),
                            ));
                            if receipt.payment_in_progress {
                                labels.push(self.t(Key::DuePaymentPending).to_owned());
                            }
                        } else if appointment.receipt_restricted {
                            labels.push(self.t(Key::DueReceiptRestricted).to_owned());
                        } else if let Some(balance) = appointment.external_balance {
                            labels.push(amount(Key::DueBalance, balance.due_in_citame_cents));
                        }
                        self.render_unpaid_row(
                            &appointment.row,
                            &[],
                            labels,
                            appointment.receipt_balance.is_some(),
                            desk,
                            cx,
                        )
                    }))
                    .when(!rows.billing_review.is_empty(), |body| {
                        body.child(
                            div()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(self.t(Key::DueReview)),
                        )
                        .child(div().text_sm().child(self.t(Key::DueReviewHelp)))
                        .children(rows.billing_review.iter().map(|appointment| {
                            self.render_unpaid_row(
                                &appointment.row,
                                &appointment.reasons,
                                Vec::new(),
                                false,
                                desk,
                                cx,
                            )
                        }))
                    })
                },
            );
        self.modal_with_height(
            div()
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .justify_between()
                        .gap_2()
                        .child(
                            div()
                                .text_lg()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(self.t(Key::DueAppointments)),
                        )
                        .child(toolbar),
                )
                .child(self.label(Key::DueDate))
                .child(date)
                .child(i18n::date_label(self.locale, desk.date))
                .child(body),
            (viewport.width - px(24.)).clamp(px(260.), px(820.)),
            (viewport.height - px(24.)).clamp(px(220.), px(780.)),
            Some(cx),
        )
    }

    fn render_unpaid_row(
        &self,
        row: &UnpaidRow,
        reasons: &[BillingReviewReason],
        labels: Vec<String>,
        has_receipt: bool,
        desk: &Desk,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let id = row.id.to_string();
        let unavailable = desk.unavailable_id.as_deref() == Some(id.as_str());
        div()
            .id(SharedString::from(id.clone()))
            .flex()
            .flex_col()
            .gap_1()
            .p_2()
            .rounded_md()
            .border_1()
            .border_color(theme::line())
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .child(div().font_weight(FontWeight::MEDIUM).child(format!(
                        "{} · {}",
                        self.date_time_label(row.starts_at),
                        row.client_name
                    )))
                    .child(
                        self.button(
                            "unpaid-open-appointment",
                            self.t(if has_receipt {
                                Key::DueOpenReceipt
                            } else {
                                Key::DueOpenAppointment
                            }),
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| {
                                root.open_unpaid_appointment(&id, cx)
                            }),
                        )
                        .debug_selector(|| "unpaid-open-appointment".to_owned()),
                    ),
            )
            .child(
                div()
                    .text_sm()
                    .child(self.staff_name(&row.staff_id.to_string())),
            )
            .child(div().text_sm().child(row.service_names.join(", ")))
            .children(labels.into_iter().map(|label| div().text_sm().child(label)))
            .children(reasons.iter().map(|reason| {
                div()
                    .text_sm()
                    .text_color(theme::conflict_fg())
                    .child(self.t(match reason {
                        BillingReviewReason::UnknownAmount => Key::DueUnknownAmount,
                        BillingReviewReason::PaidInBooksy => Key::DuePaidInBooksy,
                        BillingReviewReason::InvoicedInBooksy => Key::DueInvoicedInBooksy,
                        BillingReviewReason::UnknownBooksyPayment => Key::DueUnknownBooksyPayment,
                    }))
            }))
            .when(unavailable, |body| {
                body.child(
                    div()
                        .text_sm()
                        .child(self.t(Key::ShiftAppointmentUnavailable)),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{EXISTING, desk};
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn closing_an_appointment_restores_the_selected_day(cx: &mut TestAppContext) {
        let (_directory, config) = desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(1080.), px(820.)));
        let date = root.update(cx, |root, cx| {
            root.open_unpaid(cx);
            root.status.connectivity = Connectivity::Online;
            let appointment = root.svc.store.appointment(EXISTING).unwrap().unwrap();
            let member = root
                .report_staff_options
                .iter_mut()
                .find(|member| member.id == appointment.staff_id)
                .unwrap();
            member.active = false;
            let assigned_name = member.display_name.clone();
            root.staff
                .retain(|member| member.id != appointment.staff_id);
            assert_eq!(root.staff_name(&appointment.staff_id), assigned_name);
            let Overlay::Unpaid(desk) = &mut root.overlay else {
                panic!("expected unpaid appointments");
            };
            desk.date = appointment.starts_at.with_timezone(&root.tz).date_naive();
            desk.error = None;
            desk.rows = Some(
                serde_json::from_value(serde_json::json!({
                    "appointments": [],
                    "billingReview": [{
                        "id": EXISTING,
                        "staffId": appointment.staff_id,
                        "clientName": "Fixture",
                        "startsAt": appointment.starts_at,
                        "serviceNames": ["Fixture treatment"],
                        "reasons": ["unknown_amount"],
                    }],
                }))
                .unwrap(),
            );
            desk.date
        });
        cx.run_until_parked();
        let open = cx.debug_bounds("unpaid-open-appointment").unwrap();
        cx.simulate_click(open.center(), Default::default());
        cx.run_until_parked();
        root.update(cx, |root, _| {
            assert!(matches!(&root.overlay, Overlay::Details(details)
                if details.id == EXISTING && matches!(details.return_to, Some(AppointmentReturn::Unpaid(_)))));
        });
        let close = cx.debug_bounds("calendar-details-close").unwrap();
        cx.simulate_click(close.center(), Default::default());
        cx.run_until_parked();
        root.update(cx, |root, _| {
            assert!(matches!(&root.overlay, Overlay::Unpaid(desk)
                if desk.date == date && desk.needs_refresh));
        });
    }
}
