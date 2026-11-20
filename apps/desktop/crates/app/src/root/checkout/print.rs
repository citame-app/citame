use super::*;
use sob_core::receipt_print::ReceiptPreview;

impl Root {
    fn open_receipt_print(&mut self, cx: &mut Context<Self>) {
        let salon = self.svc.store.salon_settings().ok().flatten();
        let timezone = self.tz;
        let locale = self.locale;
        let failure = self.t(Key::PrintReceiptFailed);
        let Some(CheckoutReview::Receipt(form)) = self.checkout_review_mut() else {
            return;
        };
        if form.print_opening.is_some()
            || form.busy
            || form.refreshing
            || form.request.is_some()
            || form.refund.is_some()
            || form.stock_return.is_some()
            || form.confirming_void
        {
            return;
        }
        let request = Arc::new(());
        form.print_opening = Some(request.clone());
        form.error = None;
        let receipt = form.receipt.clone();
        let session = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let preview = cx
                .background_executor()
                .spawn(async move {
                    let name = salon.as_ref().map_or("Citame", |salon| salon.name.as_str());
                    ReceiptPreview::new(&receipt, name, timezone, locale)
                })
                .await;
            let opened = root
                .update(cx, |root, cx| {
                    if !Arc::ptr_eq(&session, &root.svc.session)
                        || root.svc.current_session().is_none()
                    {
                        return false;
                    }
                    let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() else {
                        return false;
                    };
                    if !form
                        .print_opening
                        .as_ref()
                        .is_some_and(|pending| Arc::ptr_eq(pending, &request))
                    {
                        return false;
                    }
                    if let Ok(preview) = &preview {
                        cx.open_url(&preview.url());
                        true
                    } else {
                        form.print_opening = None;
                        form.error = Some(failure.into());
                        cx.notify();
                        false
                    }
                })
                .unwrap_or_default();
            let Ok(preview) = preview else { return };
            if !opened {
                return;
            }
            let delivered = cx
                .background_executor()
                .spawn(async move { preview.serve() })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let Some(CheckoutReview::Receipt(form)) = root.checkout_review_mut() else {
                    return;
                };
                if form
                    .print_opening
                    .as_ref()
                    .is_some_and(|pending| Arc::ptr_eq(pending, &request))
                {
                    form.print_opening = None;
                    if !delivered {
                        form.error = Some(failure.into());
                    }
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub(super) fn render_print_receipt(
        &self,
        form: &ReceiptForm,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        if form.print_opening.is_some() {
            return div().text_sm().child(self.t(Key::CheckoutLoading));
        }
        div().child(self.button(
            "checkout-print",
            self.t(Key::PrintReceipt),
            Kind::Ghost,
            cx.listener(|root, _, _, cx| root.open_receipt_print(cx)),
        ))
    }
}
