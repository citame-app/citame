use super::*;
use sob_core::billing::{CashAdjustment, CashCommand, CashSession, parse_reviewed_amount};
use sob_core::sync::TransportError;
use std::sync::Arc;

pub(super) enum RegisterDesk {
    Loading(Arc<()>),
    Error(Key),
    Ready(Box<RegisterView>),
}

pub(super) struct RegisterView {
    session: Option<CashSession>,
    form: Option<RegisterForm>,
    observed_revision: i64,
}

#[derive(Clone, Copy)]
enum Action {
    Open,
    Close,
    Move(CashAdjustment),
}

impl Action {
    fn title(self) -> Key {
        match self {
            Self::Open => Key::CashOpen,
            Self::Close => Key::CashClose,
            Self::Move(CashAdjustment::Deposit) => Key::CashDeposit,
            Self::Move(CashAdjustment::Withdrawal) => Key::CashWithdrawal,
        }
    }

    fn amount_label(self) -> Key {
        match self {
            Self::Open => Key::CashOpening,
            Self::Close => Key::CashCounted,
            Self::Move(_) => Key::CashAmount,
        }
    }
}

struct RegisterForm {
    action: Action,
    amount: Entity<TextField>,
    reason: Option<Entity<TextField>>,
    command: Option<CashCommand>,
    saving: bool,
    error: Option<String>,
}

impl RegisterForm {
    fn command(&self, session: Option<&CashSession>, cx: &App) -> Option<CashCommand> {
        if let Some(command) = &self.command {
            return Some(command.clone());
        }
        let cents = parse_reviewed_amount(self.amount.read(cx).text())?;
        match self.action {
            Action::Open => Some(CashCommand::open(cents)),
            Action::Close => Some(CashCommand::close(session?, cents)),
            Action::Move(kind) => {
                let session = session?;
                let reason = self.reason.as_ref()?.read(cx).text().trim();
                (cents > 0 && (3..=300).contains(&reason.encode_utf16().count()))
                    .then(|| CashCommand::adjust(session, kind, cents, reason.to_owned()))
            }
        }
    }
}

impl Root {
    pub(super) fn refresh_register_if_changed(&mut self, cx: &mut Context<Self>) {
        if matches!(&self.overlay, Overlay::Cash(RegisterDesk::Ready(view))
            if view.form.is_none() && self.svc.store.live_view_revision("commerce").ok()
                .is_some_and(|revision| revision != view.observed_revision))
        {
            self.load_register(cx);
        }
    }

    pub(super) fn load_register(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            self.overlay = Overlay::Cash(RegisterDesk::Error(Key::CashOffline));
            cx.notify();
            return;
        };
        let request = Arc::new(());
        let auth = self.svc.session.clone();
        let observed_revision = self
            .svc
            .store
            .live_view_revision("commerce")
            .unwrap_or_default();
        self.overlay = Overlay::Cash(RegisterDesk::Loading(request.clone()));
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx.background_executor()
                .spawn(async move { transport.current_cash_session() }).await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&auth, &root.svc.session)
                    || !matches!(&root.overlay, Overlay::Cash(RegisterDesk::Loading(current)) if Arc::ptr_eq(current, &request)) {
                    return;
                }
                root.overlay = Overlay::Cash(match result {
                    Ok(session) => RegisterDesk::Ready(Box::new(RegisterView { session, form: None, observed_revision })),
                    Err(TransportError::Forbidden(_) | TransportError::Unauthorized) =>
                        RegisterDesk::Error(Key::CashRestricted),
                    Err(TransportError::Offline(_)) => RegisterDesk::Error(Key::CashOffline),
                    Err(_) => RegisterDesk::Error(Key::CashUnavailable),
                });
                cx.notify();
            });
        }).detach();
    }

    fn choose_cash_action(&mut self, action: Action, cx: &mut Context<Self>) {
        let Overlay::Cash(RegisterDesk::Ready(view)) = &mut self.overlay else {
            return;
        };
        if view.form.is_some() {
            return;
        }
        view.form = Some(RegisterForm {
            action,
            amount: cx.new(|cx| TextField::new("EUR", false, cx)),
            reason: matches!(action, Action::Move(_))
                .then(|| cx.new(|cx| TextField::new("", false, cx))),
            command: None,
            saving: false,
            error: None,
        });
        cx.notify();
    }

    fn confirm_cash_action(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let invalid = self.t(Key::CashInvalid);
        let Overlay::Cash(RegisterDesk::Ready(view)) = &mut self.overlay else {
            return;
        };
        let Some(form) = &mut view.form else { return };
        if form.saving {
            return;
        }
        let Some(command) = form.command(view.session.as_ref(), cx) else {
            form.error = Some(invalid.to_owned());
            cx.notify();
            return;
        };
        form.command = Some(command.clone());
        form.saving = true;
        form.error = None;
        let sent = command.clone();
        let auth = self.svc.session.clone();
        cx.notify();

        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.update_cash_session(&sent) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&auth, &root.svc.session) {
                    return;
                }
                let fallback = root.t(Key::CashUnconfirmed);
                let restricted = root.t(Key::CashRestricted);
                let Overlay::Cash(RegisterDesk::Ready(view)) = &mut root.overlay else {
                    return;
                };
                let Some(form) = &mut view.form else { return };
                if form.command.as_ref() != Some(&command) {
                    return;
                }
                match result {
                    Ok(session) => {
                        view.session = Some(session);
                        view.form = None;
                    }
                    Err(error) => {
                        form.saving = false;
                        form.error = Some(match error {
                            TransportError::Forbidden(_) | TransportError::Unauthorized => {
                                restricted.to_owned()
                            }
                            TransportError::BadRequest(message) => message,
                            _ => fallback.to_owned(),
                        });
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_cash_register(
        &self,
        desk: &RegisterDesk,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let saving = matches!(desk, RegisterDesk::Ready(view) if view.form.as_ref().is_some_and(|form| form.saving));
        let body = div().child(
            div()
                .text_lg()
                .font_weight(FontWeight::BOLD)
                .child(self.t(Key::CashRegister)),
        );
        let body = body.when(
            !matches!(desk, RegisterDesk::Ready(view) if view.form.is_some()),
            |body| {
                body.child(
                    self.button(
                        "cash-unpaid",
                        self.t(Key::DueAppointments),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.open_unpaid(cx)),
                    )
                    .debug_selector(|| "cash-unpaid".to_owned()),
                )
            },
        );
        let body = match desk {
            RegisterDesk::Loading(_) => body.child(self.t(Key::CashLoading)),
            RegisterDesk::Error(key) => body.child(self.t(*key)),
            RegisterDesk::Ready(view) => {
                let open = view
                    .session
                    .as_ref()
                    .is_some_and(|session| session.closed_at.is_none());
                let body = match &view.session {
                    Some(session) => body.child(self.render_cash_summary(session)),
                    None => body.child(self.t(Key::CashNoSession)),
                };
                if let Some(form) = &view.form {
                    body.child(self.render_cash_form(form, online, cx))
                } else if !online {
                    body.child(self.t(Key::CashOffline))
                } else {
                    let actions: &[(Action, &str)] = if open {
                        &[
                            (Action::Move(CashAdjustment::Deposit), "cash-deposit"),
                            (Action::Move(CashAdjustment::Withdrawal), "cash-withdrawal"),
                            (Action::Close, "cash-close"),
                        ]
                    } else {
                        &[(Action::Open, "cash-open")]
                    };
                    body.child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_2()
                            .children(actions.iter().map(|&(action, id)| {
                                self.button(
                                    id,
                                    self.t(action.title()),
                                    Kind::Ghost,
                                    cx.listener(move |root, _, _, cx| {
                                        root.choose_cash_action(action, cx)
                                    }),
                                )
                            })),
                    )
                }
            }
        };
        self.modal(body.when(!saving, |view| {
            view.child(
                div()
                    .flex()
                    .justify_end()
                    .gap_2()
                    .when(
                        online && !matches!(desk, RegisterDesk::Loading(_)),
                        |view| {
                            view.child(self.button(
                                "cash-reload",
                                self.t(Key::CashRefresh),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| root.load_register(cx)),
                            ))
                        },
                    )
                    .child(self.button(
                        "close-cash-desk",
                        self.t(Key::Close),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| {
                            root.overlay = Overlay::None;
                            cx.notify();
                        }),
                    )),
            )
        }))
    }

    fn render_cash_summary(&self, session: &CashSession) -> gpui::Div {
        let amount = |key, cents| format!("{}: {}", self.t(key), self.amount_label(cents, "EUR"));
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(format!(
                "{}: {}",
                self.t(Key::CashOpened),
                self.date_time_label(session.opened_at)
            ))
            .child(amount(Key::CashOpening, i64::from(session.opening_cents)))
            .child(amount(Key::CashExpected, session.expected_cents))
            .when_some(session.closed_at, |view, at| {
                view.child(format!(
                    "{}: {}",
                    self.t(Key::CashClosed),
                    self.date_time_label(at)
                ))
            })
            .when_some(session.counted_cents, |view, cents| {
                view.child(amount(Key::CashCounted, i64::from(cents)))
            })
            .when_some(session.difference_cents, |view, cents| {
                view.child(amount(Key::CashDifference, cents))
            })
            .when(!session.movements.is_empty(), |view| {
                view.child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(self.t(Key::CashMovements)),
                )
                .child(
                    div()
                        .id("cash-movements")
                        .max_h(px(155.))
                        .overflow_y_scroll()
                        .children(session.movements.iter().rev().map(|row| {
                            let label = match row.kind.as_str() {
                                "deposit" => self.t(Key::CashDeposit),
                                "withdrawal" => self.t(Key::CashWithdrawal),
                                "sale" => self.t(Key::CashSale),
                                "refund" => self.t(Key::CashRefund),
                                _ => row.kind.as_str(),
                            };
                            div()
                                .py_1()
                                .text_sm()
                                .child(format!(
                                    "{} · {label} · {}",
                                    self.date_time_label(row.created_at),
                                    self.amount_label(row.amount_cents, "EUR")
                                ))
                                .child(div().text_color(theme::muted()).child(row.reason.clone()))
                        })),
                )
            })
    }

    fn render_cash_form(
        &self,
        form: &RegisterForm,
        online: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(form.action.title())),
            )
            .when(form.command.is_none(), |view| {
                view.child(self.t(form.action.amount_label()))
                    .child(form.amount.clone())
                    .when_some(form.reason.clone(), |view, reason| {
                        view.child(self.t(Key::CashReason)).child(reason)
                    })
            })
            .when(form.command.is_some(), |view| {
                view.child(format!(
                    "{}: {} EUR",
                    self.t(form.action.amount_label()),
                    form.amount.read(cx).text().trim()
                ))
            })
            .when_some(form.error.clone(), |view, error| {
                view.child(div().text_color(theme::conflict_fg()).child(error))
            })
            .when(form.saving, |view| view.child(self.t(Key::CashPending)))
            .when(!online && !form.saving, |view| {
                view.child(self.t(Key::CashOffline))
            })
            .when(online && !form.saving, |view| {
                view.child(self.button(
                    "confirm-cash-action",
                    self.t(form.action.title()),
                    Kind::Primary,
                    cx.listener(|root, _, _, cx| root.confirm_cash_action(cx)),
                ))
            })
            .when(form.command.is_none(), |view| {
                view.child(self.button(
                    "cancel-cash-action",
                    self.t(Key::Back),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| {
                        if let Overlay::Cash(RegisterDesk::Ready(view)) = &mut root.overlay {
                            view.form = None;
                            cx.notify();
                        }
                    }),
                ))
            })
    }
}
