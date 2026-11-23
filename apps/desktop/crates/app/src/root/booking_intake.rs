use super::intake_editor::{self, IntakeDraft};
use super::*;
use sob_core::booking::{
    BookingAttempt, BookingConfirmation, BookingError, BookingTerms, Cadence, PeakPriceQuote,
    Recurrence, ReviewedBooking, ReviewedSeries, SeriesPreview,
};
use sob_core::sync::TransportError;

pub(super) struct BookingReview {
    identity: Arc<()>,
    terms: BookingTerms,
    service_summary: Vec<String>,
    forms: Vec<IntakeDraft>,
    review_hash: Option<String>,
    peak_price: Option<PeakPriceQuote>,
    requires_explicit_confirmation: bool,
    submitted: Option<BookingAttempt>,
    series: Option<(SeriesPreview, ReviewedSeries)>,
    can_waive: bool,
    waiver: Entity<TextField>,
    busy: bool,
    restored: bool,
    saved_with_changes: bool,
    confirm_exit: bool,
}

impl BookingReview {
    pub(super) fn blocks_dismissal(&self) -> bool {
        self.submitted.is_some()
    }

    fn packet(&self, cx: &App) -> Option<ReviewedBooking> {
        let hash = self.review_hash.as_ref()?;
        let selection = intake_editor::selection(&self.forms, cx)?;
        Some(
            self.terms
                .reviewed(hash.clone(), selection)
                .with_peak_price_review(self.peak_price.as_ref()),
        )
    }
}

impl Root {
    pub(super) fn render_recurrence(
        &self,
        recurrence: Option<Recurrence>,
        override_notice: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let choices = [
            (None, Key::SeriesOnce),
            (Some(Cadence::Weekly), Key::SeriesWeekly),
            (Some(Cadence::Monthly), Key::SeriesMonthly),
        ];
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(self.label(Key::SeriesRepeat))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .children(
                        choices
                            .into_iter()
                            .enumerate()
                            .map(|(index, (cadence, key))| {
                                self.chip(
                                    ("series-cadence", index),
                                    SharedString::from(self.t(key)),
                                    recurrence.map(|value| value.cadence) == cadence,
                                    cx.listener(move |root, _, _, cx| {
                                        if let Overlay::New(form) = &mut root.overlay {
                                            form.recurrence = cadence.map(|cadence| Recurrence {
                                                cadence,
                                                interval: form.recurrence.map_or(1, |r| r.interval),
                                                count: form.recurrence.map_or(2, |r| r.count),
                                            });
                                            form.error = None;
                                        }
                                        cx.notify();
                                    }),
                                )
                                .tab_index(0)
                                .focus(|style| style.border_color(theme::text()))
                            }),
                    ),
            )
            .when_some(recurrence, |panel, r| {
                panel
                    .child(self.series_number(Some(r.cadence), r.interval, cx))
                    .child(self.series_number(None, r.count, cx))
                    .child(
                        div().flex().flex_wrap().child(
                            self.chip(
                                "series-override-notice",
                                self.t(Key::SeriesOverrideNotice),
                                override_notice,
                                cx.listener(|root, _, _, cx| {
                                    if let Overlay::New(form) = &mut root.overlay {
                                        form.series_override = !form.series_override;
                                        form.error = None;
                                        cx.notify();
                                    }
                                }),
                            )
                            .tab_index(0)
                            .focus(|style| style.border_color(theme::text())),
                        ),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme::muted())
                            .child(self.t(Key::SeriesOffline)),
                    )
            })
    }

    fn series_number(
        &self,
        cadence: Option<Cadence>,
        value: u8,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let interval = cadence.is_some();
        let minimum = if interval { 1 } else { 2 };
        let prefix = if interval {
            "series-interval"
        } else {
            "series-count"
        };
        let key = match cadence {
            Some(Cadence::Weekly) => Key::SeriesIntervalWeeks,
            Some(Cadence::Monthly) => Key::SeriesIntervalMonths,
            None => Key::SeriesCount,
        };
        let mut row = div()
            .flex()
            .gap_2()
            .items_center()
            .child(self.label(key))
            .child(value.to_string());
        for (index, (delta, label, enabled)) in [(-1, "−", value > minimum), (1, "+", value < 12)]
            .into_iter()
            .enumerate()
        {
            if enabled {
                row = row.child(
                    self.button(
                        (prefix, index),
                        label,
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            if let Overlay::New(form) = &mut root.overlay
                                && let Some(series) = &mut form.recurrence
                            {
                                let value = if interval {
                                    &mut series.interval
                                } else {
                                    &mut series.count
                                };
                                *value = value.saturating_add_signed(delta).clamp(minimum, 12);
                                form.error = None;
                                cx.notify();
                            }
                        }),
                    )
                    .tab_index(0)
                    .focus(|style| style.border_color(theme::text())),
                );
            }
        }
        row
    }

    pub(super) fn editable_intake_forms(&mut self) -> Option<&mut Vec<IntakeDraft>> {
        match &mut self.overlay {
            Overlay::Waitlist(desk) => desk.editable_intake(),
            Overlay::Directory(desk) => desk.intake.as_mut()?.editable(),
            Overlay::New(form) => {
                if let Some(review) = &mut form.visit_review {
                    return review.editable_forms();
                }
                let review = form.intake.as_mut()?;
                (!review.busy
                    && review.submitted.is_none()
                    && review.series.is_none()
                    && review.review_hash.is_some())
                .then_some(&mut review.forms)
            }
            _ => None,
        }
    }

    pub(super) fn set_intake_editor_error(&mut self, key: Key) {
        match &mut self.overlay {
            Overlay::Waitlist(desk) => desk.set_intake_error(key),
            Overlay::Directory(desk) => {
                if let Some(record) = &mut desk.intake {
                    record.error = Some(key);
                }
            }
            Overlay::New(form) => {
                if let Some(review) = &mut form.visit_review {
                    review.show_error(key);
                } else {
                    form.error = Some(key);
                }
            }
            _ => {}
        }
    }

    pub(super) fn start_booking_intake(&mut self, terms: BookingTerms, cx: &mut Context<Self>) {
        let waiver_label = self.t(Key::WaitlistWaiverReason);
        let requires_explicit_confirmation = terms.combination().is_some();
        let service_summary = terms
            .services()
            .iter()
            .map(|service| {
                format!(
                    "{} · {}",
                    service.name,
                    self.amount_label(service.price_cents, &service.currency)
                )
            })
            .collect();
        let Overlay::New(form) = &mut self.overlay else {
            return;
        };
        form.error = None;
        form.intake = Some(BookingReview {
            terms,
            service_summary,
            identity: Arc::new(()),
            forms: Vec::new(),
            review_hash: None,
            peak_price: None,
            requires_explicit_confirmation,
            submitted: None,
            series: None,
            can_waive: false,
            waiver: cx.new(|cx| TextField::new(waiver_label, false, cx)),
            busy: false,
            restored: false,
            saved_with_changes: false,
            confirm_exit: false,
        });
        self.fetch_booking_requirements(cx);
    }

    fn fetch_booking_requirements(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let Overlay::New(form) = &mut self.overlay else {
            return;
        };
        let Some(review) = form
            .intake
            .as_mut()
            .filter(|review| !review.busy && !review.restored && review.submitted.is_none())
        else {
            return;
        };
        let identity = review.identity.clone();
        let terms = review.terms.clone();
        let series = form.recurrence.is_some();
        let session = self.svc.session.clone();
        review.busy = true;
        review.review_hash = None;
        review.peak_price = None;
        review.series = None;
        form.error = None;
        cx.notify();
        cx.spawn(async move |view, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let requirements = transport.direct_booking_requirements(&terms)?;
                    let can_waive = series && transport.can_waive_deposit()?;
                    let peak_price = if series {
                        None
                    } else {
                        Some(transport.booking_peak_price(&terms)?)
                    };
                    Ok::<_, TransportError>((requirements, can_waive, peak_price))
                })
                .await;
            let _ = view.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || root.svc.current_session().is_none()
                {
                    return;
                }
                let Overlay::New(form) = &mut root.overlay else {
                    return;
                };
                let Some(review) = form
                    .intake
                    .as_mut()
                    .filter(|review| Arc::ptr_eq(&review.identity, &identity))
                else {
                    return;
                };
                review.busy = false;
                match result {
                    Ok((requirements, can_waive, peak_price)) => {
                        if peak_price
                            .as_ref()
                            .is_some_and(|quote| !review.terms.matches_price_quote(quote))
                        {
                            form.error = Some(Key::CombinationBookingChanged);
                            root.svc.wake(Wake::Manual);
                            cx.notify();
                            return;
                        }
                        let Some(generation) = requirements.desktop_generation.clone() else {
                            form.error = Some(Key::BookingIntakeUnavailable);
                            cx.notify();
                            return;
                        };
                        if review.terms.generation() != generation {
                            review.restored = true;
                            form.error = Some(Key::BookingIntakeRestore);
                            cx.notify();
                            return;
                        }
                        let hash = requirements.review_hash.clone();
                        intake_editor::refresh(&mut review.forms, requirements, root.locale, cx);
                        review.review_hash = Some(hash);
                        review.can_waive = can_waive;
                        review.requires_explicit_confirmation |= peak_price
                            .as_ref()
                            .is_some_and(|price| price.review.is_some());
                        review.peak_price = peak_price;
                        if review.forms.is_empty()
                            && !can_waive
                            && !review.requires_explicit_confirmation
                        {
                            root.confirm_booking_intake(cx);
                            return;
                        }
                    }
                    Err(_) => form.error = Some(Key::BookingIntakeUnavailable),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn confirm_booking_intake(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let Overlay::New(form) = &mut self.overlay else {
            return;
        };
        let Some(review) = form
            .intake
            .as_mut()
            .filter(|review| !review.busy && !review.restored)
        else {
            return;
        };
        let packet = review.submitted.clone().or_else(|| {
            if form.recurrence.is_some() {
                let (preview, series) = review.series.as_ref()?;
                preview
                    .occurrences
                    .iter()
                    .all(|visit| visit.available)
                    .then(|| BookingAttempt::Series(series.clone()))
            } else {
                review.packet(cx).map(BookingAttempt::Single)
            }
        });
        let Some(packet) = packet else {
            if form.recurrence.is_some() && review.submitted.is_none() {
                self.preview_booking_series(cx);
            }
            return;
        };
        if let Err(error) = packet.check_before_dispatch(&mut self.svc.store) {
            if matches!(error, CoreError::CalendarGenerationChanged) {
                review.submitted = None;
                review.restored = true;
                form.error = Some(Key::BookingIntakeRestore);
                self.svc.wake(Wake::Manual);
            } else {
                form.error = Some(Key::ErrGeneric);
            }
            cx.notify();
            return;
        }
        let retrying_pending = review.submitted.is_some();
        let identity = review.identity.clone();
        let session = self.svc.session.clone();
        review.busy = true;
        review.submitted = Some(packet.clone());
        review.confirm_exit = false;
        form.error = None;
        cx.notify();
        cx.spawn(async move |view, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.create_booking_attempt(&packet) })
                .await;
            let _ = view.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || root.svc.current_session().is_none()
                {
                    return;
                }
                if result.is_ok() {
                    root.svc.wake(Wake::Manual);
                }
                let Overlay::New(form) = &mut root.overlay else {
                    return;
                };
                let Some(review) = form
                    .intake
                    .as_mut()
                    .filter(|review| Arc::ptr_eq(&review.identity, &identity))
                else {
                    return;
                };
                review.busy = false;
                match result {
                    Ok(BookingConfirmation::Booked(starts_at)) => {
                        root.finish_new_booking(starts_at, cx);
                        return;
                    }
                    Ok(BookingConfirmation::SeriesChanged) => {
                        review.saved_with_changes = true;
                        review.submitted = None;
                    }
                    Err(BookingError::IntakeChanged) => {
                        review.submitted = None;
                        review.review_hash = None;
                        review.series = None;
                        form.error = Some(Key::WaitlistFormsChanged);
                    }
                    Err(BookingError::SlotUnavailable) => {
                        if form.recurrence.is_some() {
                            review.submitted = None;
                            review.series = None;
                            form.error = Some(Key::SeriesSlotChanged);
                        } else {
                            form.intake = None;
                            form.error = Some(Key::ConflictSlotTaken);
                        }
                    }
                    Err(BookingError::PeakPriceChanged) => {
                        review.submitted = None;
                        review.series = None;
                        review.review_hash = None;
                        review.peak_price = None;
                        review.requires_explicit_confirmation = true;
                        form.error = Some(Key::PeakPriceChanged);
                    }
                    Err(BookingError::CatalogueChanged) => {
                        form.intake = None;
                        form.error = Some(Key::ErrRefreshCatalog);
                        root.svc.wake(Wake::Manual);
                    }
                    Err(BookingError::IntentConflict) => {
                        review.submitted = None;
                        review.restored = true;
                        form.error = Some(Key::BookingIntakeIntentConflict);
                        root.svc.wake(Wake::Manual);
                    }
                    Err(BookingError::AccessChanged) => {
                        if !retrying_pending {
                            form.intake = None;
                        }
                        form.error = Some(Key::BookingIntakeAccessChanged);
                    }
                    Err(BookingError::Transport(TransportError::ReplicaGenerationChanged)) => {
                        review.submitted = None;
                        review.restored = true;
                        form.error = Some(Key::BookingIntakeRestore);
                        root.svc.wake(Wake::Manual);
                    }
                    Err(BookingError::Rejected) => {
                        review.submitted = None;
                        review.series = None;
                        form.error = Some(Key::BookingIntakeRejected);
                    }
                    Err(_) => form.error = Some(Key::BookingIntakeUnconfirmed),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn preview_booking_series(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let Overlay::New(form) = &mut self.overlay else {
            return;
        };
        let (Some(recurrence), Some(review)) = (form.recurrence, &mut form.intake) else {
            return;
        };
        if review.busy || review.restored || review.submitted.is_some() {
            return;
        }
        let Some(packet) = review.packet(cx).map(|packet| packet.series(recurrence)) else {
            return;
        };
        let reason = review.waiver.read(cx).text().trim().to_owned();
        let reason = (review.can_waive && !reason.is_empty()).then_some(reason);
        if reason
            .as_ref()
            .is_some_and(|reason| !(8..=300).contains(&reason.encode_utf16().count()))
        {
            form.error = Some(Key::WaitlistWaiverReason);
            cx.notify();
            return;
        }
        let packet = packet.with_deposit_waiver(reason);
        review.series = None;
        review.busy = true;
        form.error = None;
        let identity = review.identity.clone();
        let session = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |view, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    transport.preview_booking_series(&packet).map(|preview| {
                        let reviewed = packet.review(&preview);
                        (preview, reviewed)
                    })
                })
                .await;
            let _ = view.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || root.svc.current_session().is_none()
                {
                    return;
                }
                let Overlay::New(form) = &mut root.overlay else {
                    return;
                };
                let Some(review) = form
                    .intake
                    .as_mut()
                    .filter(|review| Arc::ptr_eq(&review.identity, &identity))
                else {
                    return;
                };
                review.busy = false;
                match result {
                    Ok(series) => review.series = Some(series),
                    Err(BookingError::CatalogueChanged) => {
                        form.intake = None;
                        form.error = Some(Key::ErrRefreshCatalog);
                        root.svc.wake(Wake::Manual);
                    }
                    Err(BookingError::Transport(TransportError::ReplicaGenerationChanged)) => {
                        review.restored = true;
                        form.error = Some(Key::BookingIntakeRestore);
                        root.svc.wake(Wake::Manual);
                    }
                    Err(BookingError::AccessChanged) => {
                        form.error = Some(Key::BookingIntakeAccessChanged)
                    }
                    Err(_) => form.error = Some(Key::SeriesPreviewFailed),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn back_from_booking_intake(&mut self, cx: &mut Context<Self>) {
        if let Overlay::New(form) = &mut self.overlay
            && form
                .intake
                .as_ref()
                .is_some_and(|review| !review.blocks_dismissal())
        {
            form.intake = None;
            form.error = None;
            cx.notify();
        }
    }

    pub(super) fn render_booking_intake(
        &self,
        form: &NewForm,
        review: &BookingReview,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        if review.saved_with_changes {
            return self.modal_with_height(
                div()
                    .child(self.label(Key::SeriesSaved))
                    .child(self.t(Key::SeriesSavedWithChanges))
                    .child(
                        self.button(
                            "series-saved-close",
                            self.t(Key::Close),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
                        )
                        .tab_index(0)
                        .focus(|style| style.border_color(theme::text())),
                    ),
                (viewport.width - px(24.)).clamp(px(0.), px(440.)),
                (viewport.height - px(24.)).clamp(px(0.), px(240.)),
                None,
            );
        }
        let online = self.status.connectivity == Connectivity::Online;
        let awaiting = review.submitted.is_some();
        let mut body = div()
            .id("booking-intake-scroll")
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .text_sm()
                    .child(self.date_time_label(review.terms.starts_at())),
            );
        let adjusted = review
            .peak_price
            .as_ref()
            .filter(|quote| quote.review.is_some());
        if let Some(quote) = adjusted {
            body = body.children(review.terms.services().iter().map(|service| {
                let line = quote
                    .services
                    .iter()
                    .find(|line| service.service_id.as_deref() == Some(line.service_id.as_str()));
                let price = line.map_or(service.price_cents, |line| line.price_cents);
                let amount = self.amount_label(price, &service.currency);
                div()
                    .text_sm()
                    .child(format!("{} · {amount}", service.name))
                    .when_some(line.filter(|line| line.surcharge_cents > 0), |row, line| {
                        let amount = self.amount_label(line.surcharge_cents, &service.currency);
                        row.child(div().text_color(theme::muted()).child(i18n::fill(
                            self.t(Key::PeakPriceSurcharge),
                            &[("amount", &amount)],
                        )))
                    })
            }));
        } else {
            body = body.children(
                review
                    .service_summary
                    .iter()
                    .map(|summary| div().text_sm().child(summary.clone())),
            );
        }
        if !awaiting
            && review.series.is_none()
            && review.review_hash.is_some()
            && !review.restored
            && !review.busy
        {
            if review.can_waive {
                body = body
                    .child(self.label(Key::SeriesWaiver))
                    .child(review.waiver.clone());
            }
            for draft in &review.forms {
                body = body.child(self.render_intake_form(draft, cx));
            }
        }
        if form.recurrence.is_some() && !review.forms.is_empty() {
            body = body.child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.t(Key::SeriesAnswers)),
            );
        }
        if review.busy {
            body = body.child(self.t(Key::SeriesWorking));
        }
        if let Some((preview, _)) = &review.series {
            let tz = preview.timezone.parse().unwrap_or(self.tz);
            let price = self.amount_label(preview.per_visit_cents, &preview.currency);
            let has_surcharge = preview
                .occurrences
                .iter()
                .any(|visit| visit.peak_surcharge_cents.is_some());
            if !has_surcharge {
                body = body.child(i18n::fill(self.t(Key::SeriesPrice), &[("price", &price)]));
            }
            if preview.policy.enabled {
                body = body.child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(self.t(Key::SeriesDepositPolicy)),
                );
            }
            body = body.children(preview.occurrences.iter().map(|visit| {
                let local = visit.starts_at.with_timezone(&tz);
                let end = visit.ends_at.with_timezone(&tz);
                let date = i18n::date_label(self.locale, local.date_naive());
                div()
                    .flex()
                    .flex_wrap()
                    .justify_between()
                    .gap_2()
                    .p_2()
                    .rounded_md()
                    .bg(theme::bg())
                    .child(format!(
                        "{date} · {}–{}",
                        local.format("%H:%M"),
                        end.format("%H:%M")
                    ))
                    .when(has_surcharge, |row| {
                        let amount = self.amount_label(
                            visit.price_cents.unwrap_or(preview.per_visit_cents),
                            &preview.currency,
                        );
                        row.child(amount)
                            .when_some(visit.peak_surcharge_cents, |row, surcharge| {
                                let amount = self.amount_label(surcharge, &preview.currency);
                                row.child(i18n::fill(
                                    self.t(Key::PeakPriceSurcharge),
                                    &[("amount", &amount)],
                                ))
                            })
                    })
                    .child(
                        div()
                            .text_color(if visit.available {
                                theme::muted()
                            } else {
                                theme::conflict_fg()
                            })
                            .child(self.t(if visit.available {
                                Key::SeriesAvailable
                            } else {
                                Key::SeriesUnavailable
                            })),
                    )
            }));
        }
        let mut actions = div().flex_none().flex().flex_wrap().gap_2();
        if !awaiting {
            actions = actions.child(
                self.button(
                    "booking-review-back",
                    self.t(Key::Back),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.back_from_booking_intake(cx)),
                )
                .tab_index(0)
                .focus(|style| style.border_color(theme::text())),
            );
        }
        if awaiting && !review.busy {
            actions = actions.child(
                self.button(
                    "booking-review-exit",
                    self.t(if review.confirm_exit {
                        Key::BookingIntakeExitConfirm
                    } else {
                        Key::BookingIntakeExit
                    }),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.exit_unconfirmed_booking(cx)),
                )
                .tab_index(0)
                .focus(|style| style.border_color(theme::text())),
            );
        }
        if online && !review.busy && !review.restored {
            if !awaiting && (review.review_hash.is_none() || !review.forms.is_empty()) {
                actions = actions.child(
                    self.button(
                        "booking-review-reload",
                        self.t(Key::WaitlistRefreshForms),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.fetch_booking_requirements(cx)),
                    )
                    .tab_index(0)
                    .focus(|style| style.border_color(theme::text())),
                );
            }
            if !awaiting && review.series.is_some() {
                actions = actions.child(self.button(
                    "booking-series-refresh",
                    self.t(Key::SeriesRefresh),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.preview_booking_series(cx)),
                ));
                if review.can_waive || !review.forms.is_empty() {
                    actions = actions.child(
                        self.button(
                            "booking-series-edit",
                            self.t(Key::SeriesEditReview),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| {
                                if let Overlay::New(form) = &mut root.overlay
                                    && let Some(review) = &mut form.intake
                                    && !review.busy
                                    && review.submitted.is_none()
                                {
                                    review.series = None;
                                    form.error = None;
                                    cx.notify();
                                }
                            }),
                        )
                        .tab_index(0)
                        .focus(|style| style.border_color(theme::text()))
                        .debug_selector(|| "booking-series-edit".to_owned()),
                    );
                }
            }
            let ready = match &review.series {
                Some((preview, _)) => preview.occurrences.iter().all(|visit| visit.available),
                None => review.packet(cx).is_some(),
            };
            if awaiting || ready {
                actions = actions.child(
                    self.button(
                        "booking-review-confirm",
                        self.t(if awaiting {
                            Key::WaitlistRetryAcceptance
                        } else if review.series.is_some() {
                            Key::SeriesConfirm
                        } else if form.recurrence.is_some() {
                            Key::SeriesReview
                        } else {
                            Key::WaitlistAcceptOffer
                        }),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.confirm_booking_intake(cx)),
                    )
                    .tab_index(0)
                    .focus(|style| style.border_color(theme::text()))
                    .debug_selector(|| "booking-review-confirm".to_owned()),
                );
            }
        }
        self.modal_with_height(
            div()
                .child(
                    div()
                        .flex_none()
                        .text_xl()
                        .font_weight(FontWeight::BOLD)
                        .child(self.t(if form.recurrence.is_some() {
                            Key::SeriesReview
                        } else {
                            Key::BookingIntakeTitle
                        })),
                )
                .child(body)
                .when_some(form.error, |panel, error| {
                    panel.child(
                        div()
                            .flex_none()
                            .text_sm()
                            .text_color(theme::conflict_fg())
                            .child(self.t(error)),
                    )
                })
                .when(!online, |panel| {
                    panel.child(self.t(Key::BookingIntakeOffline))
                })
                .child(actions),
            (viewport.width - px(24.)).clamp(px(0.), px(660.)),
            (viewport.height - px(24.)).clamp(px(0.), px(720.)),
            None,
        )
    }

    fn exit_unconfirmed_booking(&mut self, cx: &mut Context<Self>) {
        let Overlay::New(form) = &mut self.overlay else {
            return;
        };
        let Some(review) = form
            .intake
            .as_mut()
            .filter(|review| !review.busy && review.submitted.is_some())
        else {
            return;
        };
        if review.confirm_exit {
            self.overlay = Overlay::None;
            self.svc.wake(Wake::Manual);
        } else {
            review.confirm_exit = true;
            form.error = Some(Key::BookingIntakeExitHelp);
        }
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[gpui::test]
    async fn a_calendar_booking_requires_confirmation_and_keeps_answers_out_of_the_outbox(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_dir, config) = crate::root::tests::desk();
        let (entity, cx) = cx.add_window_view(|window, cx| {
            let mut root = Root::new(config, window, cx);
            root.svc.stop_sync();
            root.status.connectivity = Connectivity::Online;
            root.open_new(window, cx);
            root
        });
        entity.update(cx, |root, cx| {
            let staff_id = root.staff[0].id.clone();
            let service_id = ops::performed_services(&root.svc.store, &staff_id).unwrap().remove(0);
            let terms = BookingTerms::prepare(&root.svc.store, NewAppointment {
                staff_id, service_ids: vec![service_id], client_id: root.clients[0].0.clone(),
                starts_at: "2026-03-09T13:00:00Z".parse().unwrap(), notes: None, override_notice: false,
            }, None).unwrap();
            root.start_booking_intake(terms, cx);
            let Overlay::New(form) = &mut root.overlay else { panic!("missing booking editor"); };
            let review = form.intake.as_mut().unwrap();
            review.review_hash = Some("a".repeat(64));
            let revision = serde_json::from_value(json!({
                "id":"rev","definition":{"title":"Synthetic calendar form","description":"",
                    "requiredAtBooking":true,"allowTeamResponses":true,"fields":[
                        {"id":"q","label":"Do you agree?","help":"","kind":"boolean","required":true}
                    ]}
            })).unwrap();
            review.forms = vec![IntakeDraft::new(revision, None, root.locale, cx)];
            cx.notify();
        });
        let click = |cx: &mut gpui::VisualTestContext, selector| {
            cx.run_until_parked();
            let bounds = cx
                .debug_bounds(selector)
                .unwrap_or_else(|| panic!("missing {selector}"));
            cx.simulate_click(bounds.center(), Default::default());
            cx.run_until_parked();
        };
        click(cx, "intake-rev-q-false");
        assert!(cx.debug_bounds("booking-review-confirm").is_none());
        click(cx, "intake-confirm-rev");
        assert!(cx.debug_bounds("booking-review-confirm").is_some());
        entity.update(cx, |root, cx| {
            let Overlay::New(form) = &mut root.overlay else {
                panic!("missing booking editor");
            };
            let review = form.intake.as_mut().unwrap();
            let payload = serde_json::to_value(review.packet(cx).unwrap()).unwrap();
            assert_eq!(payload["intakeResponses"][0]["answers"]["q"], false);
            let recurrence = Recurrence {
                cadence: Cadence::Monthly,
                interval: 2,
                count: 4,
            };
            let packet = review.packet(cx).unwrap().series(recurrence);
            let wire = serde_json::to_value(&packet).unwrap();
            assert_eq!(wire["cadence"], "monthly");
            assert_eq!(wire["count"], 4);
            assert_eq!(wire["interval"], 2);
            assert_eq!(wire["desktopGeneration"], payload["desktopGeneration"]);
            assert_eq!(wire["intakeReviewHash"], payload["intakeReviewHash"]);
            assert_eq!(wire["intakeResponses"], payload["intakeResponses"]);
            assert!(wire.get("id").is_none());
            assert!(root.svc.store.outbox(10).unwrap().is_empty());
            let preview: SeriesPreview = serde_json::from_value(json!({
                "reviewHash": "a".repeat(64), "timezone": "Europe/Madrid",
                "perVisitCents": 2500, "currency": "EUR", "policy": {"enabled": true},
                "occurrences": [{
                    "startsAt": "2026-03-09T13:00:00Z", "endsAt": "2026-03-09T14:00:00Z", "available": false
                }]
            })).unwrap();
            let reviewed = packet.review(&preview);
            form.recurrence = Some(recurrence);
            review.series = Some((preview, reviewed));
            cx.notify();
        });
        cx.run_until_parked();
        assert!(cx.debug_bounds("booking-review-confirm").is_none());
        click(cx, "booking-series-edit");
        assert!(cx.debug_bounds("booking-review-confirm").is_some());
        entity.update(cx, |root, cx| {
            let Overlay::New(form) = &root.overlay else {
                panic!("missing booking editor");
            };
            let review = form.intake.as_ref().unwrap();
            assert!(review.series.is_none());
            let payload = serde_json::to_value(review.packet(cx).unwrap()).unwrap();
            assert_eq!(payload["intakeResponses"][0]["answers"]["q"], false);
        });
    }
}
