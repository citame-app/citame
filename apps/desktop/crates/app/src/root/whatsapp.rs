use super::*;
use sob_core::auth::BrowserWorkspace;
use sob_core::http::whatsapp::{
    Connection, Delivery, Event, LIVE_TOPIC, Status as DeliveryStatus, Variable, WhatsAppDesk,
};
use sob_core::sync::TransportError;
use std::time::Instant;

pub(super) struct Desk {
    identity: Arc<()>,
    snapshot: Option<WhatsAppDesk>,
    observed: Option<i64>,
    retry_after: Option<Instant>,
    loading: bool,
    error: bool,
}

fn event_key(event: Event) -> Key {
    match event {
        Event::Confirmation => Key::WhatsappConfirmation,
        Event::Reminder24h => Key::WhatsappFirstReminder,
        Event::Reminder2h => Key::WhatsappSecondReminder,
        Event::Rescheduled => Key::InboxRescheduled,
        Event::Cancellation => Key::WhatsappCancellation,
    }
}

fn variable_key(variable: Variable) -> Key {
    match variable {
        Variable::Client => Key::Client,
        Variable::Salon => Key::SalonName,
        Variable::Date => Key::WhatsappDate,
        Variable::Time => Key::WhatsappTime,
        Variable::Staff => Key::Staff,
        Variable::Services => Key::SaleServices,
        Variable::Preferences => Key::WhatsappPreferences,
    }
}

fn delivery_key(delivery: &Delivery) -> Key {
    match delivery.displayed_status() {
        None => Key::WhatsappUnknown,
        Some(status) => match status {
            DeliveryStatus::Pending => Key::WhatsappPending,
            DeliveryStatus::Processing => Key::WhatsappProcessing,
            DeliveryStatus::Sent => Key::WhatsappSent,
            DeliveryStatus::Skipped => Key::WhatsappSkipped,
            DeliveryStatus::Cancelled => Key::WhatsappCancelled,
            DeliveryStatus::Failed => Key::WhatsappFailed,
            DeliveryStatus::Delivered => Key::WhatsappDelivered,
            DeliveryStatus::Read => Key::WhatsappRead,
        },
    }
}

impl Root {
    pub(super) fn open_whatsapp_desk(&mut self, cx: &mut Context<Self>) {
        if !self.can_configure_salon() {
            return;
        }
        self.overlay = Overlay::Whatsapp(Box::new(Desk {
            identity: Arc::new(()),
            snapshot: None,
            observed: None,
            retry_after: None,
            loading: false,
            error: false,
        }));
        self.load_whatsapp_desk(cx);
        cx.notify();
    }

    pub(super) fn refresh_whatsapp_desk(&mut self, reconnected: bool, cx: &mut Context<Self>) {
        let Overlay::Whatsapp(desk) = &self.overlay else {
            return;
        };
        if self.status.connectivity != Connectivity::Online || desk.loading {
            return;
        }
        let current = self.svc.store.live_view_revision(LIVE_TOPIC).ok();
        let changed = current != desk.observed;
        let due = desk
            .retry_after
            .is_some_and(|waiting| Instant::now() >= waiting);
        if reconnected || due || (changed && desk.retry_after.is_none()) {
            self.load_whatsapp_desk(cx);
        }
    }

    fn load_whatsapp_desk(&mut self, cx: &mut Context<Self>) {
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let Overlay::Whatsapp(desk) = &mut self.overlay else {
            return;
        };
        if desk.loading {
            return;
        }
        desk.loading = true;
        desk.retry_after = None;
        let cursor = self.svc.store.live_view_revision(LIVE_TOPIC).ok();
        let identity = desk.identity.clone();
        let session = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.whatsapp_desk() })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session) {
                    return;
                }
                let Overlay::Whatsapp(desk) = &mut root.overlay else {
                    return;
                };
                if !Arc::ptr_eq(&desk.identity, &identity) {
                    return;
                }
                desk.loading = false;
                desk.error = result.is_err();
                match result {
                    Ok(snapshot) => {
                        desk.observed = cursor;
                        desk.snapshot = Some(snapshot);
                    }
                    Err(TransportError::Offline(_) | TransportError::Server(_)) => {
                        desk.retry_after = Some(Instant::now() + std::time::Duration::from_secs(3));
                    }
                    Err(TransportError::RateLimited(delay)) => {
                        desk.retry_after = Instant::now()
                            .checked_add(delay.unwrap_or(std::time::Duration::from_secs(3)));
                        desk.observed = cursor;
                    }
                    Err(_) => {
                        desk.observed = cursor;
                        desk.snapshot = None;
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn render_whatsapp_connection(&self, connection: &Connection) -> gpui::Div {
        let expiry = connection.expires_at.map(|expires| {
            let label = if expires <= Utc::now() {
                Key::WhatsappExpired
            } else {
                Key::WhatsappExpires
            };
            format!("{} · {}", self.t(label), self.date_time_label(expires))
        });
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(connection.phone.clone()),
            )
            .child(self.t(if connection.coexistence {
                Key::WhatsappCoexistence
            } else {
                Key::WhatsappCloud
            }))
            .when_some(expiry, |body, expiry| {
                body.child(div().text_sm().child(expiry))
            })
            .child(
                div()
                    .pt_2()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::WhatsappAutomations)),
            )
            .when(connection.rules.is_empty(), |body| {
                body.child(self.t(Key::WhatsappNoRules))
            })
            .children(connection.rules.iter().map(|rule| {
                let variables = rule
                    .variables
                    .iter()
                    .map(|var| self.t(variable_key(*var)))
                    .collect::<Vec<_>>()
                    .join(" · ");
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .py_1()
                    .child(
                        div()
                            .font_weight(FontWeight::MEDIUM)
                            .child(self.t(event_key(rule.kind))),
                    )
                    .child(format!("{} · {}", rule.template_name, rule.language))
                    .when(!variables.is_empty(), |row| {
                        row.child(div().text_sm().text_color(theme::muted()).child(variables))
                    })
            }))
    }

    pub(super) fn render_whatsapp_desk(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let content = div()
            .id("whatsapp-desk-scroll")
            .max_h((viewport.height - px(68.)).max(px(100.)))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::CloudWhatsapp)),
            )
            .when(!online, |body| body.child(self.t(Key::WhatsappOffline)))
            .when(desk.error && online, |body| {
                body.child(self.t(Key::WhatsappLoadFailed))
            })
            .when(desk.loading && desk.snapshot.is_none(), |body| {
                body.child(self.t(Key::EmailDeliveryWorking))
            })
            .when_some(desk.snapshot.as_ref(), |body, snapshot| {
                body.when_some(snapshot.connection.as_ref(), |body, connection| {
                    body.child(self.render_whatsapp_connection(connection))
                })
                .when(!snapshot.configured, |body| {
                    body.child(self.t(Key::WhatsappNotConfigured))
                })
                .when(
                    snapshot.configured && snapshot.connection.is_none(),
                    |body| body.child(self.t(Key::WhatsappNotConnected)),
                )
                .child(
                    div()
                        .pt_2()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(self.t(Key::WhatsappDeliveries)),
                )
                .when(snapshot.deliveries.is_empty(), |body| {
                    body.child(self.t(Key::WhatsappNoDeliveries))
                })
                .children(snapshot.deliveries.iter().map(|delivery| {
                    div()
                        .flex()
                        .flex_wrap()
                        .justify_between()
                        .gap_2()
                        .py_1()
                        .child(div().text_sm().child(format!(
                            "{} · {}",
                            self.t(event_key(delivery.kind)),
                            self.date_time_label(delivery.scheduled_for)
                        )))
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::MEDIUM)
                                .child(self.t(delivery_key(delivery))),
                        )
                }))
            })
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.button(
                        "whatsapp-back",
                        self.t(Key::Back),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.open_web_management(cx)),
                    ))
                    .when(online, |row| {
                        row.child(self.button(
                            "whatsapp-reload",
                            self.t(Key::WhatsappRefresh),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.load_whatsapp_desk(cx)),
                        ))
                        .child(self.button(
                            "whatsapp-web",
                            self.t(Key::WhatsappOpenWeb),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| {
                                root.open_web_management(cx);
                                root.open_web_workspace(Some(BrowserWorkspace::Whatsapp), cx);
                            }),
                        ))
                    }),
            );
        self.modal_with_height(
            div().min_h_0().child(content),
            (viewport.width - px(32.)).max(px(220.)).min(px(640.)),
            (viewport.height - px(28.)).max(px(140.)),
            Some(cx),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn only_the_owner_can_open_the_native_whatsapp_desk(cx: &mut TestAppContext) {
        let (_directory, window) = super::super::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                root.status.connectivity = Connectivity::Offline;
                root.open_whatsapp_desk(cx);
                assert!(matches!(&root.overlay, Overlay::Whatsapp(desk)
                if desk.snapshot.is_none() && !desk.loading));
                root.dismiss_overlay(cx);
                assert!(matches!(root.overlay, Overlay::Cloud(_)));
                root.svc.session.write().unwrap().as_mut().unwrap().role = "staff".into();
                root.open_whatsapp_desk(cx);
                assert!(matches!(root.overlay, Overlay::Cloud(_)));
            })
            .unwrap();
    }
}
