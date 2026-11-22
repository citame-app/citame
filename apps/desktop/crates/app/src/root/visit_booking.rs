use super::intake_editor::{self, IntakeDraft};
use super::*;
use sob_core::booking::BookingError;
use sob_core::booking::visit::{
    ReviewedVisit, VisitConfirmation, VisitPartReview, VisitPartSelection, VisitPreview,
    VisitPriceStatus, VisitSelection, VisitTerms,
};
use sob_core::sync::TransportError;

struct PartReview {
    hash: String,
    forms: Vec<IntakeDraft>,
    waiver: Entity<TextField>,
}

pub(super) struct VisitDesk {
    terms: VisitTerms,
    stages: Vec<PartReview>,
    active: usize,
    identity: Arc<()>,
    busy: bool,
    can_waive: bool,
    preview: Option<VisitPreview>,
    packet: Option<ReviewedVisit>,
    submitted: bool,
    confirm_exit: bool,
    saved_changed: bool,
    error: Option<Key>,
}

impl VisitDesk {
    pub(super) fn blocks_dismissal(&self) -> bool {
        self.submitted
    }

    pub(super) fn editable_forms(&mut self) -> Option<&mut Vec<IntakeDraft>> {
        if self.busy || self.preview.is_some() || self.submitted || self.saved_changed {
            return None;
        }
        self.stages.get_mut(self.active).map(|part| &mut part.forms)
    }

    pub(super) fn show_error(&mut self, key: Key) {
        self.error = Some(key);
    }

    fn reviews(&self, cx: &App) -> Option<Vec<VisitPartReview>> {
        if self.stages.len() != self.terms.parts().len() {
            return None;
        }
        self.stages
            .iter()
            .map(|stage| {
                let reason = stage.waiver.read(cx).text().trim().to_owned();
                let reason = (self.can_waive && !reason.is_empty()).then_some(reason);
                if reason
                    .as_ref()
                    .is_some_and(|value| !(8..=300).contains(&value.encode_utf16().count()))
                {
                    return None;
                }
                Some(VisitPartReview {
                    intake_hash: stage.hash.clone(),
                    intake: intake_editor::selection(&stage.forms, cx)?,
                    protection_waiver_reason: reason,
                })
            })
            .collect()
    }
}

impl Root {
    fn visit_button(
        &self,
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        kind: Kind,
        on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Stateful<gpui::Div> {
        self.button(id, label, kind, on_click)
            .tab_index(0)
            .focus(|style| style.border_color(theme::text()))
    }

    pub(super) fn add_visit_part(&mut self, cx: &mut Context<Self>) {
        let Overlay::New(form) = &mut self.overlay else {
            return;
        };
        let Some(staff_id) = form.staff_id.clone() else {
            return;
        };
        if form.recurrence.is_some() || form.services.is_empty() || form.visit_parts.len() >= 7 {
            return;
        }
        form.visit_parts.push(VisitPartSelection {
            staff_id,
            service_ids: std::mem::take(&mut form.services),
        });
        form.visit_quotes.append(&mut form.selected_quotes);
        form.staff_id = None;
        form.service_search
            .update(cx, |field, cx| field.set_text("", cx));
        form.error = None;
        cx.notify();
    }

    fn remove_visit_part(&mut self, index: usize, cx: &mut Context<Self>) {
        let Overlay::New(form) = &mut self.overlay else {
            return;
        };
        if index >= form.visit_parts.len() {
            return;
        }
        let removed = form.visit_parts.remove(index);
        form.visit_quotes
            .retain(|id, _| !removed.service_ids.contains(id));
        form.error = None;
        cx.notify();
    }

    pub(super) fn render_visit_parts(&self, form: &NewForm, cx: &mut Context<Self>) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(self.label(Key::VisitSteps))
            .children(form.visit_parts.iter().enumerate().map(|(index, part)| {
                let services = part
                    .service_ids
                    .iter()
                    .filter_map(|id| self.services.iter().find(|service| &service.id == id))
                    .map(|service| service.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .min_w_0()
                            .child(self.staff_name(&part.staff_id))
                            .child(div().text_sm().text_color(theme::muted()).child(services)),
                    )
                    .child(self.visit_button(
                        ("remove-visit-step", index),
                        self.t(Key::VisitRemoveStep),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| root.remove_visit_part(index, cx)),
                    ))
            }))
    }

    pub(super) fn review_grouped_visit(&mut self, cx: &mut Context<Self>) {
        let online =
            self.status.connectivity == Connectivity::Online && self.svc.transport().is_some();
        let Overlay::New(form) = &mut self.overlay else {
            return;
        };
        if form.visit_review.is_some() {
            return;
        }
        let selection = (|| {
            if !online {
                return Err(Key::VisitOffline);
            }
            let client_id = form.client_id.clone().ok_or(Key::VisitExistingClient)?;
            let mut parts = form.visit_parts.clone();
            if !form.services.is_empty() {
                parts.push(VisitPartSelection {
                    staff_id: form.staff_id.clone().ok_or(Key::ErrPickStaff)?,
                    service_ids: form.services.clone(),
                });
            }
            if parts.len() < 2 {
                return Err(Key::VisitNeedsSteps);
            }
            let starts_at = salon_local_instant(self.tz, form.date, form.minutes)
                .ok_or(Key::ErrInvalidLocalStart)?;
            if let Some(end) = form.selected_end {
                let end =
                    salon_local_instant(self.tz, form.date, end).ok_or(Key::SelectedSlotInvalid)?;
                let duration: i64 = parts
                    .iter()
                    .flat_map(|part| &part.service_ids)
                    .filter_map(|id| self.services.iter().find(|service| &service.id == id))
                    .map(|service| service.duration_minutes + service.buffer_minutes)
                    .sum();
                if end <= starts_at || (end - starts_at).num_minutes() < duration {
                    return Err(Key::SelectedSlotTooShort);
                }
            }
            let notes = form.notes.read(cx).text().trim().to_owned();
            Ok(VisitSelection {
                client_id,
                starts_at,
                notes: (!notes.is_empty()).then_some(notes),
                parts,
            })
        })();
        let terms = selection.and_then(|selection| {
            VisitTerms::prepare(&self.svc.store, selection).map_err(|_| Key::VisitReviewChanged)
        });
        match terms {
            Ok(terms)
                if terms.parts().iter().all(|part| {
                    part.service_ids().iter().all(|id| {
                        form.visit_quotes
                            .get(id)
                            .or_else(|| form.selected_quotes.get(id))
                            .is_some_and(|quote| part.matches_service_quote(id, quote))
                    })
                }) =>
            {
                form.error = None;
                form.visit_review = Some(Box::new(VisitDesk {
                    terms,
                    stages: Vec::new(),
                    active: 0,
                    identity: Arc::new(()),
                    busy: false,
                    can_waive: false,
                    preview: None,
                    packet: None,
                    submitted: false,
                    confirm_exit: false,
                    saved_changed: false,
                    error: None,
                }));
                self.load_visit_requirements(cx);
            }
            Ok(_) => form.error = Some(Key::VisitReviewChanged),
            Err(key) => form.error = Some(key),
        }
        cx.notify();
    }

    fn visit_desk(&mut self) -> Option<&mut VisitDesk> {
        let Overlay::New(form) = &mut self.overlay else {
            return None;
        };
        form.visit_review.as_deref_mut()
    }

    fn load_visit_requirements(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let session = self.svc.session.clone();
        let Some(review) = self
            .visit_desk()
            .filter(|desk| !desk.busy && !desk.submitted)
        else {
            return;
        };
        let identity = review.identity.clone();
        let terms = review.terms.parts().to_vec();
        review.busy = true;
        review.error = None;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let can_waive = transport.can_waive_deposit()?;
                    let requirements = terms
                        .iter()
                        .map(|part| {
                            let response = transport.direct_booking_requirements(part)?;
                            if response.desktop_generation.as_deref() != Some(part.generation()) {
                                return Err(TransportError::ReplicaGenerationChanged);
                            }
                            Ok(response)
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok::<_, TransportError>((requirements, can_waive))
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || root.svc.current_session().is_none()
                {
                    return;
                }
                let locale = root.locale;
                let waiver_label = root.t(Key::WaitlistWaiverReason);
                let Some(review) = root
                    .visit_desk()
                    .filter(|desk| Arc::ptr_eq(&identity, &desk.identity))
                else {
                    return;
                };
                review.busy = false;
                match result {
                    Ok((requirements, can_waive)) => {
                        review.can_waive = can_waive;
                        if review.stages.is_empty() {
                            review.stages = requirements
                                .iter()
                                .map(|request| PartReview {
                                    hash: request.review_hash.clone(),
                                    forms: Vec::new(),
                                    waiver: cx.new(|cx| TextField::new(waiver_label, false, cx)),
                                })
                                .collect();
                        }
                        for (stage, requirement) in review.stages.iter_mut().zip(requirements) {
                            stage.hash = requirement.review_hash.clone();
                            intake_editor::refresh(&mut stage.forms, requirement, locale, cx);
                        }
                    }
                    Err(TransportError::ReplicaGenerationChanged) => {
                        review.error = Some(Key::BookingIntakeRestore)
                    }
                    Err(_) => review.error = Some(Key::BookingIntakeUnavailable),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn preview_grouped_visit(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let session = self.svc.session.clone();
        let Some(review) = self
            .visit_desk()
            .filter(|desk| !desk.busy && !desk.submitted)
        else {
            return;
        };
        let Some(packet) = review
            .reviews(cx)
            .and_then(|parts| review.terms.packet(parts).ok())
        else {
            review.error = Some(Key::VisitReviewEveryStep);
            cx.notify();
            return;
        };
        let identity = review.identity.clone();
        review.busy = true;
        review.preview = None;
        review.packet = None;
        review.error = None;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    transport.preview_visit(&packet).map(|preview| {
                        let confirmed = packet.confirmable(&preview).ok();
                        (preview, confirmed)
                    })
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || root.svc.current_session().is_none()
                {
                    return;
                }
                let Some(review) = root
                    .visit_desk()
                    .filter(|desk| Arc::ptr_eq(&identity, &desk.identity))
                else {
                    return;
                };
                review.busy = false;
                match result {
                    Ok((preview, packet)) => {
                        review.preview = Some(preview);
                        review.packet = packet;
                    }
                    Err(BookingError::IntakeChanged) => {
                        review.error = Some(Key::WaitlistFormsChanged)
                    }
                    Err(BookingError::CatalogueChanged) => {
                        review.error = Some(Key::VisitReviewChanged)
                    }
                    Err(BookingError::Transport(TransportError::ReplicaGenerationChanged)) => {
                        review.error = Some(Key::BookingIntakeRestore)
                    }
                    Err(_) => review.error = Some(Key::SeriesPreviewFailed),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn confirm_grouped_visit(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let session = self.svc.session.clone();
        let Some((packet, identity, retry)) = self
            .visit_desk()
            .filter(|desk| !desk.busy)
            .and_then(|desk| Some((desk.packet.clone()?, desk.identity.clone(), desk.submitted)))
        else {
            return;
        };
        if packet.mark_local_dispatch(&mut self.svc.store).is_err() {
            if let Some(review) = self.visit_desk() {
                review.error = Some(Key::BookingIntakeRestore);
            }
            cx.notify();
            return;
        }
        let Some(review) = self.visit_desk() else {
            return;
        };
        review.busy = true;
        review.submitted = true;
        review.confirm_exit = false;
        review.error = None;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.create_reviewed_visit(&packet) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || root.svc.current_session().is_none()
                {
                    return;
                }
                if result.is_ok() {
                    root.svc.wake(Wake::Manual);
                }
                let Some(review) = root
                    .visit_desk()
                    .filter(|desk| Arc::ptr_eq(&identity, &desk.identity))
                else {
                    return;
                };
                review.busy = false;
                let error = match result {
                    Ok(VisitConfirmation::Booked(start)) => {
                        root.finish_new_booking(start, cx);
                        return;
                    }
                    Ok(VisitConfirmation::Changed) => {
                        review.submitted = false;
                        review.saved_changed = true;
                        Key::VisitSavedChanged
                    }
                    Err(BookingError::SlotUnavailable) => Key::VisitSlotChanged,
                    Err(BookingError::CatalogueChanged) => Key::VisitReviewChanged,
                    Err(BookingError::IntakeChanged) => Key::WaitlistFormsChanged,
                    Err(BookingError::Rejected) => Key::BookingIntakeRejected,
                    Err(BookingError::AccessChanged) if !retry => Key::BookingIntakeAccessChanged,
                    Err(BookingError::Transport(TransportError::ReplicaGenerationChanged)) => {
                        Key::BookingIntakeRestore
                    }
                    Err(_) => {
                        review.error = Some(Key::BookingIntakeUnconfirmed);
                        cx.notify();
                        return;
                    }
                };
                review.preview = None;
                review.packet = None;
                review.submitted = false;
                review.error = Some(error);
                cx.notify();
            });
        })
        .detach();
    }

    fn edit_grouped_visit(&mut self, cx: &mut Context<Self>) {
        let Some(review) = self
            .visit_desk()
            .filter(|desk| !desk.busy && !desk.submitted)
        else {
            return;
        };
        review.preview = None;
        review.packet = None;
        review.error = None;
        cx.notify();
    }

    fn exit_grouped_visit(&mut self, cx: &mut Context<Self>) {
        let Some(review) = self
            .visit_desk()
            .filter(|desk| desk.submitted && !desk.busy)
        else {
            return;
        };
        if review.confirm_exit {
            self.overlay = Overlay::None;
            self.svc.wake(Wake::Manual);
        } else {
            review.confirm_exit = true;
            review.error = Some(Key::BookingIntakeExitHelp);
        }
        cx.notify();
    }

    pub(super) fn render_visit_review(
        &self,
        desk: &VisitDesk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let mut body = div()
            .id("visit-review-body")
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_2();
        let preview_tz = desk
            .preview
            .as_ref()
            .and_then(|preview| preview.timezone.parse().ok())
            .unwrap_or(self.tz);
        let mut forms = div().flex().flex_wrap().gap_2();
        for (index, part) in desk.terms.parts().iter().enumerate() {
            let services = part
                .services()
                .iter()
                .map(|service| service.name.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            let label = format!("{} · {services}", self.staff_name(part.staff_id()));
            if let Some(preview) = &desk.preview {
                let item = &preview.parts[index];
                let starts = item.starts_at.with_timezone(&preview_tz);
                let ends = item.ends_at.with_timezone(&preview_tz);
                let date = i18n::date_label(self.locale, starts.date_naive());
                let amount = self.amount_label(item.price_cents, &preview.currency);
                let amount = match item.price_status {
                    VisitPriceStatus::Fixed => amount,
                    VisitPriceStatus::From => {
                        i18n::fill(self.t(Key::VisitPriceFrom), &[("price", &amount)])
                    }
                    VisitPriceStatus::Pending => self.t(Key::VisitPricePending).to_owned(),
                };
                body = body.child(
                    div()
                        .p_2()
                        .rounded_md()
                        .bg(theme::bg())
                        .child(label)
                        .when_some(item.peak_surcharge_cents, |step, surcharge| {
                            let amount = self.amount_label(surcharge, &preview.currency);
                            step.child(div().text_sm().child(i18n::fill(
                                self.t(Key::PeakPriceSurcharge),
                                &[("amount", &amount)],
                            )))
                        })
                        .when(item.deposit_waiver_required, |step| {
                            step.child(
                                div()
                                    .text_sm()
                                    .text_color(theme::conflict_fg())
                                    .child(self.t(Key::VisitWaiverNeeded)),
                            )
                        })
                        .child(
                            div()
                                .text_sm()
                                .text_color(if item.available {
                                    theme::muted()
                                } else {
                                    theme::conflict_fg()
                                })
                                .child(format!(
                                    "{date} · {}–{} · {} · {}",
                                    starts.format("%H:%M"),
                                    ends.format("%H:%M"),
                                    amount,
                                    self.t(if item.available {
                                        Key::SeriesAvailable
                                    } else {
                                        Key::SeriesUnavailable
                                    })
                                )),
                        ),
                );
            } else {
                forms = forms.child(
                    self.chip(
                        ("visit-review-step", index),
                        label,
                        index == desk.active,
                        cx.listener(move |root, _, _, cx| {
                            if let Some(desk) = root.visit_desk() {
                                desk.active = index;
                                cx.notify();
                            }
                        }),
                    )
                    .tab_index(0)
                    .focus(|style| style.border_color(theme::text())),
                );
            }
        }
        if desk
            .preview
            .as_ref()
            .is_some_and(|preview| preview.deposit_enabled)
        {
            body = body.child(self.t(Key::SeriesDepositPolicy));
        }
        if desk.preview.is_none() && !desk.saved_changed && !desk.busy {
            body = body.child(forms);
            if let Some(part) = desk.stages.get(desk.active) {
                if desk.can_waive {
                    body = body
                        .child(self.label(Key::VisitWaiver))
                        .child(part.waiver.clone());
                }
                for form in &part.forms {
                    body = body.child(self.render_intake_form(form, cx));
                }
            }
        }
        if desk.busy {
            body = body.child(self.t(Key::SeriesWorking));
        }

        let actions = div()
            .flex_none()
            .flex()
            .flex_wrap()
            .gap_2()
            .when(desk.submitted && !desk.busy, |row| {
                row.child(
                    self.visit_button(
                        "visit-review-exit",
                        self.t(if desk.confirm_exit {
                            Key::BookingIntakeExitConfirm
                        } else {
                            Key::BookingIntakeExit
                        }),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.exit_grouped_visit(cx)),
                    )
                    .tab_index(0),
                )
            })
            .when(!desk.busy && !desk.submitted, |row| {
                row.child(self.visit_button(
                    "visit-review-back",
                    self.t(if desk.saved_changed {
                        Key::Close
                    } else {
                        Key::Back
                    }),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| {
                        if let Overlay::New(form) = &mut root.overlay {
                            if form
                                .visit_review
                                .as_ref()
                                .is_some_and(|desk| desk.saved_changed)
                            {
                                root.dismiss_overlay(cx);
                            } else {
                                form.visit_review = None;
                                cx.notify();
                            }
                        }
                    }),
                ))
            })
            .when(
                !desk.busy && !desk.submitted && desk.preview.is_some(),
                |row| {
                    row.child(self.visit_button(
                        "visit-review-edit",
                        self.t(Key::SeriesEditReview),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.edit_grouped_visit(cx)),
                    ))
                },
            )
            .when(
                online
                    && !desk.busy
                    && !desk.submitted
                    && desk.preview.is_none()
                    && !desk.saved_changed,
                |row| {
                    row.child(self.visit_button(
                        "visit-review-reload",
                        self.t(Key::WaitlistRefreshForms),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.load_visit_requirements(cx)),
                    ))
                },
            )
            .when(
                online
                    && !desk.busy
                    && !desk.saved_changed
                    && (!desk.stages.is_empty() || desk.submitted),
                |row| {
                    if desk.packet.is_some() {
                        row.child(self.visit_button(
                            "visit-review-confirm",
                            self.t(if desk.submitted {
                                Key::WaitlistRetryAcceptance
                            } else {
                                Key::VisitBook
                            }),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| root.confirm_grouped_visit(cx)),
                        ))
                    } else {
                        row.child(self.visit_button(
                            "visit-review-preview",
                            self.t(if desk.preview.is_some() {
                                Key::SeriesRefresh
                            } else {
                                Key::VisitCheck
                            }),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| root.preview_grouped_visit(cx)),
                        ))
                    }
                },
            );
        self.modal_with_height(
            div()
                .tab_group()
                .child(
                    div()
                        .text_xl()
                        .font_weight(FontWeight::BOLD)
                        .child(self.t(Key::VisitReview)),
                )
                .child(body)
                .when_some(desk.error, |panel, error| {
                    panel.child(
                        div()
                            .text_sm()
                            .text_color(theme::conflict_fg())
                            .child(self.t(error)),
                    )
                })
                .when(!online, |panel| panel.child(self.t(Key::VisitOffline)))
                .child(actions),
            (viewport.width - px(24.)).clamp(px(0.), px(660.)),
            (viewport.height - px(24.)).clamp(px(0.), px(720.)),
            None,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[gpui::test]
    async fn grouped_draft_keeps_steps_and_never_queues_an_offline_partial_visit(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_dir, config) = crate::root::tests::desk();
        let (entity, cx) = cx.add_window_view(|window, cx| {
            let mut screen = Root::new(config, window, cx);
            screen.svc.stop_sync();
            screen.status.connectivity = Connectivity::Offline;
            screen.open_new(window, cx);
            screen
        });
        entity.update(cx, |root, cx| {
            let first = root.staff[0].id.clone();
            let second = root.staff[1].id.clone();
            let service = ops::performed_services(&root.svc.store, &first)
                .unwrap()
                .remove(0);
            let other = ops::performed_services(&root.svc.store, &second)
                .unwrap()
                .remove(0);
            let Overlay::New(form) = &mut root.overlay else {
                panic!("new appointment");
            };
            form.client_id = Some(root.clients[0].0.clone());
            form.staff_id = Some(first.clone());
            form.services.push(service.clone());
            form.selected_quotes.insert(service.clone(), "a".repeat(64));
            root.add_visit_part(cx);
            let Overlay::New(form) = &mut root.overlay else {
                panic!("new appointment");
            };
            assert_eq!(form.visit_parts[0].staff_id, first);
            assert!(form.services.is_empty());
            assert!(form.staff_id.is_none());
            form.staff_id = Some(second.clone());
            form.services.push(other);
            root.book(cx);
            let Overlay::New(form) = &root.overlay else {
                panic!("new appointment");
            };
            assert!(matches!(form.error, Some(Key::VisitOffline)));
            assert_eq!(form.visit_parts[0].service_ids, [service]);
            assert_eq!(form.staff_id.as_deref(), Some(second.as_str()));
            assert!(form.visit_review.is_none());
            assert!(root.svc.store.outbox(8).unwrap().is_empty());
        });
    }
}
