use super::*;
use sob_core::combinations::{FixedCombinationReview, ManagedCombination, booking_calendar_allows};

pub(super) struct BookingCombination {
    pub(super) offer: ManagedCombination,
    pub(super) review: FixedCombinationReview,
    pub(super) override_notice: bool,
    pub(super) selected_start: Option<DateTime<Utc>>,
    slots: CombinationSlots,
}

#[derive(Default)]
enum CombinationSlots {
    #[default]
    Idle,
    Loading(Arc<()>),
    Ready(Vec<DateTime<Utc>>),
    Unavailable,
    Changed,
}

impl BookingCombination {
    pub(super) fn forget_slots(&mut self) {
        self.selected_start = None;
        self.slots = CombinationSlots::Idle;
    }
}

pub(super) fn eligible_combination_staff<'a>(
    staff: &'a [Staff],
    scope: Option<&'a str>,
    offer: &'a ManagedCombination,
) -> impl Iterator<Item = &'a Staff> {
    staff.iter().filter(move |member| {
        booking_calendar_allows(scope, &member.id) && offer.permits_staff(&member.id)
    })
}

impl Root {
    pub(super) fn pick_booking_combination(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(offer) = self.booking_combinations.iter().find(|row| row.id == id) else {
            return;
        };
        let Overlay::New(form) = &mut self.overlay else {
            return;
        };
        if !form.visit_parts.is_empty() || form.recurrence.is_some() || form.intake.is_some() {
            return;
        }
        let Ok(review) = offer.booking_review(&self.services) else {
            form.error = Some(Key::CombinationBookingChanged);
            cx.notify();
            return;
        };
        let mut eligible =
            eligible_combination_staff(&self.staff, self.calendar_scope.as_deref(), offer);
        let Some(first_eligible) = eligible.next() else {
            form.error = Some(Key::CombinationBookingChanged);
            cx.notify();
            return;
        };
        let old_staff = form.staff_id.clone();
        if form.staff_id.as_deref().is_none_or(|staff| {
            !offer.permits_staff(staff)
                || !booking_calendar_allows(self.calendar_scope.as_deref(), staff)
        }) {
            form.staff_id = eligible.next().is_none().then(|| first_eligible.id.clone());
        }
        form.services.clone_from(&offer.draft.service_ids);
        form.selected_quotes = self
            .services
            .iter()
            .filter(|service| form.services.contains(&service.id))
            .filter_map(|service| Some((service.id.clone(), service.quote_hash.clone()?)))
            .collect();
        form.combination = Some(BookingCombination {
            offer: offer.clone(),
            review,
            override_notice: true,
            selected_start: None,
            slots: CombinationSlots::Idle,
        });
        if old_staff != form.staff_id {
            form.selected_end = None;
        }
        form.service_scroll.set_offset(gpui::point(px(0.), px(0.)));
        form.error = None;
        cx.notify();
    }

    fn load_combination_slots(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let Overlay::New(form) = &mut self.overlay else {
            return;
        };
        let (Some(selection), Some(staff)) = (&mut form.combination, &form.staff_id) else {
            return;
        };
        if matches!(selection.slots, CombinationSlots::Loading(_)) {
            return;
        }
        let id = selection.review.id.clone();
        let staff = staff.clone();
        let date = form.date;
        let services = form.services.clone();
        let identity = Arc::new(());
        let session = self.svc.session.clone();
        selection.slots = CombinationSlots::Loading(identity.clone());
        cx.notify();
        cx.spawn(async move |view, cx| {
            let result = cx.background_executor()
                .spawn(async move { transport.combination_slots(&id, &staff, date, &services) })
                .await;
            let _ = view.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || root.svc.current_session().is_none() {
                    return;
                }
                let Overlay::New(form) = &mut root.overlay else { return; };
                let Some(selection) = &mut form.combination else { return; };
                if !matches!(&selection.slots, CombinationSlots::Loading(current) if Arc::ptr_eq(current, &identity)) {
                    return;
                }
                selection.slots = match result {
                    Ok(times) => CombinationSlots::Ready(times),
                    Err(sob_core::sync::TransportError::BadRequest(_)) => {
                        root.svc.wake(Wake::Manual);
                        CombinationSlots::Changed
                    }
                    Err(_) => CombinationSlots::Unavailable,
                };
                cx.notify();
            });
        }).detach();
    }

    fn pick_combination_slot(&mut self, start: DateTime<Utc>, cx: &mut Context<Self>) {
        let Overlay::New(form) = &mut self.overlay else {
            return;
        };
        let Some(selection) = &mut form.combination else {
            return;
        };
        if !matches!(&selection.slots, CombinationSlots::Ready(times) if times.contains(&start)) {
            return;
        }
        let wall = start.with_timezone(&self.tz);
        if form.date != wall.date_naive() {
            return;
        }
        form.minutes = i64::from(wall.hour() * 60 + wall.minute());
        form.selected_end = None;
        form.error = None;
        selection.selected_start = Some(start);
        cx.notify();
    }

    pub(super) fn render_combination_slots(
        &self,
        form: &NewForm,
        cx: &mut Context<Self>,
    ) -> Option<gpui::Div> {
        let selection = form.combination.as_ref()?;
        if self.status.connectivity != Connectivity::Online || form.staff_id.is_none() {
            return None;
        }
        let fetch_label = if matches!(selection.slots, CombinationSlots::Loading(_)) {
            Key::CombinationTimesLoading
        } else {
            Key::CombinationAvailableTimes
        };
        let status = match &selection.slots {
            CombinationSlots::Idle | CombinationSlots::Loading(_) => None,
            CombinationSlots::Ready(times) if times.is_empty() => Some(Key::CombinationTimesEmpty),
            CombinationSlots::Ready(_) => None,
            CombinationSlots::Unavailable => Some(Key::CombinationTimesUnavailable),
            CombinationSlots::Changed => Some(Key::CombinationBookingChanged),
        };
        Some(
            div()
                .flex()
                .flex_col()
                .gap_2()
                .child(
                    self.button(
                        "combination-times-fetch",
                        self.t(fetch_label),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.load_combination_slots(cx)),
                    )
                    .tab_index(0)
                    .focus(|view| view.border_color(theme::text()))
                    .on_key_down(cx.listener(
                        |root, event: &gpui::KeyDownEvent, _, cx| {
                            if activates_button(event) {
                                cx.stop_propagation();
                                root.load_combination_slots(cx);
                            }
                        },
                    )),
                )
                .when_some(status, |list, key| {
                    list.child(
                        div()
                            .text_sm()
                            .text_color(theme::muted())
                            .child(self.t(key)),
                    )
                })
                .when_some(
                    match &selection.slots {
                        CombinationSlots::Ready(times) => Some(times),
                        _ => None,
                    },
                    |list, times| {
                        list.child(
                            div()
                                .id("combination-slot-options")
                                .max_h(px(140.))
                                .overflow_y_scroll()
                                .flex()
                                .flex_wrap()
                                .gap_1()
                                .children(times.iter().copied().map(|start| {
                                    let wall = start.with_timezone(&self.tz);
                                    let label = if self
                                        .tz
                                        .from_local_datetime(&wall.naive_local())
                                        .single()
                                        .is_none()
                                    {
                                        wall.format("%H:%M %Z").to_string()
                                    } else {
                                        wall.format("%H:%M").to_string()
                                    };
                                    self.chip(
                                        SharedString::from(format!(
                                            "combo-time-{}",
                                            start.timestamp()
                                        )),
                                        label,
                                        selection.selected_start == Some(start),
                                        cx.listener(move |root, _, _, cx| {
                                            root.pick_combination_slot(start, cx)
                                        }),
                                    )
                                    .tab_index(0)
                                    .focus(|view| view.border_color(theme::text()))
                                    .on_key_down(cx.listener(
                                        move |root, event: &gpui::KeyDownEvent, _, cx| {
                                            if activates_button(event) {
                                                cx.stop_propagation();
                                                root.pick_combination_slot(start, cx);
                                            }
                                        },
                                    ))
                                })),
                        )
                    },
                ),
        )
    }

    fn clear_booking_combination(&mut self, cx: &mut Context<Self>) {
        if let Overlay::New(form) = &mut self.overlay
            && form.combination.take().is_some()
        {
            form.services.clear();
            form.selected_quotes.clear();
            form.error = None;
        }
        cx.notify();
    }

    pub(super) fn render_booking_combinations(
        &self,
        form: &NewForm,
        search: &str,
        cx: &mut Context<Self>,
    ) -> Option<gpui::Div> {
        if let Some(selection) = &form.combination {
            let offer = &selection.offer;
            let prices = offer
                .draft
                .fixed_terms
                .iter()
                .flat_map(|terms| &terms.prices_cents);
            return Some(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(self.combination_offer_label(offer)),
                    )
                    .children(
                        offer
                            .draft
                            .service_ids
                            .iter()
                            .zip(prices)
                            .map(|(id, &price)| {
                                let name = self
                                    .services
                                    .iter()
                                    .find(|service| &service.id == id)
                                    .map(|service| service.name.as_str())
                                    .unwrap_or(self.t(Key::CombinationUnknownService));
                                div().flex().justify_between().gap_2().children([
                                    div().flex_1().min_w_0().child(name.to_owned()),
                                    div()
                                        .flex_none()
                                        .child(self.amount_label(i64::from(price), "EUR")),
                                ])
                            }),
                    )
                    .child(
                        self.chip(
                            "new-combination-override",
                            self.t(Key::SeriesOverrideNotice),
                            selection.override_notice,
                            cx.listener(|root, _, _, cx| {
                                if let Overlay::New(form) = &mut root.overlay
                                    && let Some(selection) = &mut form.combination
                                {
                                    selection.override_notice = !selection.override_notice;
                                    form.error = None;
                                }
                                cx.notify();
                            }),
                        )
                        .tab_index(0)
                        .focus(|view| view.border_color(theme::text())),
                    )
                    .child(
                        self.button(
                            "new-combination-clear",
                            self.t(Key::ClearBookingCombination),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.clear_booking_combination(cx)),
                        )
                        .tab_index(0)
                        .focus(|view| view.border_color(theme::text()))
                        .on_key_down(cx.listener(
                            |root, event: &gpui::KeyDownEvent, _, cx| {
                                if activates_button(event) {
                                    cx.stop_propagation();
                                    root.clear_booking_combination(cx);
                                }
                            },
                        )),
                    ),
            );
        }
        if !form.visit_parts.is_empty() || form.recurrence.is_some() {
            return None;
        }
        let eligible = self
            .booking_combinations
            .iter()
            .filter(|offer| {
                (search.is_empty() || offer.draft.name.to_lowercase().contains(search))
                    && eligible_combination_staff(
                        &self.staff,
                        self.calendar_scope.as_deref(),
                        offer,
                    )
                    .next()
                    .is_some()
            })
            .collect::<Vec<_>>();
        if eligible.is_empty() {
            return None;
        }
        Some(
            div()
                .flex()
                .flex_col()
                .gap_1()
                .child(self.label(Key::BookingCombinations))
                .children(eligible.into_iter().map(|offer| {
                    let id = offer.id.clone();
                    let keyboard_id = id.clone();
                    self.button(
                        SharedString::from(format!("new-combination-{id}")),
                        self.combination_offer_label(offer),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| root.pick_booking_combination(&id, cx)),
                    )
                    .tab_index(0)
                    .focus(|view| view.border_color(theme::text()))
                    .on_key_down(cx.listener(
                        move |root, event: &gpui::KeyDownEvent, _, cx| {
                            if activates_button(event) {
                                cx.stop_propagation();
                                root.pick_booking_combination(&keyboard_id, cx);
                            }
                        },
                    ))
                })),
        )
    }

    fn combination_offer_label(&self, offer: &ManagedCombination) -> String {
        let cents: i64 = offer
            .draft
            .fixed_terms
            .iter()
            .flat_map(|terms| &terms.prices_cents)
            .map(|&price| i64::from(price))
            .sum();
        format!("{} · {}", offer.draft.name, self.amount_label(cents, "EUR"))
    }
}

fn activates_button(event: &gpui::KeyDownEvent) -> bool {
    !event.is_held && matches!(event.keystroke.key.as_str(), "enter" | "space")
}
