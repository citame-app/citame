use super::*;
use sob_core::reviews::{EmailStatus, LIVE_TOPIC, MAX_PAGE, ReviewRequests, ReviewVisit};
use sob_core::sync::TransportError;

const POLL_INTERVAL: Duration = Duration::from_secs(3);

pub(super) struct Desk {
    search: Entity<TextField>,
    _search: Subscription,
    submitted_search: String,
    page: u32,
    visits: Option<ReviewRequests>,
    pub(super) busy: bool,
    pub(super) confirm: Option<String>,
    error: Option<Key>,
    copied: Option<String>,
    poll_after: Option<Instant>,
    observed_revision: i64,
}

enum Action {
    ReadPage,
    SendEmail(String),
}

enum Reply {
    Read(Result<ReviewRequests, TransportError>),
    Send(String, Result<EmailStatus, TransportError>),
}

fn status_key(status: EmailStatus) -> Key {
    match status {
        EmailStatus::Pending => Key::ReviewRequestPending,
        EmailStatus::Processing => Key::ReviewRequestProcessing,
        EmailStatus::Sent => Key::ReviewRequestSent,
        EmailStatus::Skipped => Key::ReviewRequestSkipped,
        EmailStatus::Failed => Key::ReviewRequestFailed,
        EmailStatus::Unknown => Key::ReviewRequestUnknown,
        EmailStatus::Cancelled => Key::ReviewRequestCancelled,
    }
}

impl Desk {
    fn can_go_next(&self) -> bool {
        self.page < MAX_PAGE && self.visits.as_ref().is_some_and(|data| data.has_more)
    }

    fn find(&self, id: &str) -> Option<&ReviewVisit> {
        self.visits
            .as_ref()?
            .visits
            .iter()
            .find(|visit| visit.appointment_id == id)
    }

    fn allows_email(&self, id: &str) -> bool {
        self.find(id)
            .is_some_and(|visit| visit.can_email && visit.email_status.is_none())
    }

    fn poll_if_pending(&mut self) {
        self.poll_after = self
            .visits
            .as_ref()
            .is_some_and(|data| {
                data.visits
                    .iter()
                    .any(|visit| visit.email_status.is_some_and(EmailStatus::is_pending))
            })
            .then(|| Instant::now() + POLL_INTERVAL);
    }

    fn set_error(&mut self, error: TransportError, sending: bool) {
        self.error = Some(match error {
            TransportError::Unauthorized | TransportError::Forbidden(_) => {
                self.visits = None;
                self.confirm = None;
                self.copied = None;
                Key::ReviewRequestDenied
            }
            TransportError::Offline(_) if !sending => Key::ReviewRequestOffline,
            _ if sending => Key::ReviewRequestEmailError,
            _ => Key::ReviewRequestUnavailable,
        });
    }
}

impl Root {
    pub(super) fn open_review_requests(&mut self, cx: &mut Context<Self>) {
        self.review_generation = self.review_generation.wrapping_add(1);
        let search = cx.new(|cx| TextField::new(self.t(Key::ReviewRequestSearch), false, cx));
        let subscribe = cx.subscribe(&search, |root: &mut Root, _, event, cx| {
            if matches!(event, FieldEvent::Submit) {
                root.search_review_requests(cx);
            }
        });
        self.overlay = Overlay::Reviews(Box::new(Desk {
            search,
            _search: subscribe,
            submitted_search: String::new(),
            page: 1,
            visits: None,
            busy: false,
            confirm: None,
            error: None,
            copied: None,
            poll_after: None,
            observed_revision: 0,
        }));
        self.run_review_action(Action::ReadPage, cx);
    }

    pub(super) fn refresh_review_requests(&mut self, reconnected: bool, cx: &mut Context<Self>) {
        if matches!(&self.overlay, Overlay::Reviews(desk) if
            !desk.busy
                && (reconnected || (desk.confirm.is_none()
                    && desk.poll_after.is_some_and(|next| Instant::now() >= next))
                    || self.svc.store.live_view_revision(LIVE_TOPIC).ok()
                        .is_some_and(|revision| revision != desk.observed_revision)))
        {
            self.run_review_action(Action::ReadPage, cx);
        }
    }

    fn search_review_requests(&mut self, cx: &mut Context<Self>) {
        if let Overlay::Reviews(desk) = &mut self.overlay
            && !desk.busy
            && desk.confirm.is_none()
        {
            desk.submitted_search = desk.search.read(cx).text().to_owned();
            desk.page = 1;
            desk.visits = None;
            desk.copied = None;
            self.run_review_action(Action::ReadPage, cx);
        }
    }

    fn page_review_requests(&mut self, forward: bool, cx: &mut Context<Self>) {
        let Overlay::Reviews(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy || desk.confirm.is_some() {
            return;
        }
        if forward && desk.can_go_next() {
            desk.page += 1;
        } else if !forward && desk.page > 1 {
            desk.page -= 1;
        } else {
            return;
        }
        desk.visits = None;
        desk.copied = None;
        self.run_review_action(Action::ReadPage, cx);
    }

    fn run_review_action(&mut self, action: Action, cx: &mut Context<Self>) {
        let Overlay::Reviews(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy
            || matches!(&action, Action::SendEmail(id)
                if desk.confirm.as_ref() != Some(id) || !desk.allows_email(id))
        {
            return;
        }
        if self.svc.status().connectivity == Connectivity::Offline {
            desk.error = Some(Key::ReviewRequestOffline);
            cx.notify();
            return;
        }
        let Some(transport) = self.svc.transport() else {
            desk.error = Some(Key::ReviewRequestOffline);
            cx.notify();
            return;
        };
        let generation = self.review_generation;
        let session = self.svc.session.clone();
        let page = desk.page;
        let search = desk.submitted_search.clone();
        if matches!(&action, Action::ReadPage) {
            desk.observed_revision = self
                .svc
                .store
                .live_view_revision(LIVE_TOPIC)
                .unwrap_or_default();
        }
        desk.busy = true;
        desk.error = None;
        desk.poll_after = None;
        cx.notify();
        cx.spawn(async move |view, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match action {
                        Action::ReadPage => Reply::Read(transport.review_requests(page, &search)),
                        Action::SendEmail(id) => {
                            let result = transport.request_review_email(&id);
                            Reply::Send(id, result)
                        }
                    }
                })
                .await;
            let _ = view.update(cx, |root, cx| {
                if generation != root.review_generation
                    || !Arc::ptr_eq(&session, &root.svc.session)
                    || root.svc.current_session().is_none()
                {
                    return;
                }
                let Overlay::Reviews(desk) = &mut root.overlay else {
                    return;
                };
                desk.busy = false;
                match result {
                    Reply::Read(Ok(data)) => {
                        desk.visits = Some(data);
                        if desk
                            .confirm
                            .as_ref()
                            .is_some_and(|id| !desk.allows_email(id))
                        {
                            desk.confirm = None;
                        }
                        desk.poll_if_pending();
                    }
                    Reply::Read(Err(error)) => {
                        let retry = matches!(
                            &error,
                            TransportError::Offline(_) | TransportError::Server(_)
                        );
                        desk.set_error(error, false);
                        if retry {
                            desk.poll_after = Some(Instant::now() + POLL_INTERVAL);
                        }
                    }
                    Reply::Send(id, Ok(status)) => {
                        desk.confirm = None;
                        if let Some(visit) = desk.visits.as_mut().and_then(|data| {
                            data.visits
                                .iter_mut()
                                .find(|visit| visit.appointment_id == id)
                        }) {
                            visit.email_status = Some(status);
                        }
                        desk.poll_if_pending();
                    }
                    Reply::Send(_, Err(error)) => {
                        desk.confirm = None;
                        desk.set_error(error, true);
                        if desk.visits.is_some() {
                            desk.poll_after = Some(Instant::now() + POLL_INTERVAL);
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn copy_review_link(&mut self, id: &str, cx: &mut Context<Self>) {
        if let Overlay::Reviews(desk) = &mut self.overlay
            && let Some(link) = desk.find(id).and_then(|visit| visit.link.as_ref())
        {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string(link.clone()));
            desk.copied = Some(id.to_owned());
            cx.notify();
        }
    }

    pub(super) fn render_review_requests(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let connected = self.status.connectivity != Connectivity::Offline;
        let browse = desk.confirm.is_none() && connected;
        let width = (viewport.width - px(32.)).clamp(px(280.), px(720.));
        let height = (viewport.height - px(32.)).clamp(px(180.), px(740.));
        let mut body = div().child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .text_lg()
                        .font_weight(FontWeight::BOLD)
                        .child(self.t(Key::ReviewRequests)),
                )
                .child(self.button(
                    "reviews-open-moderation",
                    self.t(Key::ReviewModeration),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.open_review_moderation(cx)),
                ))
                .child(self.button(
                    "reviews-close",
                    self.t(Key::Close),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                )),
        );
        body = body.child(
            div()
                .id("reviews-content")
                .debug_selector(|| "reviews-content".into())
                .overflow_y_scroll()
                .min_h_0()
                .flex()
                .flex_col()
                .gap_3()
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_end()
                        .gap_2()
                        .child(
                            div()
                                .min_w(px(164.))
                                .flex_1()
                                .child(div().text_sm().child(self.t(Key::ReviewRequestSearch)))
                                .child(desk.search.clone()),
                        )
                        .when(browse, |row| {
                            row.child(self.button(
                                "reviews-search",
                                self.t(Key::ReviewRequestFind),
                                Kind::Primary,
                                cx.listener(|root, _, _, cx| root.search_review_requests(cx)),
                            ))
                            .child(self.button(
                                "reviews-refresh",
                                self.t(Key::InboxRefresh),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| {
                                    root.run_review_action(Action::ReadPage, cx)
                                }),
                            ))
                        }),
                )
                .when(!connected, |panel| {
                    panel.child(div().text_sm().child(self.t(Key::ReviewRequestOffline)))
                })
                .when(desk.busy && desk.visits.is_none(), |panel| {
                    panel.child(div().text_sm().child(self.t(Key::ReviewRequestLoading)))
                })
                .when_some(
                    desk.error
                        .filter(|error| connected || *error != Key::ReviewRequestOffline),
                    |panel, error| panel.child(div().text_sm().child(self.t(error))),
                )
                .when_some(desk.visits.as_ref(), |panel, requests| {
                    panel
                        .when(requests.email_enabled, |panel| {
                            panel.child(
                                div()
                                    .text_sm()
                                    .text_color(theme::muted())
                                    .child(self.t(Key::ReviewRequestEmailHelp)),
                            )
                        })
                        .when(requests.visits.is_empty(), |panel| {
                            panel.child(div().text_sm().child(self.t(Key::ReviewRequestEmpty)))
                        })
                        .children(
                            requests
                                .visits
                                .iter()
                                .map(|visit| self.render_review_visit(visit, desk, browse, cx)),
                        )
                }),
        );
        if browse && (desk.page > 1 || desk.can_go_next()) {
            body = body.child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .when(desk.page > 1, |row| {
                        row.child(self.button(
                            "reviews-prev",
                            self.t(Key::InboxPrevious),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.page_review_requests(false, cx)),
                        ))
                    })
                    .child(div().text_sm().child(i18n::fill(
                        self.t(Key::InboxPage),
                        &[("n", &desk.page.to_string())],
                    )))
                    .when(desk.can_go_next(), |row| {
                        row.child(self.button(
                            "reviews-next",
                            self.t(Key::InboxNext),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.page_review_requests(true, cx)),
                        ))
                    }),
            );
        }
        self.modal_with_height(body, width, height, Some(cx))
    }

    fn render_review_visit(
        &self,
        visit: &ReviewVisit,
        desk: &Desk,
        browse: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let id = &visit.appointment_id;
        let time = visit.starts_at.with_timezone(&self.tz);
        let card = div()
            .flex()
            .flex_col()
            .gap_2()
            .p_3()
            .rounded_md()
            .border_1()
            .border_color(theme::line())
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(visit.client_name.clone()),
            )
            .child(div().text_sm().text_color(theme::muted()).child(format!(
                "{} · {}",
                i18n::date_label(self.locale, time.date_naive()),
                time.format("%H:%M")
            )))
            .when_some(visit.email_status, |card, status| {
                card.child(div().text_sm().child(self.t(status_key(status))))
            })
            .when(desk.copied.as_ref() == Some(id), |card| {
                card.child(div().text_sm().child(self.t(Key::ReviewRequestCopied)))
            });
        if desk.confirm.as_ref() == Some(id) {
            let id = id.clone();
            return card
                .child(div().text_sm().child(i18n::fill(
                    self.t(Key::ReviewRequestConfirm),
                    &[("client", &visit.client_name)],
                )))
                .when(desk.busy, |card| {
                    card.child(div().text_sm().child(self.t(Key::ReviewRequestLoading)))
                })
                .when(!desk.busy, |card| {
                    card.child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_2()
                            .child(self.button(
                                "reviews-cancel-send",
                                self.t(Key::Cancel),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                            ))
                            .when(self.status.connectivity != Connectivity::Offline, |row| {
                                row.child(
                                    self.button(
                                        "reviews-confirm-send",
                                        self.t(Key::ReviewRequestEmail),
                                        Kind::Primary,
                                        cx.listener(move |root, _, _, cx| {
                                            root.run_review_action(
                                                Action::SendEmail(id.clone()),
                                                cx,
                                            )
                                        }),
                                    )
                                    .debug_selector(|| "reviews-confirm-send".into()),
                                )
                            }),
                    )
                });
        }
        card.child(
            div()
                .flex()
                .flex_wrap()
                .gap_2()
                .when(browse && visit.link.is_some(), |row| {
                    let id = id.clone();
                    row.child(self.button(
                        SharedString::from(format!("review-copy-{id}")),
                        self.t(Key::ReviewRequestCopy),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| root.copy_review_link(&id, cx)),
                    ))
                })
                .when(
                    browse && visit.can_email && visit.email_status.is_none(),
                    |row| {
                        let id = id.clone();
                        let selector = format!("review-email-{id}");
                        row.child(
                            self.button(
                                SharedString::from(selector.clone()),
                                self.t(Key::ReviewRequestEmail),
                                Kind::Ghost,
                                cx.listener(move |root, _, _, cx| {
                                    if let Overlay::Reviews(desk) = &mut root.overlay
                                        && !desk.busy
                                        && desk.allows_email(&id)
                                    {
                                        desk.confirm = Some(id.clone());
                                        desk.error = None;
                                        cx.notify();
                                    }
                                }),
                            )
                            .debug_selector(move || selector.clone()),
                        )
                    },
                ),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn eligible_review_rows_require_confirmation_and_escape_returns_to_the_list(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = super::super::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(590.), px(420.)));
        let visit = "0198f5a0-7b1c-7000-8000-000000000001";
        let action = "review-email-0198f5a0-7b1c-7000-8000-000000000001";
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            root.open_review_requests(cx);
            root.status.connectivity = Connectivity::Online;
            let Overlay::Reviews(desk) = &mut root.overlay else {
                panic!("missing review requests");
            };
            desk.busy = false;
            desk.visits = Some(
                serde_json::from_value(serde_json::json!({
                    "visits": [{
                        "appointmentId": visit,
                        "startsAt": "2026-03-01T10:00:00Z",
                        "clientName": "Review fixture",
                        "link": "https://example.test/account/reviews",
                        "canEmail": true
                    }],
                    "hasMore": false,
                    "emailEnabled": true
                }))
                .unwrap(),
            );
            cx.notify();
        });
        cx.run_until_parked();
        let row = cx.debug_bounds(action).unwrap();
        assert!(cx.debug_bounds("reviews-confirm-send").is_none());
        cx.simulate_click(row.center(), Default::default());
        cx.run_until_parked();
        assert!(cx.debug_bounds("reviews-confirm-send").is_some());
        cx.simulate_keystrokes("escape");
        cx.run_until_parked();
        assert!(cx.debug_bounds("reviews-confirm-send").is_none());
        assert!(cx.debug_bounds(action).is_some());
    }
}
