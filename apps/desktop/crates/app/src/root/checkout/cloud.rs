use super::*;

impl ReceiptForm {
    pub(super) fn can_open_in_cloud(&self) -> bool {
        self.is_idle() && self.pass_picker.is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[gpui::test]
    async fn cloud_receipt_requires_a_connection_and_ignores_a_replaced_form(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_dir, config) = crate::root::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        let receipt = || {
            serde_json::from_value(json!({
                "id": Uuid::now_v7(), "currency": "EUR", "status": "open",
                "totalCents": 1800, "discountCents": 0, "paidCents": 0, "balanceCents": 1800,
                "payments": [],
            }))
            .unwrap()
        };
        root.update(cx, |root, cx| {
            root.svc.stop_sync();
            root.overlay = Overlay::WalkInReceipt(CheckoutReview::from_receipt(receipt(), 0, cx));
            root.status.connectivity = Connectivity::Offline;
            root.open_cloud_receipt(cx);
            assert!(matches!(
                root.checkout_review_mut(),
                Some(CheckoutReview::Receipt(form)) if form.cloud_opening.is_none()
            ));
            root.status.connectivity = Connectivity::Online;
            root.open_cloud_receipt(cx);
            assert!(matches!(
                root.checkout_review_mut(),
                Some(CheckoutReview::Receipt(form)) if form.cloud_opening.is_some()
            ));
            root.overlay = Overlay::WalkInReceipt(CheckoutReview::from_receipt(receipt(), 0, cx));
        });
        cx.run_until_parked();
        assert!(cx.opened_url().is_none());
        root.update(cx, |root, _| {
            assert!(matches!(
                root.checkout_review_mut(),
                Some(CheckoutReview::Receipt(form)) if form.error.is_none()
            ));
        });
    }
}

impl Root {
    fn open_cloud_receipt(&mut self, cx: &mut Context<Self>) {
        let Some(session) = self
            .svc
            .current_session()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let auth = self.svc.auth.clone();
        let session_handle = self.svc.session.clone();
        let user_id = session.user_id.clone();
        let Some(CheckoutReview::Receipt(form)) = self.checkout_review_mut() else {
            return;
        };
        if form.cloud_opening.is_some() || !form.can_open_in_cloud() {
            return;
        }
        let Ok(receipt_id) = form.receipt.id.parse() else {
            return;
        };
        let request = Arc::new(());
        form.cloud_opening = Some(request.clone());
        form.error = None;
        cx.notify();

        cx.spawn(async move |root, cx| {
            let handoff = cx
                .background_executor()
                .spawn(async move {
                    auth.begin_browser_receipt(&session, receipt_id)
                        .ok()
                        .flatten()
                })
                .await;
            let opened = root
                .update(cx, |root, cx| {
                    if !Arc::ptr_eq(&session_handle, &root.svc.session)
                        || !root
                            .svc
                            .current_session()
                            .is_some_and(|session| session.user_id == user_id)
                    {
                        return false;
                    }
                    let failure = root.t(Key::CheckoutCloudOpenFailed);
                    let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() else {
                        return false;
                    };
                    if !form.has_cloud_request(&request) {
                        return false;
                    }
                    if let Some(handoff) = &handoff
                        && form.can_open_in_cloud()
                    {
                        cx.open_url(&handoff.url());
                        return true;
                    }
                    form.cloud_opening = None;
                    form.error = Some(failure.into());
                    cx.notify();
                    false
                })
                .unwrap_or_default();
            if !opened {
                return;
            }
            let Some(handoff) = handoff else { return };
            let delivered = cx
                .background_executor()
                .spawn(async move { handoff.serve() })
                .await;
            let _ = root.update(cx, |root, cx| {
                let failure = root.t(Key::CheckoutCloudOpenFailed);
                if let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut()
                    && form.has_cloud_request(&request)
                {
                    form.cloud_opening = None;
                    if !delivered {
                        form.error = Some(failure.into());
                    }
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub(super) fn render_cloud_receipt(
        &self,
        form: &ReceiptForm,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        if form.cloud_opening.is_some() {
            return div().text_sm().child(self.t(Key::CheckoutLoading));
        }
        div().child(self.button(
            "checkout-open-cloud",
            self.t(Key::CheckoutCloudOpen),
            Kind::Ghost,
            cx.listener(|root, _, _, cx| root.open_cloud_receipt(cx)),
        ))
    }
}

impl ReceiptForm {
    fn has_cloud_request(&self, request: &Arc<()>) -> bool {
        self.cloud_opening
            .as_ref()
            .is_some_and(|pending| Arc::ptr_eq(pending, request))
    }
}
