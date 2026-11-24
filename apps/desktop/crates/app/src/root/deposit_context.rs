use super::*;

pub(super) fn attendance_block_label(block: AttendanceProtectionBlock) -> Key {
    match block {
        AttendanceProtectionBlock::PendingDeposit => Key::DepositPendingAttendance,
        AttendanceProtectionBlock::ClosedProtection => Key::DepositClosedAttendance,
    }
}

impl Root {
    pub(super) fn render_appointment_protection(
        &self,
        protection: &AppointmentProtection,
        can_refresh: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        use AppointmentProtectionState::*;
        let state = match protection.state {
            Pending => Key::DepositPending,
            Confirmed => Key::DepositConfirmed,
            Waived => Key::DepositWaived,
            Completed => Key::DepositCompleted,
            Cancelled => Key::DepositCancelled,
            Expired => Key::DepositExpired,
            NoShow => Key::DepositNoShow,
            Unknown => Key::DepositUnknown,
        };
        let money = [
            (Key::DepositAmount, protection.deposit_cents),
            (Key::DepositFee, protection.fee_cents),
            (Key::DepositRefund, protection.refund_due_cents),
        ];
        div()
            .debug_selector(|| "appointment-protection".to_owned())
            .flex()
            .flex_col()
            .gap_1()
            .p_3()
            .rounded_md()
            .border_1()
            .border_color(theme::line())
            .bg(theme::accent_soft())
            .text_sm()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .child(div().font_weight(FontWeight::SEMIBOLD).child(self.t(Key::AppointmentDeposit)))
                    .when(can_refresh && self.status.connectivity == Connectivity::Online, |bar| {
                        bar.child(self.button(
                            "refresh-appointment-protection",
                            self.t(Key::DepositRefresh),
                            Kind::Ghost,
                            cx.listener(|this, _, _, cx| {
                                if matches!(&this.overlay, Overlay::Details(details) if matches!(details.annotations, Some(annotations::Annotations::Ready(_)))) {
                                    this.open_annotations(cx);
                                }
                            }),
                        ).tab_index(0).focus(|style| style.border_color(theme::text())))
                    }),
            )
            .child(self.t(state))
            .when(
                can_refresh && self.status.connectivity == Connectivity::Online
                    && protection.checkout_id.is_some(),
                |panel| {
                    panel.child(
                        self.button(
                            "open-deposit-receipt",
                            self.t(Key::DepositReceipt),
                            Kind::Ghost,
                            cx.listener(|this, _, _, cx| this.open_deposit_receipt(cx)),
                        )
                        .tab_index(0)
                        .focus(|style| style.border_color(theme::text()))
                        .debug_selector(|| "open-deposit-receipt".to_owned()),
                    )
                },
            )
            .children(money.into_iter().filter_map(|(label, amount)| {
                let amount = amount.filter(|value| *value > 0)?;
                Some(div().child(i18n::fill(
                    self.t(label),
                    &[("amount", &self.amount_label(amount, "EUR"))],
                )))
            }))
            .when(protection.state == Pending, |panel| {
                panel.child(div().child(i18n::fill(
                    self.t(Key::DepositExpires),
                    &[("date", &self.date_time_label(protection.expires_at))],
                )))
            })
            .when(matches!(protection.state, Pending | Confirmed), |panel| {
                panel.child(div().child(i18n::fill(
                    self.t(Key::DepositCancellationCutoff),
                    &[("date", &self.date_time_label(protection.cancellation_cutoff))],
                )))
            })
            .when_some(protection.attendance_block, |panel, block| {
                panel.child(div().text_color(theme::muted()).child(self.t(attendance_block_label(block))))
            })
    }
}
