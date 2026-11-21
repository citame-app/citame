use super::*;
use sob_core::loyalty::stamps::{Appearance, Card, Cards, State};

mod commands;
use commands::{Form, Operation, can_issue};

#[derive(Default)]
pub(super) struct CardList {
    pub(super) visible: bool,
    cards: Option<Cards>,
    form: Option<Form>,
    saved: bool,
}

impl Root {
    pub(super) fn show_stamp_cards(&mut self, cx: &mut Context<Self>) {
        let Some(desk) = self.loyalty_desk().filter(|desk| desk.selected.is_some()) else {
            return;
        };
        desk.stamps.visible = true;
        desk.error = None;
        self.load_stamp_cards(false, cx);
        cx.notify();
    }

    pub(super) fn hide_stamp_cards(&mut self, cx: &mut Context<Self>) {
        if self.cancel_stamp_operation(cx) {
            return;
        }
        let Some(desk) = self.loyalty_desk() else {
            return;
        };
        desk.stamps = CardList::default();
        desk.request = None;
        desk.error = None;
        let page = desk
            .statement
            .as_ref()
            .map_or(1, |statement| statement.pagination.page);
        self.load_loyalty(page, false, cx);
        cx.notify();
    }

    pub(super) fn load_stamp_cards(&mut self, background: bool, cx: &mut Context<Self>) {
        let Some(transport) = self.svc.transport().filter(|_| {
            self.status.connectivity == Connectivity::Online && self.directory_enabled()
        }) else {
            return;
        };
        let observed = self.svc.store.live_view_revision(LIVE_TOPIC).ok();
        let session = self.svc.session.clone();
        let Some(desk) = self
            .loyalty_desk()
            .filter(|desk| desk.stamps.visible && !desk.rate_limited())
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
                .spawn(async move { transport.stamp_cards(client) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session)
                    || root.svc.current_session().is_none()
                    || !root.directory_enabled()
                {
                    return;
                }
                let Some(desk) = root.loyalty_desk().filter(|desk| {
                    desk.stamps.visible
                        && Arc::ptr_eq(&identity, &desk.identity)
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
                match result {
                    Ok(cards) => {
                        desk.stamps.cards = Some(cards);
                        if desk.error == Some(Key::StampLoadFailed) {
                            desk.error = None;
                        }
                    }
                    Err(error) => {
                        desk.delay_retry(&error);
                        if !background
                            || matches!(
                                error,
                                TransportError::Unauthorized
                                    | TransportError::Forbidden(_)
                                    | TransportError::BadRequest(_)
                                    | TransportError::ReplicaGenerationChanged
                            )
                        {
                            desk.stamps.cards = None;
                        }
                        desk.error = Some(Key::StampLoadFailed);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_stamp_cards(
        &self,
        desk: &Desk,
        ready: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let list = desk.stamps.cards.as_ref();
        let can_act = ready && desk.request.is_none() && list.is_some_and(|list| list.can_edit);
        let body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .child(self.label(Key::StampCards))
                    .child(self.loyalty_button(
                        "stamp-cards-back",
                        Key::Back,
                        Kind::Ghost,
                        Root::hide_stamp_cards,
                        cx,
                    )),
            )
            .when_some(desk.selected.as_ref(), |body, (_, name)| {
                body.child(div().font_weight(FontWeight::SEMIBOLD).child(name.clone()))
            })
            .when(desk.stamps.saved, |body| {
                body.child(self.t(Key::StampSaved))
            });
        if let Some(form) = &desk.stamps.form {
            return body.child(self.render_stamp_command(form, desk, ready, cx));
        }
        body.when(ready && desk.request.is_none(), |body| {
            body.child(self.loyalty_button(
                "stamp-cards-refresh",
                Key::InboxRefresh,
                Kind::Ghost,
                |root, cx| root.load_stamp_cards(false, cx),
                cx,
            ))
        })
        .when_some(list, |body, list| {
            body.when(can_act && can_issue(list), |body| {
                body.child(self.loyalty_button(
                    "stamp-issue",
                    Key::StampIssue,
                    Kind::Primary,
                    |root, cx| root.select_stamp_operation(Operation::Issue, None, cx),
                    cx,
                ))
            })
            .when(list.cards.is_empty(), |body| {
                body.child(self.t(Key::StampEmpty))
            })
            .children(
                list.cards
                    .iter()
                    .map(|card| self.render_stamp_card(card, can_act, cx))
                    .collect::<Vec<_>>(),
            )
        })
    }

    fn render_stamp_card(
        &self,
        card: &Card,
        can_act: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        let id = card.id;
        let (surface, edge) = match card.program.appearance {
            Appearance::Neutral => (theme::panel(), theme::line()),
            Appearance::Rose => (theme::accent_soft(), theme::accent()),
            Appearance::Mint => theme::service_color(Some("#3b9c78"), "mint"),
        };
        let state = match card.state {
            State::Active => Key::StampActive,
            State::Queued => Key::StampQueued,
            State::Completed => Key::StampCompleted,
            State::Issued => Key::StampIssued,
            State::Redeemed => Key::StampRedeemed,
            State::Expired => Key::StampExpired,
            State::Void => Key::StampVoid,
        };
        let expiry = if card.completed_at.is_some() {
            card.reward_expires_at
        } else {
            card.stamp_expires_at
        };
        let goal = card.program.goal.clamp(1, 15);
        let progress = self
            .t(Key::StampProgress)
            .replace("{stamps}", &card.stamps.to_string())
            .replace("{goal}", &goal.to_string());
        div()
            .id(SharedString::from(format!("stamp-card-{}", card.id)))
            .flex()
            .flex_col()
            .gap_2()
            .bg(surface)
            .border_1()
            .border_color(edge)
            .rounded_lg()
            .p_3()
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(card.program.name.clone()),
            )
            .child(format!("{} · {progress}", self.t(state)))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_1()
                    .children((1..=goal).map(|position| {
                        let earned = position <= card.stamps;
                        div()
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(28.))
                            .rounded_full()
                            .border_1()
                            .border_color(edge)
                            .when(earned, |stamp| {
                                stamp.bg(theme::accent()).text_color(theme::on_accent())
                            })
                            .child(if earned {
                                "✓".to_owned()
                            } else {
                                position.to_string()
                            })
                    })),
            )
            .child(card.program.reward.name.clone())
            .when_some(
                card.program.reward.discount_basis_points,
                |body, discount| {
                    body.child(self.t(Key::StampDiscount).replace(
                        "{discount}",
                        &sob_core::reports::decimal_amount(u64::from(discount)),
                    ))
                },
            )
            .when_some(expiry, |body, expiry| {
                let day = (expiry - chrono::Duration::milliseconds(1))
                    .with_timezone(&self.tz)
                    .format("%d/%m/%Y");
                body.child(self.t(Key::StampExpiry).replace("{date}", &day.to_string()))
            })
            .when(!card.program.terms.is_empty(), |body| {
                body.child(card.program.terms.clone())
            })
            .when(can_act, |body| {
                let buttons = [
                    Operation::IssueReward,
                    Operation::Redeem,
                    Operation::Edit,
                    Operation::Void,
                ]
                .into_iter()
                .filter(|operation| operation.can_apply(card))
                .enumerate()
                .map(|(index, operation)| {
                    self.loyalty_button(
                        SharedString::from(format!("stamp-operation-{id}-{index}")),
                        operation.label(),
                        Kind::Ghost,
                        move |root, cx| root.select_stamp_operation(operation, Some(id), cx),
                        cx,
                    )
                })
                .collect::<Vec<_>>();
                body.child(div().flex().flex_wrap().gap_2().children(buttons))
            })
            .when(card.needs_review, |body| {
                body.child(
                    div()
                        .text_color(theme::conflict_fg())
                        .child(self.t(Key::StampNeedsReview)),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[gpui::test]
    async fn cards_support_review_before_write_and_hide_mutations_for_readers(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_directory, config) = crate::root::tests::desk();
        let client = Uuid::now_v7();
        let (root, cx) = cx.add_window_view(|window, cx| {
            let mut root = Root::new(config, window, cx);
            root.svc.stop_sync();
            root.svc
                .store
                .set_meta("client_directory", "allowed")
                .unwrap();
            root.status.connectivity = Connectivity::Online;
            root.open_loyalty(cx);
            let desk = root.loyalty_desk().unwrap();
            desk.selected = Some((client, "Fixture client".into()));
            desk.refresh_at = Instant::now() + Duration::from_secs(300);
            desk.stamps = CardList {
                visible: true,
                cards: Some(
                    serde_json::from_value(serde_json::json!({
                        "generation":"fixture", "programVersion":2, "canEdit":false, "cards":[],
                        "program":{
                            "enabled":true, "welcomeStamps":1, "name":"Fixture card", "goal":3,
                            "appearance":"mint", "terms":"", "reward":{"name":"Treatment"}
                        }
                    }))
                    .unwrap(),
                ),
                ..CardList::default()
            };
            root
        });
        cx.simulate_resize(gpui::size(px(1100.), px(720.)));
        cx.run_until_parked();
        assert!(cx.debug_bounds("stamp-issue").is_none());
        root.update(cx, |root, cx| {
            root.loyalty_desk()
                .unwrap()
                .stamps
                .cards
                .as_mut()
                .unwrap()
                .can_edit = true;
            cx.notify();
        });
        cx.run_until_parked();
        let button = cx.debug_bounds("stamp-issue").unwrap().center();
        cx.simulate_click(button, Default::default());
        cx.run_until_parked();
        assert!(cx.debug_bounds("stamp-confirm-action").is_none());
        let button = cx.debug_bounds("stamp-review-action").unwrap().center();
        cx.simulate_click(button, Default::default());
        cx.run_until_parked();
        assert!(cx.debug_bounds("stamp-confirm-action").is_some());
        root.update(cx, |root, cx| {
            root.loyalty_desk()
                .unwrap()
                .stamps
                .cards
                .as_mut()
                .unwrap()
                .generation = "restored".into();
            cx.notify();
        });
        cx.run_until_parked();
        assert!(cx.debug_bounds("stamp-confirm-action").is_none());
        assert!(cx.debug_bounds("stamp-cancel-action").is_some());
    }
}
