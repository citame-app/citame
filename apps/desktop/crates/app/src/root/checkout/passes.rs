use super::*;
use sob_core::billing::EligiblePassUse;

pub(super) enum PassPicker {
    Loading(Arc<()>),
    Loaded(Vec<EligiblePassUse>),
    Failed,
}

impl Root {
    fn load_receipt_passes(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let session = self.svc.session.clone();
        let Some(CheckoutReview::Receipt(form)) = self.checkout_review_mut() else {
            return;
        };
        if form.busy || form.refreshing || form.request.is_some() || !form.receipt.allows_pass() {
            return;
        }
        let request = Arc::new(());
        form.pass_picker = Some(PassPicker::Loading(request.clone()));
        let receipt = form.receipt.clone();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx.background_executor()
                .spawn(async move { transport.eligible_checkout_passes(&receipt) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() else {
                    return;
                };
                if !matches!(&form.pass_picker, Some(PassPicker::Loading(current)) if Arc::ptr_eq(current, &request)) {
                    return;
                }
                form.pass_picker = Some(match result {
                    Ok(choices) => PassPicker::Loaded(choices),
                    Err(_) => PassPicker::Failed,
                });
                cx.notify();
            });
        }).detach();
    }

    pub(super) fn render_pass_picker(
        &self,
        form: &ReceiptForm,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let view = div().flex().flex_col().gap_1().text_sm();
        match &form.pass_picker {
            Some(PassPicker::Loading(_)) => view.child(self.t(Key::CheckoutLoading)),
            Some(PassPicker::Loaded(choices)) if !choices.is_empty() => view
                .child(self.t(Key::CheckoutPassChoice))
                .children(choices.iter().enumerate().map(|(index, choice)| {
                    let choice = choice.clone();
                    self.button(
                        ("checkout-pass-use", index),
                        format!(
                            "{} · {} · {} · {}",
                            self.t(Key::CheckoutRedeemPass),
                            choice.name,
                            choice.description,
                            self.amount_label(
                                i64::from(choice.amount_cents),
                                &form.receipt.currency
                            ),
                        ),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            root.record_checkout_payment(
                                Some(PaymentAttempt::for_pass(&choice)),
                                cx,
                            );
                        }),
                    )
                })),
            state => view
                .when(state.is_some(), |view| {
                    view.child(self.t(if matches!(state, Some(PassPicker::Failed)) {
                        Key::CheckoutPassFailed
                    } else {
                        Key::CheckoutNoPasses
                    }))
                })
                .child(self.button(
                    "checkout-find-pass",
                    self.t(Key::CheckoutFindPass),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.load_receipt_passes(cx)),
                )),
        }
    }
}
