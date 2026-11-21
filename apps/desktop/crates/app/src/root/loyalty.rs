use super::*;
use sob_core::loyalty::{Adjustment, LIVE_TOPIC, Statement};
use sob_core::sync::TransportError;
use std::time::{Duration, Instant};
use uuid::Uuid;

mod policy;

pub(super) struct Pending {
    session: sob_core::auth::SessionHandle,
    adjustment: Adjustment,
    in_flight: bool,
}

pub(super) struct Desk {
    identity: Arc<()>,
    from_marketing: bool,
    search: Entity<TextField>,
    results: Vec<(Uuid, String)>,
    selected: Option<(Uuid, String)>,
    statement: Option<Statement>,
    request: Option<Arc<()>>,
    loading: bool,
    refresh_at: Instant,
    observed: Option<i64>,
    policy: Option<policy::Editor>,
    retry: Option<(Instant, Duration)>,
    points: Entity<TextField>,
    reason: Entity<TextField>,
    adjustment: Option<Adjustment>,
    saving: bool,
    uncertain: bool,
    confirm_exit: bool,
    receipt_opening: bool,
    error: Option<Key>,
    saved: bool,
}

impl Desk {
    fn rate_limited(&self) -> bool {
        self.retry
            .is_some_and(|(began, delay)| began.elapsed() < delay)
    }

    fn delay_retry(&mut self, error: &TransportError) {
        if let TransportError::RateLimited(delay) = error {
            self.retry = Some((
                Instant::now(),
                delay
                    .unwrap_or(Duration::from_secs(10))
                    .max(Duration::from_secs(1)),
            ));
        }
    }

    fn can_review(&self) -> bool {
        self.statement
            .as_ref()
            .is_some_and(|statement| statement.can_adjust)
    }
}

fn movement_label(kind: &str) -> Key {
    match kind {
        "earn" => Key::LoyaltyEarned,
        "adjustment" => Key::LoyaltyAdjusted,
        "redemption" => Key::LoyaltyRedeemed,
        "redemption_return" => Key::LoyaltyReturned,
        "refund_adjustment" => Key::LoyaltyRefund,
        "expiry" => Key::LoyaltyExpired,
        _ => Key::LoyaltyMovement,
    }
}

impl Root {
    pub(super) fn open_loyalty(&mut self, cx: &mut Context<Self>) {
        if !self.directory_enabled() {
            return;
        }
        let from_marketing = matches!(self.overlay, Overlay::Marketing(_));
        let label = self.t(Key::LoyaltySearch);
        let search = cx.new(|cx| TextField::new(label, false, cx));
        cx.subscribe(&search, |root, _, event, cx| {
            if matches!(event, FieldEvent::Submit) {
                root.search_loyalty_clients(cx);
            }
        })
        .detach();
        self.overlay = Overlay::Loyalty(Box::new(Desk {
            identity: Arc::new(()),
            from_marketing,
            search,
            results: Vec::new(),
            selected: None,
            statement: None,
            request: None,
            loading: false,
            refresh_at: Instant::now(),
            observed: None,
            policy: None,
            retry: None,
            points: cx.new(|cx| TextField::new("", false, cx)),
            reason: cx.new(|cx| TextField::new("", false, cx)),
            adjustment: None,
            saving: false,
            uncertain: false,
            confirm_exit: false,
            receipt_opening: false,
            error: None,
            saved: false,
        }));
        cx.notify();
    }

    fn pending_loyalty(&self) -> Option<&Pending> {
        self.pending_loyalty
            .as_ref()
            .filter(|pending| Arc::ptr_eq(&pending.session, &self.svc.session))
    }

    fn acknowledge_loyalty_statement(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self
            .pending_loyalty()
            .filter(|pending| !pending.in_flight)
            .map(|pending| pending.adjustment.client_id)
        else {
            return;
        };
        let Some(desk) = self.loyalty_desk().filter(|desk| {
            desk.statement.is_some()
                && desk
                    .selected
                    .as_ref()
                    .is_some_and(|(client, _)| *client == id)
        }) else {
            return;
        };
        desk.adjustment = None;
        desk.uncertain = false;
        desk.error = None;
        desk.points.update(cx, |field, cx| field.set_text("", cx));
        desk.reason.update(cx, |field, cx| field.set_text("", cx));
        self.pending_loyalty = None;
        cx.notify();
    }

    fn loyalty_desk(&mut self) -> Option<&mut Desk> {
        let Overlay::Loyalty(desk) = &mut self.overlay else {
            return None;
        };
        Some(desk)
    }

    fn search_loyalty_clients(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self.svc.transport().filter(|_| {
            self.status.connectivity == Connectivity::Online && self.directory_enabled()
        }) else {
            return;
        };
        let session = self.svc.session.clone();
        let Some(desk) = self
            .loyalty_desk()
            .filter(|desk| !desk.saving && desk.adjustment.is_none() && !desk.rate_limited())
        else {
            return;
        };
        let search = desk.search.read(cx).text().trim().to_owned();
        if search.encode_utf16().count() > 100 {
            desk.error = Some(Key::LoyaltySearchLimit);
            cx.notify();
            return;
        }
        desk.results.clear();
        desk.selected = None;
        desk.statement = None;
        desk.request = None;
        desk.loading = false;
        desk.error = None;
        desk.saved = false;
        if search.is_empty() {
            cx.notify();
            return;
        }
        let identity = desk.identity.clone();
        let request = Arc::new(());
        desk.request = Some(request.clone());
        desk.loading = true;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.find_loyalty_clients(&search) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session)
                    || root.svc.current_session().is_none()
                    || !root.directory_enabled()
                {
                    return;
                }
                let Some(desk) = root.loyalty_desk().filter(|desk| {
                    Arc::ptr_eq(&identity, &desk.identity)
                        && desk
                            .request
                            .as_ref()
                            .is_some_and(|current| Arc::ptr_eq(current, &request))
                }) else {
                    return;
                };
                desk.loading = false;
                desk.request = None;
                match result {
                    Ok(clients) => {
                        desk.results = clients
                            .into_iter()
                            .map(|client| {
                                let label = match client.email {
                                    Some(email) => format!("{} · {email}", client.name),
                                    None => client.name,
                                };
                                (client.id, label)
                            })
                            .collect()
                    }
                    Err(error) => {
                        desk.delay_retry(&error);
                        desk.error = Some(Key::LoyaltyLoadFailed);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn select_loyalty_client(&mut self, id: Uuid, cx: &mut Context<Self>) {
        let Some(desk) = self
            .loyalty_desk()
            .filter(|desk| !desk.saving && desk.adjustment.is_none())
        else {
            return;
        };
        let Some(client) = desk
            .results
            .iter()
            .find(|(current, _)| *current == id)
            .cloned()
        else {
            return;
        };
        desk.selected = Some(client);
        desk.statement = None;
        desk.points.update(cx, |field, cx| field.set_text("", cx));
        desk.reason.update(cx, |field, cx| field.set_text("", cx));
        desk.saved = false;
        desk.error = None;
        self.load_loyalty(1, false, cx);
    }

    pub(super) fn refresh_loyalty(&mut self, reconnected: bool, cx: &mut Context<Self>) {
        if !matches!(self.overlay, Overlay::Loyalty(_)) {
            return;
        }
        let observed = self.svc.store.live_view_revision(LIVE_TOPIC).ok();
        if self
            .loyalty_desk()
            .is_some_and(|desk| desk.policy.is_some())
        {
            self.refresh_points_policy(reconnected, observed, cx);
            return;
        }
        if !self.directory_enabled() {
            self.overlay = Overlay::None;
            cx.notify();
            return;
        }
        let Some(desk) = self.loyalty_desk() else {
            return;
        };
        if desk.rate_limited() {
            return;
        }
        if desk.retry.take().is_some() {
            cx.notify();
        }
        if desk.selected.is_none()
            || desk.request.is_some()
            || desk.saving
            || (!reconnected && desk.observed == observed && Instant::now() < desk.refresh_at)
        {
            return;
        }
        let page = desk
            .statement
            .as_ref()
            .map_or(1, |statement| statement.pagination.page);
        self.load_loyalty(page, true, cx);
    }

    fn load_loyalty(&mut self, page: u32, background: bool, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let session = self.svc.session.clone();
        let observed = self.svc.store.live_view_revision(LIVE_TOPIC).ok();
        let Some(desk) = self
            .loyalty_desk()
            .filter(|desk| !desk.saving && !desk.rate_limited())
        else {
            return;
        };
        let Some((client, _)) = desk.selected.as_ref() else {
            return;
        };
        let client = *client;
        let request = Arc::new(());
        let identity = desk.identity.clone();
        desk.request = Some(request.clone());
        desk.observed = observed;
        desk.loading = !background;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.loyalty_statement(client, page) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || root.svc.current_session().is_none()
                {
                    return;
                }
                let Some(desk) = root.loyalty_desk().filter(|desk| {
                    Arc::ptr_eq(&identity, &desk.identity)
                        && desk
                            .request
                            .as_ref()
                            .is_some_and(|current| Arc::ptr_eq(current, &request))
                }) else {
                    return;
                };
                desk.loading = false;
                desk.request = None;
                desk.refresh_at = Instant::now() + Duration::from_secs(10);
                if let Err(error) = &result {
                    desk.delay_retry(error);
                }
                match result {
                    Ok(statement) => {
                        if !statement.can_adjust && !desk.uncertain {
                            desk.adjustment = None;
                            desk.uncertain = false;
                            desk.confirm_exit = false;
                        }
                        desk.statement = Some(statement);
                        if desk.error == Some(Key::LoyaltyLoadFailed) {
                            desk.error = None;
                        }
                    }
                    Err(
                        TransportError::Forbidden(_)
                        | TransportError::Unauthorized
                        | TransportError::BadRequest(_),
                    ) => {
                        desk.statement = None;
                        desk.results.clear();
                        if !desk.uncertain {
                            desk.selected = None;
                            desk.adjustment = None;
                            desk.confirm_exit = false;
                        }
                        desk.error = Some(Key::LoyaltyLoadFailed);
                    }
                    Err(_) => {
                        if !background {
                            desk.statement = None;
                        }
                        if !desk.uncertain {
                            desk.error = Some(Key::LoyaltyLoadFailed);
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn review_loyalty_adjustment(&mut self, cx: &mut Context<Self>) {
        let previous = self
            .pending_loyalty()
            .map(|pending| (pending.adjustment.clone(), pending.in_flight));
        let generation = self.svc.store.verified_reviewed_generation().ok();
        let Some(desk) = self
            .loyalty_desk()
            .filter(|desk| !desk.saving && desk.adjustment.is_none())
        else {
            return;
        };
        let Some((client, _)) = &desk.selected else {
            return;
        };
        let Some(statement) = desk.statement.as_ref().filter(|s| s.can_adjust) else {
            return;
        };
        let Some(generation) = generation.filter(|g| statement.generation.as_ref() == Some(g))
        else {
            desk.error = Some(Key::LoyaltyRestore);
            cx.notify();
            return;
        };
        if let Some((previous, in_flight)) = previous {
            if !in_flight && previous.client_id == *client && previous.generation == generation {
                desk.adjustment = Some(previous);
                desk.uncertain = true;
                desk.error = Some(Key::LoyaltyUnconfirmed);
            } else {
                desk.error = Some(Key::LoyaltyPending);
            }
            cx.notify();
            return;
        }
        if !statement.policy.enabled {
            return;
        }
        desk.adjustment = Adjustment::prepare(
            *client,
            generation,
            desk.points.read(cx).text(),
            desk.reason.read(cx).text(),
        );
        desk.error = desk.adjustment.is_none().then_some(Key::LoyaltyInvalid);
        desk.saved = false;
        cx.notify();
    }

    fn confirm_loyalty_adjustment(&mut self, cx: &mut Context<Self>) {
        if self
            .pending_loyalty()
            .is_some_and(|pending| pending.in_flight)
        {
            return;
        }
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let generation = self.svc.store.verified_reviewed_generation().ok();
        let session = self.svc.session.clone();
        let Some(desk) = self.loyalty_desk().filter(|desk| {
            !desk.saving && !desk.confirm_exit && !desk.rate_limited() && desk.can_review()
        }) else {
            return;
        };
        let Some(adjustment) = desk.adjustment.clone() else {
            return;
        };
        if generation.as_ref() != Some(&adjustment.generation) {
            desk.adjustment = None;
            desk.uncertain = false;
            desk.error = Some(Key::LoyaltyRestore);
            cx.notify();
            return;
        }
        let identity = desk.identity.clone();
        desk.request = None;
        desk.loading = false;
        desk.saving = true;
        desk.error = None;
        let key = adjustment.idempotency_key;
        self.pending_loyalty = Some(Pending {
            session: session.clone(),
            adjustment: adjustment.clone(),
            in_flight: true,
        });
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.adjust_loyalty(&adjustment) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || root.svc.current_session().is_none()
                {
                    return;
                }
                if let Some(pending) = root
                    .pending_loyalty
                    .as_mut()
                    .filter(|pending| pending.adjustment.idempotency_key == key)
                {
                    pending.in_flight = false;
                    if result.is_ok() || matches!(&result, Err(TransportError::BadRequest(_))) {
                        root.pending_loyalty = None;
                    }
                }
                let Some(desk) = root
                    .loyalty_desk()
                    .filter(|desk| Arc::ptr_eq(&identity, &desk.identity))
                else {
                    return;
                };
                desk.saving = false;
                if let Err(error) = &result {
                    desk.delay_retry(error);
                }
                match result {
                    Ok(_) => {
                        desk.adjustment = None;
                        desk.uncertain = false;
                        desk.saved = true;
                        desk.points.update(cx, |field, cx| field.set_text("", cx));
                        desk.reason.update(cx, |field, cx| field.set_text("", cx));
                        root.load_loyalty(1, false, cx);
                    }
                    Err(
                        TransportError::Offline(_)
                        | TransportError::Server(_)
                        | TransportError::Unauthorized
                        | TransportError::RateLimited(_),
                    ) => {
                        desk.uncertain = true;
                        desk.error = Some(Key::LoyaltyUnconfirmed);
                    }
                    Err(error) => {
                        if !desk.uncertain
                            || matches!(
                                error,
                                TransportError::ReplicaGenerationChanged
                                    | TransportError::BadRequest(_)
                            )
                        {
                            desk.adjustment = None;
                            desk.uncertain = false;
                            desk.points.update(cx, |field, cx| field.set_text("", cx));
                            desk.reason.update(cx, |field, cx| field.set_text("", cx));
                        }
                        desk.error = Some(
                            if matches!(error, TransportError::ReplicaGenerationChanged) {
                                Key::LoyaltyRestore
                            } else {
                                Key::LoyaltyRejected
                            },
                        );
                        if matches!(error, TransportError::Forbidden(_)) {
                            desk.statement = None;
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn open_loyalty_receipt(&mut self, id: Uuid, cx: &mut Context<Self>) {
        let Some(session) = self
            .svc
            .current_session()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let handle = self.svc.session.clone();
        let auth = self.svc.auth.clone();
        let Some(desk) = self.loyalty_desk().filter(|desk| {
            !desk.receipt_opening && desk.adjustment.is_none() && !desk.rate_limited()
        }) else {
            return;
        };
        if !desk.statement.as_ref().is_some_and(|statement| {
            statement
                .movements
                .iter()
                .any(|movement| movement.checkout_id == Some(id))
        }) {
            return;
        }
        let identity = desk.identity.clone();
        let client = desk.selected.as_ref().map(|(id, _)| *id);
        desk.receipt_opening = true;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let handoff = cx
                .background_executor()
                .spawn(async move { auth.begin_browser_receipt(&session, id).ok().flatten() })
                .await;
            let opened = root
                .update(cx, |root, cx| {
                    if !Arc::ptr_eq(&handle, &root.svc.session)
                        || root.svc.current_session().is_none()
                    {
                        return false;
                    }
                    let Some(desk) = root
                        .loyalty_desk()
                        .filter(|desk| Arc::ptr_eq(&identity, &desk.identity))
                    else {
                        return false;
                    };
                    desk.receipt_opening = false;
                    if desk.selected.as_ref().map(|(id, _)| *id) != client
                        || !desk.statement.as_ref().is_some_and(|statement| {
                            statement
                                .movements
                                .iter()
                                .any(|movement| movement.checkout_id == Some(id))
                        })
                    {
                        cx.notify();
                        return false;
                    }
                    let Some(handoff) = &handoff else {
                        desk.error = Some(Key::CheckoutCloudOpenFailed);
                        cx.notify();
                        return false;
                    };
                    cx.open_url(&handoff.url());
                    cx.notify();
                    true
                })
                .unwrap_or(false);
            if opened && let Some(handoff) = handoff {
                cx.background_executor()
                    .spawn(async move { handoff.serve() })
                    .await;
            }
        })
        .detach();
    }

    pub(super) fn dismiss_loyalty(&mut self, confirm: bool, cx: &mut Context<Self>) {
        if self
            .loyalty_desk()
            .is_some_and(|desk| desk.policy.is_some())
        {
            self.close_points_policy(confirm, cx);
            return;
        }
        let Some(desk) = self.loyalty_desk() else {
            return;
        };
        if desk.saving {
            return;
        }
        if desk.uncertain {
            if !desk.confirm_exit || !confirm {
                desk.confirm_exit = !desk.confirm_exit;
                cx.notify();
                return;
            }
        } else if desk.adjustment.take().is_some() {
            cx.notify();
            return;
        }
        if desk.from_marketing {
            self.open_marketing(cx);
        } else {
            self.open_web_management(cx);
        }
    }

    fn loyalty_button(
        &self,
        id: impl Into<ElementId>,
        key: Key,
        kind: Kind,
        action: impl Fn(&mut Root, &mut Context<Root>) + 'static,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        self.button(
            id,
            self.t(key),
            kind,
            cx.listener(move |root, _, _, cx| action(root, cx)),
        )
        .tab_index(0)
        .focus(|style| style.border_color(theme::text()))
    }

    pub(super) fn render_loyalty(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        if let Some(editor) = &desk.policy {
            return self.render_points_policy(editor, viewport, cx);
        }
        let online = self.status.connectivity == Connectivity::Online;
        let ready = online && !desk.loading && !desk.saving && !desk.rate_limited();
        let mut body = div()
            .flex()
            .flex_col()
            .gap_3()
            .when(
                self.pending_loyalty().is_some() && desk.adjustment.is_none(),
                |body| body.child(self.t(Key::LoyaltyPending)),
            )
            .when(!online, |body| body.child(self.t(Key::LoyaltyOffline)))
            .when(desk.loading || desk.saving, |body| {
                body.child(self.t(Key::MarketingLoading))
            })
            .when(desk.saved, |body| body.child(self.t(Key::LoyaltySaved)))
            .when_some(desk.error, |body, error| {
                body.child(div().text_color(theme::conflict_fg()).child(self.t(error)))
            });
        if desk.confirm_exit {
            body = body
                .child(self.t(Key::LoyaltyExitReview))
                .child(self.loyalty_button(
                    "keep-loyalty",
                    Key::Back,
                    Kind::Ghost,
                    |root, cx| root.dismiss_loyalty(false, cx),
                    cx,
                ));
        } else if desk.adjustment.is_some() && !desk.can_review() {
            body = body.child(self.t(Key::LoyaltyExitReview));
        } else if let Some(adjustment) = &desk.adjustment {
            body = body
                .child(self.label(Key::LoyaltyReview))
                .when_some(desk.selected.as_ref(), |body, (_, name)| {
                    body.child(name.clone())
                })
                .child(format!("{:+} · {}", adjustment.points, adjustment.reason))
                .when(ready, |body| {
                    body.child(self.loyalty_button(
                        "confirm-loyalty-adjustment",
                        if desk.uncertain {
                            Key::MarketingRetry
                        } else {
                            Key::LoyaltyRecord
                        },
                        Kind::Primary,
                        Root::confirm_loyalty_adjustment,
                        cx,
                    ))
                });
        } else {
            body = body
                .when(self.can_configure_points() && ready, |body| {
                    body.child(self.loyalty_button(
                        "loyalty-policy",
                        Key::LoyaltyProgramme,
                        Kind::Ghost,
                        Root::open_points_policy,
                        cx,
                    ))
                })
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .child(desk.search.clone())
                        .when(online, |row| {
                            row.child(self.loyalty_button(
                                "search-loyalty",
                                Key::LoyaltyFind,
                                Kind::Ghost,
                                Root::search_loyalty_clients,
                                cx,
                            ))
                        }),
                )
                .when(online, |body| {
                    body.children(desk.results.iter().map(|(id, label)| {
                        let id = *id;
                        self.chip(
                            SharedString::from(format!("loyalty-client-{id}")),
                            label.clone(),
                            desk.selected
                                .as_ref()
                                .is_some_and(|(selected, _)| *selected == id),
                            cx.listener(move |root, _, _, cx| root.select_loyalty_client(id, cx)),
                        )
                        .tab_index(0)
                        .focus(|style| style.border_color(theme::text()))
                    }))
                })
                .when_some(desk.selected.as_ref(), |body, (_, name)| {
                    body.child(div().font_weight(FontWeight::SEMIBOLD).child(name.clone()))
                })
                .when(
                    desk.selected.is_some() && desk.statement.is_none() && ready,
                    |body| {
                        body.child(self.loyalty_button(
                            "refresh-loyalty",
                            Key::InboxRefresh,
                            Kind::Ghost,
                            |root, cx| root.load_loyalty(1, false, cx),
                            cx,
                        ))
                    },
                )
                .when_some(desk.statement.as_ref(), |body, statement| {
                    body.child(self.render_loyalty_statement(desk, statement, ready, cx))
                });
        }
        let close = if desk.confirm_exit {
            Key::LoyaltyLeave
        } else if desk.adjustment.is_some() {
            Key::Back
        } else {
            Key::Close
        };
        self.modal_with_height(
            div()
                .tab_group()
                .child(self.label(Key::LoyaltyTitle))
                .child(
                    div()
                        .id("loyalty-body")
                        .min_h_0()
                        .overflow_y_scroll()
                        .child(body),
                )
                .when(!desk.saving, |panel| {
                    panel.child(self.loyalty_button(
                        "close-loyalty",
                        close,
                        Kind::Ghost,
                        |root, cx| root.dismiss_loyalty(true, cx),
                        cx,
                    ))
                }),
            (viewport.width - px(24.)).clamp(px(0.), px(820.)),
            (viewport.height - px(24.)).clamp(px(0.), px(760.)),
            None,
        )
    }

    fn render_loyalty_statement(
        &self,
        desk: &Desk,
        statement: &Statement,
        ready: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let policy = &statement.policy;
        let money = |cents| i18n::amount_label(self.locale, i64::from(cents), "EUR");
        let page = statement.pagination.page;
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(if policy.enabled {
                i18n::fill(
                    self.t(Key::LoyaltyTerms),
                    &[
                        ("points", &policy.points_per_step.to_string()),
                        ("spend", &money(policy.earn_every_cents)),
                        ("value", &money(policy.redeem_value_cents)),
                        (
                            "maximum",
                            &sob_core::reports::decimal_amount(u64::from(
                                policy.maximum_discount_basis_points,
                            )),
                        ),
                    ],
                )
            } else {
                self.t(Key::LoyaltyDisabled).into()
            })
            .when_some(
                policy.expiry_days.filter(|_| policy.enabled),
                |body, days| {
                    body.child(i18n::fill(
                        self.t(Key::LoyaltyExpiry),
                        &[("days", &days.to_string())],
                    ))
                },
            )
            .child(
                div().flex().flex_wrap().gap_2().children(
                    [
                        (Key::LoyaltyAvailable, statement.available_points),
                        (Key::LoyaltyReserved, statement.reserved_points),
                        (Key::LoyaltyDebt, statement.debt_points),
                        (Key::LoyaltyExpiring, statement.expiring_points),
                    ]
                    .into_iter()
                    .map(|(key, value)| {
                        div()
                            .p_2()
                            .rounded_md()
                            .border_1()
                            .border_color(theme::line())
                            .child(self.label(key))
                            .child(div().text_lg().child(value.to_string()))
                    }),
                ),
            )
            .when_some(
                self.pending_loyalty().filter(|pending| {
                    desk.selected
                        .as_ref()
                        .is_some_and(|(client, _)| *client == pending.adjustment.client_id)
                        && !pending.in_flight
                }),
                |body, pending| {
                    body.child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_2()
                            .when(
                                ready
                                    && statement.can_adjust
                                    && statement.generation.as_ref()
                                        == Some(&pending.adjustment.generation),
                                |row| {
                                    row.child(self.loyalty_button(
                                        "resume-loyalty-adjustment",
                                        Key::LoyaltyReview,
                                        Kind::Primary,
                                        Root::review_loyalty_adjustment,
                                        cx,
                                    ))
                                },
                            )
                            .when(ready, |row| {
                                row.child(self.loyalty_button(
                                    "acknowledge-loyalty",
                                    Key::LoyaltyAcknowledge,
                                    Kind::Ghost,
                                    Root::acknowledge_loyalty_statement,
                                    cx,
                                ))
                            }),
                    )
                },
            )
            .when(
                statement.can_adjust && policy.enabled && self.pending_loyalty().is_none(),
                |body| {
                    body.child(self.label(Key::LoyaltyAdjustment))
                        .child(self.label(Key::LoyaltyPoints))
                        .child(desk.points.clone())
                        .child(self.label(Key::LoyaltyReason))
                        .child(desk.reason.clone())
                        .when(ready, |body| {
                            body.child(self.loyalty_button(
                                "review-loyalty-adjustment",
                                Key::LoyaltyReview,
                                Kind::Primary,
                                Root::review_loyalty_adjustment,
                                cx,
                            ))
                        })
                },
            )
            .child(self.label(Key::LoyaltyHistory))
            .when(statement.movements.is_empty(), |body| {
                body.child(self.t(Key::LoyaltyEmpty))
            })
            .children(statement.movements.iter().map(|movement| {
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_3()
                    .p_2()
                    .border_b_1()
                    .border_color(theme::line())
                    .child(self.t(movement_label(&movement.kind)))
                    .child(format!("{:+}", movement.points))
                    .child(self.date_time_label(movement.created_at))
                    .when_some(
                        movement
                            .checkout_id
                            .filter(|_| ready && !desk.receipt_opening),
                        |row, id| {
                            row.child(self.loyalty_button(
                                SharedString::from(format!("loyalty-receipt-{}", movement.id)),
                                Key::LoyaltyReceipt,
                                Kind::Ghost,
                                move |root, cx| root.open_loyalty_receipt(id, cx),
                                cx,
                            ))
                        },
                    )
            }))
            .when(ready, |body| {
                body.child(
                    div()
                        .flex()
                        .gap_2()
                        .when(page > 1, |row| {
                            row.child(self.loyalty_button(
                                "loyalty-prev",
                                Key::MarketingPreviousPage,
                                Kind::Ghost,
                                move |root, cx| root.load_loyalty(page - 1, false, cx),
                                cx,
                            ))
                        })
                        .when(statement.pagination.has_next(), |row| {
                            row.child(self.loyalty_button(
                                "loyalty-next",
                                Key::MarketingNextPage,
                                Kind::Ghost,
                                move |root, cx| root.load_loyalty(page + 1, false, cx),
                                cx,
                            ))
                        }),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[gpui::test]
    async fn loyalty_opens_from_marketing_without_an_existing_campaign(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_directory, config) = crate::root::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| {
            let mut root = Root::new(config, window, cx);
            root.svc.stop_sync();
            root.svc
                .store
                .set_meta("client_directory", "allowed")
                .unwrap();
            root.status.connectivity = Connectivity::Offline;
            root.open_marketing(cx);
            root.status.connectivity = Connectivity::Online;
            root
        });
        cx.simulate_resize(gpui::size(px(1100.), px(720.)));
        cx.run_until_parked();
        let link = cx.debug_bounds("marketing-loyalty").unwrap().center();
        cx.simulate_click(link, Default::default());
        cx.run_until_parked();
        root.update(cx, |root, cx| {
            assert!(root.loyalty_desk().is_some());
            let request = Adjustment::prepare(
                Uuid::now_v7(),
                "initial".into(),
                "25",
                "Synthetic reviewed adjustment",
            )
            .unwrap();
            let key = request.idempotency_key;
            root.pending_loyalty = Some(Pending {
                session: root.svc.session.clone(),
                adjustment: request,
                in_flight: false,
            });
            root.svc
                .store
                .set_meta("client_directory", "denied")
                .unwrap();
            root.refresh_loyalty(false, cx);
            assert!(root.loyalty_desk().is_none());
            assert_eq!(
                root.pending_loyalty().unwrap().adjustment.idempotency_key,
                key
            );
            assert!(root.svc.store.outbox(5).unwrap().is_empty());
        });
    }
}
