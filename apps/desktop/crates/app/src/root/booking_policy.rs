use super::*;
use sob_core::booking_policy::{
    BookingPolicy, DepositKind, LIVE_TOPIC, PolicyInput, PolicyWriteError, ReviewedBookingPolicy,
};
use sob_core::sync::TransportError;

const INPUTS: [Key; 5] = [
    Key::PolicyDepositValue,
    Key::PolicyHold,
    Key::PolicyCancellation,
    Key::PolicyLateFee,
    Key::PolicyNoShowFee,
];

pub(super) struct Desk {
    identity: Arc<()>,
    editor: Option<Editor>,
    busy: bool,
    status: Option<Key>,
    observed: Option<i64>,
    blocked: bool,
    confirm_close: bool,
}

struct Editor {
    base: ReviewedBookingPolicy,
    enabled: bool,
    kind: DepositKind,
    exempt: bool,
    controls: [Entity<TextField>; 5],
}

impl Editor {
    fn new(
        base: ReviewedBookingPolicy,
        draft: Option<PolicyInput>,
        locale: Locale,
        cx: &mut Context<Root>,
    ) -> Self {
        let input = draft.unwrap_or_else(|| PolicyInput::from_policy(&base.policy));
        let values = [
            input.deposit_value,
            input.hold_minutes,
            input.cancellation_window_minutes,
            input.late_fee,
            input.no_show_fee,
        ];
        let controls = std::array::from_fn(|index| {
            let field = cx.new(|cx| {
                let mut field = TextField::new(i18n::t(locale, INPUTS[index]), false, cx);
                field.set_text(&values[index], cx);
                field
            });
            cx.observe(&field, |_, _, cx| cx.notify()).detach();
            field
        });
        Self {
            enabled: input.enabled,
            kind: input.deposit_kind,
            exempt: input.trusted_exempt,
            base,
            controls,
        }
    }

    fn input(&self, cx: &App) -> PolicyInput {
        let [
            deposit_value,
            hold_minutes,
            cancellation_window_minutes,
            late_fee,
            no_show_fee,
        ] = self
            .controls
            .each_ref()
            .map(|field| field.read(cx).text().to_owned());
        PolicyInput {
            enabled: self.enabled,
            deposit_kind: self.kind,
            deposit_value,
            hold_minutes,
            cancellation_window_minutes,
            late_fee,
            no_show_fee,
            trusted_exempt: self.exempt,
        }
    }

    fn proposed(&self, cx: &App) -> Option<BookingPolicy> {
        self.input(cx).validated(self.base.policy.version)
    }

    fn dirty(&self, cx: &App) -> bool {
        self.proposed(cx).as_ref() != Some(&self.base.policy)
    }
}

enum Operation {
    Read,
    Review,
    Save(ReviewedBookingPolicy),
}

impl Root {
    pub(super) fn preserve_open_booking_policy_draft(&mut self, cx: &App) -> bool {
        let Overlay::BookingPolicy(desk) = &mut self.overlay else {
            return false;
        };
        if !desk.editor.as_ref().is_some_and(|editor| editor.dirty(cx)) {
            return false;
        }
        desk.identity = Arc::new(());
        desk.busy = false;
        desk.blocked = true;
        desk.status = Some(Key::PolicyChanged);
        true
    }

    pub(super) fn open_booking_policy(&mut self, cx: &mut Context<Self>) {
        if !self.can_configure_salon() {
            return;
        }
        self.overlay = Overlay::BookingPolicy(Box::new(Desk {
            identity: Arc::new(()),
            editor: None,
            busy: false,
            status: None,
            observed: None,
            blocked: false,
            confirm_close: false,
        }));
        self.request_booking_policy(Operation::Read, cx);
        cx.notify();
    }

    pub(super) fn refresh_booking_policy(&mut self, reconnected: bool, cx: &mut Context<Self>) {
        let Overlay::BookingPolicy(desk) = &mut self.overlay else {
            return;
        };
        if self.status.connectivity != Connectivity::Online
            || desk.busy
            || desk.blocked
            || desk.confirm_close
        {
            return;
        }
        let current = self.svc.store.live_view_revision(LIVE_TOPIC).ok();
        if reconnected || current != desk.observed {
            if desk.editor.as_ref().is_some_and(|editor| editor.dirty(cx)) {
                if current != desk.observed {
                    desk.blocked = true;
                    desk.status = Some(Key::PolicyChanged);
                    cx.notify();
                }
            } else {
                self.request_booking_policy(Operation::Read, cx);
            }
        }
    }

    fn save_booking_policy(&mut self, cx: &mut Context<Self>) {
        let Overlay::BookingPolicy(desk) = &mut self.overlay else {
            return;
        };
        if desk.blocked || desk.busy || desk.confirm_close {
            return;
        }
        let Some(editor) = &desk.editor else { return };
        let Some(policy) = editor.proposed(cx) else {
            desk.status = Some(Key::PolicyInvalid);
            cx.notify();
            return;
        };
        if policy != editor.base.policy {
            let reviewed = ReviewedBookingPolicy {
                generation: editor.base.generation.clone(),
                policy,
            };
            self.request_booking_policy(Operation::Save(reviewed), cx);
        }
    }

    fn request_booking_policy(&mut self, operation: Operation, cx: &mut Context<Self>) {
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let Overlay::BookingPolicy(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy {
            return;
        }
        let proposed = if matches!(operation, Operation::Review) {
            desk.editor
                .as_ref()
                .map(|editor| (editor.base.policy.clone(), editor.input(cx)))
        } else {
            None
        };
        let saving = matches!(operation, Operation::Save(_));
        desk.busy = true;
        desk.observed = self.svc.store.live_view_revision(LIVE_TOPIC).ok();
        let identity = desk.identity.clone();
        let session = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match operation {
                        Operation::Save(reviewed) => transport.write_booking_policy(&reviewed),
                        Operation::Read | Operation::Review => {
                            transport.booking_policy().map_err(Into::into)
                        }
                    }
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let Overlay::BookingPolicy(desk) = &mut root.overlay else {
                    return;
                };
                if !Arc::ptr_eq(&identity, &desk.identity) {
                    return;
                }
                desk.busy = false;
                match result {
                    Ok(saved) => {
                        let draft =
                            proposed.map(|(base, draft)| draft.rebase(&base, &saved.policy));
                        let needs_review = draft
                            .as_ref()
                            .is_some_and(|draft| *draft != PolicyInput::from_policy(&saved.policy));
                        desk.editor = Some(Editor::new(saved, draft, root.locale, cx));
                        desk.blocked = false;
                        desk.status = if saving {
                            Some(Key::PolicySaved)
                        } else {
                            needs_review.then_some(Key::PolicyReviewDraft)
                        };
                        if saving {
                            root.svc.wake(Wake::Manual);
                        }
                    }
                    Err(PolicyWriteError::Conflict) => {
                        desk.blocked = true;
                        desk.status = Some(Key::PolicyChanged);
                    }
                    Err(PolicyWriteError::MixedCurrencies) => {
                        desk.status = Some(Key::PolicyMixedCurrencies)
                    }
                    Err(PolicyWriteError::Transport(error)) => {
                        if saving
                            && matches!(
                                error,
                                TransportError::Offline(_) | TransportError::Server(_)
                            )
                        {
                            desk.blocked = true;
                            desk.status = Some(Key::PolicyUnconfirmed);
                        } else {
                            desk.status = Some(Key::PolicyError);
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn dismiss_booking_policy(&mut self, cx: &mut Context<Self>) {
        let Overlay::BookingPolicy(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy {
            return;
        }
        if desk.confirm_close {
            desk.confirm_close = false;
        } else if desk.editor.as_ref().is_some_and(|editor| editor.dirty(cx)) {
            desk.confirm_close = true;
        } else {
            self.overlay = Overlay::None;
        }
        cx.notify();
    }

    pub(super) fn render_booking_policy(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let editing = !desk.busy && !desk.confirm_close;
        let body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::BOLD)
                    .child(self.t(Key::BookingPolicy)),
            )
            .when_some(desk.status, |body, key| {
                body.child(div().text_sm().child(self.t(key)))
            })
            .when(!online, |body| {
                body.child(self.t(Key::PolicyNeedsConnection))
            })
            .when(desk.busy, |body| {
                body.child(self.t(Key::CloudWorkspacesLoading))
            })
            .when(desk.confirm_close, |body| {
                body.child(self.t(Key::SalonConfirmDiscard))
                    .child(self.button(
                        "policy-discard",
                        self.t(Key::SalonDiscard),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| {
                            root.overlay = Overlay::None;
                            cx.notify();
                        }),
                    ))
                    .child(self.button(
                        "policy-keep",
                        self.t(Key::Cancel),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.dismiss_booking_policy(cx)),
                    ))
            })
            .when(editing, |body| {
                body.when_some(desk.editor.as_ref(), |body, editor| {
                    body.child(self.render_booking_policy_editor(editor, cx))
                })
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .when(
                            online
                                && !desk.blocked
                                && desk.editor.as_ref().is_some_and(|editor| editor.dirty(cx)),
                            |actions| {
                                actions.child(self.button(
                                    "policy-save",
                                    self.t(Key::SalonSave),
                                    Kind::Primary,
                                    cx.listener(|root, _, _, cx| root.save_booking_policy(cx)),
                                ))
                            },
                        )
                        .when(online, |actions| {
                            actions.child(self.button(
                                "policy-review",
                                self.t(Key::PolicyReload),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| {
                                    root.request_booking_policy(Operation::Review, cx)
                                }),
                            ))
                        })
                        .child(self.button(
                            "policy-close",
                            self.t(Key::Close),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                        )),
                )
            });
        self.modal_with_height(
            body,
            (viewport.width - px(32.)).max(px(220.)).min(px(650.)),
            (viewport.height - px(28.)).max(px(140.)),
            Some(cx),
        )
    }

    fn render_booking_policy_editor(
        &self,
        editor: &Editor,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        div()
            .id("booking-policy-scroll")
            .min_h(px(0.))
            .flex_shrink()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.t(Key::PolicyHelp)),
            )
            .child(self.button(
                "policy-enabled",
                self.t(if editor.enabled {
                    Key::PolicyEnabled
                } else {
                    Key::PolicyDisabled
                }),
                if editor.enabled {
                    Kind::Primary
                } else {
                    Kind::Ghost
                },
                cx.listener(|root, _, _, cx| {
                    if let Overlay::BookingPolicy(desk) = &mut root.overlay
                        && let Some(editor) = &mut desk.editor
                    {
                        editor.enabled = !editor.enabled;
                        cx.notify();
                    }
                }),
            ))
            .child(
                div().flex().gap_2().children(
                    [
                        (DepositKind::Percent, Key::PolicyPercent),
                        (DepositKind::Fixed, Key::PolicyFixed),
                    ]
                    .into_iter()
                    .enumerate()
                    .map(|(index, (kind, label))| {
                        self.button(
                            ("policy-kind", index),
                            self.t(label),
                            if editor.kind == kind {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            },
                            cx.listener(move |root, _, _, cx| {
                                if let Overlay::BookingPolicy(desk) = &mut root.overlay
                                    && let Some(editor) = &mut desk.editor
                                {
                                    editor.kind = kind;
                                    cx.notify();
                                }
                            }),
                        )
                    }),
                ),
            )
            .children(INPUTS.iter().zip(&editor.controls).map(|(label, control)| {
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(div().text_sm().child(self.t(*label)))
                    .child(control.clone())
            }))
            .child(self.button(
                "policy-exempt",
                self.t(if editor.exempt {
                    Key::PolicyTrustedExempt
                } else {
                    Key::PolicyTrustedRequired
                }),
                if editor.exempt {
                    Kind::Primary
                } else {
                    Kind::Ghost
                },
                cx.listener(|root, _, _, cx| {
                    if let Overlay::BookingPolicy(desk) = &mut root.overlay
                        && let Some(editor) = &mut desk.editor
                    {
                        editor.exempt = !editor.exempt;
                        cx.notify();
                    }
                }),
            ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn a_policy_change_keeps_the_open_draft_and_requires_review(cx: &mut TestAppContext) {
        let (_directory, window) = super::super::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                let base: ReviewedBookingPolicy = serde_json::from_value(serde_json::json!({
                "generation": "initial", "policy": { "enabled": false, "depositKind": "percent",
                    "depositValue": 2500, "holdMinutes": 15, "cancellationWindowMinutes": 1440,
                    "lateCancellationBasisPoints": 0, "noShowBasisPoints": 0, "trustedExempt": true,
                    "version": 2 }
            })).unwrap();
                let editor = Editor::new(base, None, root.locale, cx);
                editor.controls[0].update(cx, |field, cx| field.set_text("30,50", cx));
                root.overlay = Overlay::BookingPolicy(Box::new(Desk {
                    identity: Arc::new(()),
                    editor: Some(editor),
                    busy: false,
                    status: None,
                    observed: Some(1),
                    blocked: false,
                    confirm_close: false,
                }));
                root.status.connectivity = Connectivity::Online;
                root.svc
                    .store
                    .set_meta("live_view:booking_policy", "3")
                    .unwrap();
                root.refresh_booking_policy(false, cx);
                root.save_booking_policy(cx);
                assert!(matches!(&root.overlay, Overlay::BookingPolicy(desk)
                if desk.blocked && !desk.busy && desk.status == Some(Key::PolicyChanged)
                    && desk.editor.as_ref().unwrap().proposed(cx).unwrap().deposit_value == 3050));
                root.dismiss_booking_policy(cx);
                assert!(
                    matches!(&root.overlay, Overlay::BookingPolicy(desk) if desk.confirm_close)
                );
            })
            .unwrap();
    }
}
