use super::*;
use sob_core::billing::parse_reviewed_amount;
use sob_core::reports::commissions::{
    CommissionPayout, CommissionPayoutError, CommissionPayoutReview, CommissionPolicy,
    CommissionRateEdit, SavedCommissionPayout,
};

#[derive(Clone, Copy)]
enum Action {
    Rates,
    Payout,
}

pub(super) enum Edit {
    Loading(Arc<()>),
    Ready(Editor),
}

pub(super) struct Editor {
    instance: Arc<()>,
    staff_id: uuid::Uuid,
    generation: String,
    fields: Fields,
    sending: bool,
    error: Option<Key>,
}

enum Fields {
    Rates {
        version: Option<u32>,
        service: Entity<TextField>,
        retail: Entity<TextField>,
    },
    Payout {
        amount: Entity<TextField>,
        reference: Entity<TextField>,
        pending: Option<SavedCommissionPayout>,
    },
}

enum Command {
    Rates(CommissionRateEdit),
    Payout(SavedCommissionPayout, Option<(String, uuid::Uuid)>),
}

enum WriteResult {
    Rates(Result<CommissionPolicy, TransportError>),
    Payout(Result<(), CommissionPayoutError>),
}

fn input(value: &str, cx: &mut Context<Root>) -> Entity<TextField> {
    cx.new(|cx| {
        let mut field = TextField::new("", false, cx);
        field.set_text(value, cx);
        field
    })
}

fn rate(value: u16, locale: Locale) -> String {
    let decimal = if locale == Locale::EsAr { ',' } else { '.' };
    format!("{}{decimal}{:02}", value / 100, value % 100)
}

impl Root {
    fn open_commission_editor(&mut self, action: Action, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.svc.status().connectivity == Connectivity::Online)
        else {
            return;
        };
        let Some(actor) = self.svc.current_session() else {
            return;
        };
        let Overlay::Commissions(desk) = &mut self.overlay else {
            return;
        };
        if !desk.can_manage
            || desk.statement.is_none()
            || desk.request.is_some()
            || desk.editor.is_some()
        {
            return;
        }
        let Some(staff_id) = desk
            .selected
            .as_deref()
            .and_then(|id| id.parse::<uuid::Uuid>().ok())
        else {
            return;
        };
        let pending = if matches!(action, Action::Payout) {
            match self
                .svc
                .store
                .pending_commission_payout(staff_id, &actor.user_id)
            {
                Ok(value) => value,
                Err(_) => {
                    desk.manage_notice = Some(Key::CommissionLocalSaveError);
                    cx.notify();
                    return;
                }
            }
        } else {
            None
        };
        let request = Arc::new(());
        let session = self.svc.session.clone();
        desk.editor = Some(Edit::Loading(request.clone()));
        desk.manage_notice = None;
        cx.notify();

        cx.spawn(async move |root, cx| {
            let policy = cx.background_executor().spawn(async move {
                transport.reviewed_commission_policy(staff_id).and_then(|policy| {
                    if policy.staff_id.parse::<uuid::Uuid>().ok() == Some(staff_id) { Ok(policy) }
                    else { Err(TransportError::Server("Unverified commission policy".into())) }
                })
            }).await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) { return; }
                let Overlay::Commissions(desk) = &mut root.overlay else { return };
                if !desk.can_manage || !matches!(&desk.editor, Some(Edit::Loading(token)) if Arc::ptr_eq(token, &request)) {
                    return;
                }
                desk.editor = None;
                match policy {
                    Ok(policy) => {
                        let fields = match action {
                            Action::Rates => Fields::Rates {
                                version: policy.version,
                                service: input(&rate(policy.service_basis_points, root.locale), cx),
                                retail: input(&rate(policy.product_basis_points, root.locale), cx),
                            },
                            Action::Payout => Fields::Payout {
                                amount: input("", cx),
                                reference: input("", cx),
                                pending,
                            },
                        };
                        let refresh_statement = matches!(action, Action::Payout) && desk.statement.as_ref()
                            .and_then(|statement| statement.generation.as_deref()) != Some(policy.generation.as_str());
                        desk.editor = Some(Edit::Ready(Editor { instance: request, staff_id, generation: policy.generation, fields, sending: false, error: None }));
                        if refresh_statement {
                            root.load_commissions(root.status.cursor, cx);
                        }
                    }
                    Err(TransportError::Forbidden(_) | TransportError::Unauthorized) => {
                        desk.can_manage = false;
                        desk.manage_notice = Some(Key::ReportRestricted);
                    }
                    Err(_) => desk.manage_notice = Some(Key::ReportFailed),
                }
                cx.notify();
            });
        }).detach();
    }

    fn save_commission_editor(&mut self, cx: &mut Context<Self>) {
        self.submit_commission_editor(None, cx);
    }

    fn submit_commission_editor(
        &mut self,
        recorded_id: Option<uuid::Uuid>,
        cx: &mut Context<Self>,
    ) {
        let resolve_existing = recorded_id.is_some();
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.svc.status().connectivity == Connectivity::Online)
        else {
            return;
        };
        let Some(actor) = self.svc.current_session() else {
            return;
        };
        let Overlay::Commissions(desk) = &mut self.overlay else {
            return;
        };
        if !desk.can_manage || desk.request.is_some() {
            return;
        }
        let Some(statement) = &desk.statement else {
            return;
        };
        let Some(Edit::Ready(editor)) = &mut desk.editor else {
            return;
        };
        if editor.sending || statement.staff_id.parse::<uuid::Uuid>().ok() != Some(editor.staff_id)
        {
            return;
        }
        if resolve_existing
            && !matches!(
                &editor.fields,
                Fields::Payout {
                    pending: Some(_),
                    ..
                }
            )
        {
            return;
        }
        let staff_id = editor.staff_id;
        let command = match &mut editor.fields {
            Fields::Rates {
                version,
                service,
                retail,
            } => {
                if editor.error == Some(Key::CommissionRatesChanged) {
                    return;
                }
                let points = |field: &Entity<TextField>| {
                    parse_reviewed_amount(field.read(cx).text())
                        .filter(|v| *v <= 10_000)
                        .map(|v| v as u16)
                };
                let Some((service_basis_points, product_basis_points)) =
                    points(service).zip(points(retail))
                else {
                    editor.error = Some(Key::CommissionInvalidRate);
                    cx.notify();
                    return;
                };
                Command::Rates(CommissionRateEdit {
                    generation: editor.generation.clone(),
                    version: *version,
                    service_basis_points,
                    product_basis_points,
                })
            }
            Fields::Payout {
                amount,
                reference,
                pending,
            } => {
                if statement.generation.as_deref() != Some(editor.generation.as_str()) {
                    editor.error = Some(Key::CommissionPayoutGenerationChanged);
                    cx.notify();
                    return;
                }
                if pending.is_none() {
                    let Some(review) = parse_reviewed_amount(amount.read(cx).text())
                        .filter(|cents| i64::from(*cents) <= statement.outstanding_cents)
                        .and_then(|cents| {
                            CommissionPayoutReview::new(
                                actor.user_id.clone(),
                                editor.generation.clone(),
                                cents,
                                reference.read(cx).text(),
                            )
                        })
                    else {
                        editor.error = Some(Key::CommissionPayoutInvalid);
                        cx.notify();
                        return;
                    };
                    let review = SavedCommissionPayout { staff_id, review };
                    match self.svc.store.reserve_commission_payout(&review) {
                        Ok(true) => *pending = Some(review),
                        Ok(false) => {
                            // Another window may have staged a different payment. Present it before retry.
                            *pending = self
                                .svc
                                .store
                                .pending_commission_payout(staff_id, &actor.user_id)
                                .ok()
                                .flatten();
                            editor.error = Some(if pending.is_some() {
                                Key::CommissionPayoutUnconfirmed
                            } else {
                                Key::CommissionLocalSaveError
                            });
                            cx.notify();
                            return;
                        }
                        Err(_) => {
                            editor.error = Some(Key::CommissionLocalSaveError);
                            cx.notify();
                            return;
                        }
                    }
                }
                let Some(review) = pending.as_ref() else {
                    return;
                };
                if !resolve_existing && editor.error == Some(Key::CommissionPayoutKeyConflict) {
                    return;
                }
                if !resolve_existing && review.review.generation != editor.generation {
                    editor.error = Some(Key::CommissionPayoutGenerationChanged);
                    cx.notify();
                    return;
                }
                if !self
                    .svc
                    .store
                    .pending_commission_payout(staff_id, &actor.user_id)
                    .is_ok_and(|current| current.as_ref() == Some(review))
                {
                    editor.error = Some(Key::CommissionLocalSaveError);
                    cx.notify();
                    return;
                }
                Command::Payout(
                    review.clone(),
                    recorded_id.map(|id| (editor.generation.clone(), id)),
                )
            }
        };
        editor.sending = true;
        editor.error = None;
        let session = self.svc.session.clone();
        let instance = desk.instance.clone();
        let edit_instance = editor.instance.clone();
        cx.notify();

        cx.spawn(async move |root, cx| {
            let (result, payout) = cx
                .background_executor()
                .spawn(async move {
                    match command {
                        Command::Rates(rates) => (
                            WriteResult::Rates(
                                transport.set_reviewed_commission_rates(staff_id, &rates),
                            ),
                            None,
                        ),
                        Command::Payout(saved, reconciliation) => {
                            let result = transport
                                .record_reviewed_commission_payout(
                                    &saved,
                                    reconciliation
                                        .as_ref()
                                        .map(|(generation, id)| (generation.as_str(), *id)),
                                )
                                .map(|_| ());
                            (WriteResult::Payout(result), Some(saved))
                        }
                    }
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let confirmed_or_rejected = matches!(&result, WriteResult::Payout(Ok(())))
                    || (!resolve_existing
                        && matches!(
                            &result,
                            WriteResult::Payout(Err(CommissionPayoutError::BalanceChanged
                                | CommissionPayoutError::InvalidReview))
                        ));
                let clear_failed = confirmed_or_rejected
                    && payout.as_ref().is_some_and(|saved| {
                        root.svc.store.clear_commission_payout(saved).is_err()
                    });
                let Overlay::Commissions(desk) = &mut root.overlay else {
                    return;
                };
                if !Arc::ptr_eq(&instance, &desk.instance) {
                    return;
                }
                let Some(Edit::Ready(editor)) = &mut desk.editor else {
                    return;
                };
                if !Arc::ptr_eq(&edit_instance, &editor.instance) || !editor.sending {
                    return;
                }
                editor.sending = false;
                if clear_failed {
                    editor.error = Some(Key::CommissionLocalSaveError);
                } else {
                    let notice = match result {
                        WriteResult::Rates(Ok(_)) => Some(Key::CommissionRatesSaved),
                        WriteResult::Payout(Ok(())) => {
                            desk.payout_page = 1;
                            Some(if resolve_existing {
                                Key::CommissionPayoutMatched
                            } else {
                                Key::CommissionPayoutSaved
                            })
                        }
                        WriteResult::Payout(Err(CommissionPayoutError::BalanceChanged)) => {
                            Some(Key::CommissionPayoutBalanceChanged)
                        }
                        WriteResult::Payout(Err(CommissionPayoutError::InvalidReview)) => {
                            Some(Key::CommissionPayoutInvalid)
                        }
                        WriteResult::Payout(Err(CommissionPayoutError::KeyConflict)) => {
                            editor.error = Some(Key::CommissionPayoutKeyConflict);
                            None
                        }
                        WriteResult::Payout(Err(CommissionPayoutError::NoMatch)) => {
                            editor.error = Some(Key::CommissionPayoutNotFound);
                            None
                        }
                        WriteResult::Rates(Err(
                            TransportError::BadRequest(_)
                            | TransportError::ReplicaGenerationChanged,
                        )) => {
                            editor.error = Some(Key::CommissionRatesChanged);
                            None
                        }
                        WriteResult::Payout(Err(CommissionPayoutError::Transport(
                            TransportError::ReplicaGenerationChanged,
                        ))) => {
                            editor.error = Some(Key::CommissionPayoutGenerationChanged);
                            None
                        }
                        WriteResult::Rates(Err(
                            TransportError::Unauthorized | TransportError::Forbidden(_),
                        ))
                        | WriteResult::Payout(Err(CommissionPayoutError::Transport(
                            TransportError::Unauthorized | TransportError::Forbidden(_),
                        ))) => {
                            desk.can_manage = false;
                            Some(Key::ReportRestricted)
                        }
                        WriteResult::Rates(Err(_)) => {
                            editor.error = Some(Key::ReportFailed);
                            None
                        }
                        WriteResult::Payout(Err(_)) => {
                            editor.error = Some(Key::CommissionPayoutUnconfirmed);
                            None
                        }
                    };
                    if let Some(notice) = notice {
                        desk.manage_notice = Some(notice);
                        desk.editor = None;
                        root.load_commissions(root.status.cursor, cx);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn retry_reconciled_payout(&mut self, cx: &mut Context<Self>) {
        if self.svc.status().connectivity != Connectivity::Online {
            return;
        }
        let Overlay::Commissions(desk) = &mut self.overlay else {
            return;
        };
        if !desk.can_manage || desk.request.is_some() {
            return;
        }
        let Some(Edit::Ready(editor)) = &mut desk.editor else {
            return;
        };
        let Fields::Payout { pending, .. } = &mut editor.fields else {
            return;
        };
        let Some(saved) = pending.as_ref() else {
            return;
        };
        if editor.sending
            || saved.review.generation == editor.generation
            || !desk.statement.as_ref().is_some_and(|statement| {
                statement.staff_id.parse::<uuid::Uuid>().ok() == Some(editor.staff_id)
                    && statement.generation.as_deref() == Some(editor.generation.as_str())
            })
        {
            return;
        }
        match self
            .svc
            .store
            .rebind_commission_payout(saved, &editor.generation)
        {
            Ok(Some(reviewed)) => {
                *pending = Some(reviewed);
                editor.error = None;
                self.save_commission_editor(cx);
            }
            Ok(None) | Err(_) => editor.error = Some(Key::CommissionLocalSaveError),
        }
        cx.notify();
    }

    pub(super) fn render_commission_management(
        &self,
        desk: &Desk,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let ready = self.status.connectivity == Connectivity::Online && desk.request.is_none();
        let row = div()
            .flex()
            .flex_col()
            .gap_2()
            .when_some(desk.manage_notice, |view, notice| {
                view.child(self.t(notice))
            });
        if !desk.can_manage {
            return row;
        }
        match &desk.editor {
            None if ready => row.child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.button(
                        "commission-edit-rates",
                        self.t(Key::CommissionRates),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| {
                            root.open_commission_editor(Action::Rates, cx)
                        }),
                    ))
                    .child(self.button(
                        "commission-record-payout",
                        self.t(Key::CommissionSavePayout),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| {
                            root.open_commission_editor(Action::Payout, cx)
                        }),
                    )),
            ),
            Some(Edit::Loading(_)) => row.child(self.t(Key::ReportLoading)),
            Some(Edit::Ready(editor)) => {
                let statement_generation = desk
                    .statement
                    .as_ref()
                    .and_then(|s| s.generation.as_deref());
                row.child(self.render_commission_editor(editor, ready, statement_generation, cx))
            }
            None => row,
        }
    }

    pub(super) fn render_payout_reconciliation(
        &self,
        desk: &Desk,
        statement: &CommissionStatement,
        payout: &CommissionPayout,
        cx: &mut Context<Self>,
    ) -> Option<impl IntoElement> {
        let Some(Edit::Ready(editor)) = &desk.editor else {
            return None;
        };
        let Fields::Payout {
            pending: Some(saved),
            ..
        } = &editor.fields
        else {
            return None;
        };
        if editor.sending
            || desk.request.is_some()
            || !desk.can_manage
            || self.status.connectivity != Connectivity::Online
            || statement.generation.as_deref() != Some(editor.generation.as_str())
            || !payout.matches(&saved.review)
        {
            return None;
        }
        let payout_id = payout.id;
        Some(self.button(
            SharedString::from(format!("commission-match-{payout_id}")),
            self.t(Key::CommissionPayoutAlreadyRecorded),
            Kind::Ghost,
            cx.listener(move |root, _, _, cx| root.submit_commission_editor(Some(payout_id), cx)),
        ))
    }

    fn render_commission_editor(
        &self,
        editor: &Editor,
        ready: bool,
        statement_generation: Option<&str>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let field = |key, input: &Entity<TextField>| {
            div()
                .flex()
                .flex_col()
                .gap_1()
                .child(self.label(key))
                .child(input.clone())
        };
        let confirm;
        let mut action = Key::CommissionSaveRates;
        let mut panel = div()
            .flex()
            .flex_col()
            .gap_2()
            .p_3()
            .rounded_md()
            .border_1()
            .border_color(theme::line());
        panel = match &editor.fields {
            Fields::Rates {
                service, retail, ..
            } => {
                confirm = editor.error != Some(Key::CommissionRatesChanged);
                panel
                    .child(self.t(Key::CommissionRateBasis))
                    .when(!editor.sending, |view| {
                        view.child(field(Key::CommissionServiceRate, service))
                            .child(field(Key::CommissionRetailRate, retail))
                    })
            }
            Fields::Payout {
                pending: None,
                amount,
                reference,
            } => {
                action = Key::CommissionSavePayout;
                confirm = statement_generation == Some(editor.generation.as_str());
                panel
                    .child(self.t(Key::CommissionPayoutBasis))
                    .when(!confirm, |view| {
                        view.child(self.t(Key::CommissionPayoutRefresh))
                    })
                    .child(field(Key::CommissionPayoutAmount, amount))
                    .child(field(Key::CommissionPayoutReference, reference))
            }
            Fields::Payout {
                pending: Some(pending),
                ..
            } => {
                action = Key::CommissionPayoutRetry;
                let current = statement_generation == Some(editor.generation.as_str());
                confirm = current
                    && pending.review.generation == editor.generation
                    && !matches!(
                        editor.error,
                        Some(
                            Key::CommissionPayoutGenerationChanged
                                | Key::CommissionPayoutKeyConflict
                        )
                    );
                let value = self.amount_label(i64::from(pending.review.amount_cents), CURRENCY);
                panel
                    .child(format!("{value} · {}", pending.review.reference))
                    .child(self.t(if confirm {
                        Key::CommissionPayoutUnconfirmed
                    } else if editor.error == Some(Key::CommissionPayoutKeyConflict) {
                        Key::CommissionPayoutKeyConflict
                    } else {
                        Key::CommissionPayoutGenerationChanged
                    }))
                    .when(
                        ready
                            && current
                            && pending.review.generation != editor.generation
                            && !editor.sending
                            && editor.error != Some(Key::CommissionPayoutKeyConflict),
                        |view| {
                            view.child(self.button(
                                "commission-retry-reconciled",
                                self.t(Key::CommissionPayoutReconciled),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| root.retry_reconciled_payout(cx)),
                            ))
                        },
                    )
                    .child(
                        div()
                            .text_sm()
                            .child(self.t(Key::CommissionPayoutSelectRecorded)),
                    )
            }
        };
        panel
            .when_some(editor.error, |view, error| {
                view.child(div().text_color(theme::conflict_fg()).child(self.t(error)))
            })
            .when(editor.sending, |view| {
                view.child(self.t(Key::ReportLoading))
            })
            .when(!editor.sending, |view| {
                view.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .child(self.button(
                            "commission-cancel-edit",
                            self.t(Key::Close),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| {
                                if let Overlay::Commissions(desk) = &mut root.overlay {
                                    desk.editor = None;
                                    cx.notify();
                                }
                            }),
                        ))
                        .when(ready && confirm, |view| {
                            view.child(self.button(
                                "commission-save-edit",
                                self.t(action),
                                Kind::Primary,
                                cx.listener(|root, _, _, cx| root.save_commission_editor(cx)),
                            ))
                        }),
                )
            })
    }
}
