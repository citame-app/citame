use super::*;
use sob_core::combinations::{FixedCombinationReview, ManagedCombination};

pub(super) struct BookingCombination {
    pub(super) offer: ManagedCombination,
    pub(super) review: FixedCombinationReview,
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
        let mut eligible = self
            .staff
            .iter()
            .filter(|staff| offer.permits_staff(&staff.id));
        let Some(first_eligible) = eligible.next() else {
            form.error = Some(Key::CombinationBookingChanged);
            cx.notify();
            return;
        };
        let old_staff = form.staff_id.clone();
        if form
            .staff_id
            .as_deref()
            .is_none_or(|staff| !offer.permits_staff(staff))
        {
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
        });
        if old_staff != form.staff_id {
            form.selected_end = None;
        }
        form.service_scroll.set_offset(gpui::point(px(0.), px(0.)));
        form.error = None;
        cx.notify();
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
                    && self
                        .staff
                        .iter()
                        .any(|staff| offer.permits_staff(&staff.id))
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
