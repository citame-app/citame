use super::*;
use sob_core::loyalty::stamps::bulk::{Request, Result as Receipt, Review, Scope};

pub(super) struct Desk {
    identity: Arc<()>,
    scope: Scope,
    review: Option<Review>,
    reason: Entity<TextField>,
    packet: Option<Request>,
    receipt: Option<Receipt>,
    busy: bool,
    feedback: Option<Key>,
    retry_at: Option<Instant>,
    confirm_exit: bool,
}

enum Job {
    Review(Scope),
    Apply(Box<Request>),
}

enum Response {
    Reviewed(Review),
    Applied(Receipt),
}

fn scope_label(scope: Scope) -> Key {
    match scope {
        Scope::Expired => Key::StampBulkExpiredOnly,
        Scope::Completed => Key::StampBulkCompletedOnly,
        Scope::All => Key::StampBulkAll,
    }
}

impl Desk {
    fn limited(&self) -> bool {
        self.retry_at
            .is_some_and(|deadline| Instant::now() < deadline)
    }

    fn switch_scope(&mut self, scope: Scope) {
        self.scope = scope;
        self.review = None;
        self.receipt = None;
        self.feedback = None;
    }
}

impl Root {
    fn stamp_bulk_desk(&mut self) -> Option<&mut Desk> {
        self.loyalty_desk()?.stamp_bulk.as_mut()
    }

    pub(super) fn open_stamp_bulk(&mut self, cx: &mut Context<Self>) {
        if !self.can_configure_points() {
            return;
        }
        let label = self.t(Key::StampBulkReason);
        let Some(loyalty) = self
            .loyalty_desk()
            .filter(|desk| !desk.saving && desk.adjustment.is_none())
        else {
            return;
        };
        loyalty.stamp_bulk = Some(Desk {
            identity: Arc::new(()),
            scope: Scope::Expired,
            review: None,
            reason: cx.new(|cx| TextField::new(label, false, cx)),
            packet: None,
            receipt: None,
            busy: false,
            feedback: None,
            retry_at: None,
            confirm_exit: false,
        });
        cx.notify();
    }

    pub(super) fn refresh_stamp_bulk(&mut self, cx: &mut Context<Self>) {
        if !self.can_configure_points() {
            self.overlay = Overlay::None;
            cx.notify();
        } else if let Some(desk) = self.stamp_bulk_desk()
            && !desk.limited()
            && desk.retry_at.take().is_some()
        {
            cx.notify();
        }
    }

    pub(super) fn close_stamp_bulk(&mut self, confirm: bool, cx: &mut Context<Self>) {
        let Some(desk) = self.stamp_bulk_desk().filter(|desk| !desk.busy) else {
            return;
        };
        let dirty = desk.packet.is_some() || !desk.reason.read(cx).text().trim().is_empty();
        if desk.confirm_exit && !confirm {
            desk.confirm_exit = false;
        } else if !desk.confirm_exit && dirty {
            desk.confirm_exit = true;
        } else if let Some(loyalty) = self.loyalty_desk() {
            loyalty.stamp_bulk = None;
        }
        cx.notify();
    }

    fn change_stamp_bulk_scope(&mut self, scope: Scope, cx: &mut Context<Self>) {
        if let Some(desk) = self
            .stamp_bulk_desk()
            .filter(|desk| !desk.busy && desk.packet.is_none())
        {
            desk.switch_scope(scope);
            cx.notify();
        }
    }

    fn review_stamp_bulk(&mut self, cx: &mut Context<Self>) {
        if let Some(desk) = self.stamp_bulk_desk().filter(|desk| desk.packet.is_none()) {
            let scope = desk.scope;
            self.send_stamp_bulk(Job::Review(scope), cx);
        }
    }

    fn confirm_stamp_bulk(&mut self, cx: &mut Context<Self>) {
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        let known_generation = self.svc.store.verified_reviewed_generation().ok();
        let Some(desk) = self
            .stamp_bulk_desk()
            .filter(|desk| !desk.busy && !desk.limited())
        else {
            return;
        };
        let Some(review) = desk.review.as_ref() else {
            return;
        };
        if known_generation.is_some_and(|generation| generation != review.generation) {
            desk.packet = None;
            desk.review = None;
            desk.feedback = Some(Key::StampBulkChanged);
            cx.notify();
            return;
        }
        let packet = desk
            .packet
            .clone()
            .or_else(|| review.prepare(desk.reason.read(cx).text()));
        let Some(packet) = packet else {
            desk.feedback = Some(Key::StampBulkInvalidReason);
            cx.notify();
            return;
        };
        desk.packet = Some(packet.clone());
        self.send_stamp_bulk(Job::Apply(Box::new(packet)), cx);
    }

    fn send_stamp_bulk(&mut self, job: Job, cx: &mut Context<Self>) {
        let Some(transport) = self.svc.transport().filter(|_| {
            self.can_configure_points() && self.status.connectivity == Connectivity::Online
        }) else {
            return;
        };
        let session = self.svc.session.clone();
        let Some(desk) = self
            .stamp_bulk_desk()
            .filter(|desk| !desk.busy && !desk.limited())
        else {
            return;
        };
        desk.busy = true;
        desk.feedback = None;
        desk.receipt = None;
        let identity = desk.identity.clone();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match job {
                        Job::Review(scope) => {
                            transport.review_stamp_batch(scope).map(Response::Reviewed)
                        }
                        Job::Apply(packet) => {
                            transport.void_stamp_batch(&packet).map(Response::Applied)
                        }
                    }
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || !root.can_configure_points() {
                    return;
                }
                let Some(desk) = root
                    .stamp_bulk_desk()
                    .filter(|desk| Arc::ptr_eq(&identity, &desk.identity))
                else {
                    return;
                };
                desk.busy = false;
                match result {
                    Ok(Response::Reviewed(review)) => desk.review = Some(review),
                    Ok(Response::Applied(receipt)) => {
                        desk.review = None;
                        desk.packet = None;
                        desk.receipt = Some(receipt);
                        desk.reason.update(cx, |field, cx| field.clear(cx));
                    }
                    Err(
                        TransportError::ReplicaGenerationChanged | TransportError::BadRequest(_),
                    ) if desk.packet.is_some() => {
                        desk.review = None;
                        desk.packet = None;
                        desk.feedback = Some(Key::StampBulkChanged);
                    }
                    Err(TransportError::Forbidden(_) | TransportError::Unauthorized) => {
                        desk.review = None;
                        desk.packet = None;
                        desk.feedback = Some(Key::StampBulkUnavailable);
                    }
                    Err(error) => {
                        if let TransportError::RateLimited(wait) = error {
                            desk.retry_at = Instant::now().checked_add(
                                wait.unwrap_or(Duration::from_secs(10))
                                    .max(Duration::from_secs(1)),
                            );
                        }
                        desk.feedback = Some(if desk.packet.is_some() {
                            Key::StampBulkUnconfirmed
                        } else {
                            Key::StampBulkUnavailable
                        });
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_stamp_bulk(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let ready = online && !desk.busy && !desk.limited() && self.can_configure_points();
        let body = div()
            .flex()
            .flex_col()
            .gap_3()
            .when(!online, |body| body.child(self.t(Key::StampOffline)))
            .when(desk.busy, |body| body.child(self.t(Key::InboxLoading)))
            .when_some(desk.feedback, |body, feedback| body.child(self.t(feedback)))
            .when_some(desk.receipt.as_ref(), |body, receipt| {
                body.child(format!(
                    "{} · {}",
                    self.t(Key::StampBulkSaved),
                    receipt.total
                ))
            });
        let body = if !self.can_configure_points() {
            body.child(self.t(Key::StampBulkUnavailable))
        } else if desk.confirm_exit {
            body.child(self.t(if desk.packet.is_some() {
                Key::StampBulkUnconfirmed
            } else {
                Key::LoyaltyProgrammeDiscard
            }))
            .child(self.loyalty_button(
                "stamp-bulk-stay",
                Key::Back,
                Kind::Ghost,
                |root, cx| root.close_stamp_bulk(false, cx),
                cx,
            ))
        } else if let Some(review) = &desk.review {
            self.render_stamp_bulk_review(body, desk, review, ready, cx)
        } else {
            let choices = [Scope::Expired, Scope::Completed, Scope::All]
                .into_iter()
                .map(|scope| {
                    self.chip(
                        SharedString::from(format!("stamp-bulk-scope-{}", scope.as_str())),
                        self.t(scope_label(scope)),
                        scope == desk.scope,
                        cx.listener(move |root, _, _, cx| root.change_stamp_bulk_scope(scope, cx)),
                    )
                    .tab_index(0)
                    .focus(|style| style.border_color(theme::text()))
                })
                .collect::<Vec<_>>();
            body.child(self.label(Key::StampBulkScope))
                .child(div().flex().flex_wrap().gap_2().children(choices))
                .when(ready, |body| {
                    body.child(
                        self.loyalty_button(
                            "stamp-bulk-review",
                            Key::StampBulkReview,
                            Kind::Primary,
                            Root::review_stamp_bulk,
                            cx,
                        )
                        .debug_selector(|| "stamp-bulk-review".to_owned()),
                    )
                })
        };
        self.modal_with_height(
            div()
                .tab_group()
                .child(self.label(Key::StampBulkTitle))
                .child(
                    div()
                        .id("stamp-bulk-scroll")
                        .min_h_0()
                        .overflow_y_scroll()
                        .child(body),
                )
                .when(!desk.busy, |panel| {
                    panel.child(self.loyalty_button(
                        "stamp-bulk-close",
                        if desk.confirm_exit {
                            Key::LoyaltyProgrammeDrop
                        } else {
                            Key::Close
                        },
                        Kind::Ghost,
                        |root, cx| root.close_stamp_bulk(true, cx),
                        cx,
                    ))
                }),
            (viewport.width - px(24.)).clamp(px(0.), px(580.)),
            (viewport.height - px(24.)).clamp(px(0.), px(720.)),
            None,
        )
    }

    fn render_stamp_bulk_review(
        &self,
        body: gpui::Div,
        desk: &Desk,
        review: &Review,
        ready: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let counts = &review.counts;
        body.child(self.label(scope_label(review.scope)))
            .when(review.total == 0, |body| {
                body.child(self.t(Key::StampBulkEmpty))
            })
            .when(review.total > 0, |body| {
                body.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .p_3()
                        .rounded_lg()
                        .border_1()
                        .border_color(theme::line())
                        .children(
                            [
                                (Key::StampBulkTotal, review.total),
                                (Key::StampBulkActive, counts.active),
                                (Key::StampCompleted, counts.completed),
                                (Key::StampBulkIssued, counts.issued),
                                (Key::StampBulkExpiredOnly, counts.expired),
                            ]
                            .into_iter()
                            .map(|(key, count)| {
                                div()
                                    .flex()
                                    .justify_between()
                                    .gap_2()
                                    .child(self.t(key))
                                    .child(count.to_string())
                            }),
                        ),
                )
                .child(
                    div()
                        .text_color(theme::conflict_fg())
                        .child(self.t(Key::StampBulkWarning)),
                )
                .when(desk.packet.is_none(), |body| {
                    body.child(self.label(Key::StampBulkReason))
                        .child(desk.reason.clone())
                })
                .when_some(desk.packet.as_ref(), |body, packet| {
                    body.child(packet.reason.clone())
                })
                .when(ready, |body| {
                    body.child(
                        self.loyalty_button(
                            "stamp-bulk-confirm",
                            if desk.packet.is_some() {
                                Key::MarketingRetry
                            } else {
                                Key::StampBulkConfirm
                            },
                            Kind::Danger,
                            Root::confirm_stamp_bulk,
                            cx,
                        )
                        .debug_selector(|| "stamp-bulk-confirm".to_owned()),
                    )
                })
            })
            .when(!desk.busy && desk.packet.is_none(), |body| {
                body.child(self.loyalty_button(
                    "stamp-bulk-change",
                    Key::StampBulkChangeScope,
                    Kind::Ghost,
                    move |root, cx| {
                        if let Some(desk) = root.stamp_bulk_desk() {
                            let scope = desk.scope;
                            root.change_stamp_bulk_scope(scope, cx);
                        }
                    },
                    cx,
                ))
            })
    }
}
