use super::*;

pub(super) fn attendance_block_label(block: AttendanceProtectionBlock) -> Key {
    match block {
        AttendanceProtectionBlock::PendingDeposit => Key::DepositPendingAttendance,
        AttendanceProtectionBlock::ClosedProtection => Key::DepositClosedAttendance,
    }
}

pub(super) struct DepositView<'a> {
    pub(super) status: AppointmentDepositStatus,
    pub(super) private: Option<&'a AppointmentProtection>,
}

impl Details {
    pub(super) fn has_newer_context(&self, appointment: Option<&Appointment>) -> bool {
        self.annotations
            .as_ref()
            .and_then(annotations::Annotations::context)
            .and_then(|context| context.appointment_version)
            .zip(appointment)
            .is_some_and(|(version, appointment)| version > appointment.version)
    }

    pub(super) fn deposit_view(
        &self,
        appointment: Option<&Appointment>,
    ) -> Option<DepositView<'_>> {
        let context = self
            .annotations
            .as_ref()
            .and_then(annotations::Annotations::context);
        let live = context.and_then(|context| context.protection.as_ref());
        let replica = appointment.and_then(|appointment| appointment.deposit_status);
        if let Some(status) = replica
            && !context
                .and_then(|context| context.appointment_version)
                .is_some_and(|version| {
                    appointment.is_some_and(|appointment| version >= appointment.version)
                })
        {
            return Some(DepositView {
                status,
                private: None,
            });
        }
        live.map(|protection| DepositView {
            status: protection.status,
            private: Some(protection),
        })
        .or_else(|| {
            replica.map(|status| DepositView {
                status,
                private: None,
            })
        })
    }
}

impl Root {
    pub(super) fn render_appointment_protection(
        &self,
        deposit: &DepositView<'_>,
        can_refresh: bool,
        can_open_receipt: bool,
        awaiting_sync: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        use AppointmentProtectionState::*;
        let status = deposit.status;
        let online = self.status.connectivity == Connectivity::Online;
        let protection = deposit.private.filter(|_| online);
        let state_label = match status.state {
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
            (Key::DepositAmount, protection.and_then(|p| p.deposit_cents)),
            (Key::DepositFee, protection.and_then(|p| p.fee_cents)),
            (
                Key::DepositRefund,
                protection.and_then(|p| p.refund_due_cents),
            ),
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
                    .when(can_refresh && online, |bar| {
                        bar.child(self.button(
                            "refresh-appointment-protection",
                            self.t(Key::DepositRefresh),
                            Kind::Ghost,
                            cx.listener(|this, _, _, cx| {
                                if matches!(&this.overlay, Overlay::Details(details) if !matches!(details.annotations, Some(annotations::Annotations::Loading { .. } | annotations::Annotations::Editing(_)))) {
                                    this.open_annotations(cx);
                                }
                            }),
                        ).tab_index(0).focus(|style| style.border_color(theme::text())))
                    }),
            )
            .child(self.t(state_label))
            .when(protection.is_none(), |panel| {
                panel.child(div().text_color(theme::muted()).child(self.t(
                    if deposit.private.is_some() {
                        Key::DepositLastChecked
                    } else {
                        Key::DepositLastSynced
                    },
                )))
            })
            .when(awaiting_sync, |panel| {
                panel.child(div().text_color(theme::muted()).child(self.t(Key::DepositAwaitingSync)))
            })
            .when(
                can_open_receipt,
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
            .when(status.state == Pending, |panel| {
                panel.child(div().child(i18n::fill(
                    self.t(Key::DepositExpires),
                    &[("date", &self.date_time_label(status.expires_at))],
                )))
            })
            .when(matches!(status.state, Pending | Confirmed), |panel| {
                panel.child(div().child(i18n::fill(
                    self.t(Key::DepositCancellationCutoff),
                    &[("date", &self.date_time_label(status.cancellation_cutoff))],
                )))
            })
            .when_some(status.attendance_block, |panel, block| {
                panel.child(div().text_color(theme::muted()).child(self.t(attendance_block_label(block))))
            })
    }
}
