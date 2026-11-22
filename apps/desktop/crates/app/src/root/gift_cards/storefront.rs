use super::*;
use sob_core::http::gift_cards::{
    GiftOffer, GiftOfferDesk, GiftOfferReview, GiftOfferTerms, GiftOfferTheme,
    offer_save_is_terminal,
};

#[derive(Default)]
pub(super) struct Offers {
    pub(super) rows: Option<Vec<GiftOffer>>,
    catalogue: Vec<GiftService>,
    generation: String,
    catalogue_revision: String,
    editor: Option<Editor>,
}

struct Editor {
    id: Uuid,
    version: u32,
    generation: String,
    catalogue_revision: String,
    name: Entity<TextField>,
    description: Entity<TextField>,
    value: Entity<TextField>,
    price: Entity<TextField>,
    days: Entity<TextField>,
    search: Entity<TextField>,
    selected: Vec<Uuid>,
    published: bool,
    theme: GiftOfferTheme,
    retry: Option<GiftOfferReview>,
    _changed: Vec<Subscription>,
}

impl Editor {
    fn new(
        offer: Option<&GiftOffer>,
        generation: String,
        catalogue_revision: String,
        cx: &mut Context<Root>,
    ) -> Self {
        fn amount(cents: u32) -> String {
            format!("{}.{:02}", cents / 100, cents % 100)
        }
        let terms = offer.map(|offer| &offer.terms);
        let field = |text: &str, cx: &mut Context<Root>| {
            cx.new(|cx| {
                let mut field = TextField::new("", false, cx);
                field.set_text(text, cx);
                field
            })
        };
        let search = field("", cx);
        let name = field(terms.map_or("", |terms| &terms.name), cx);
        let description = field(terms.map_or("", |terms| &terms.description), cx);
        let value = field(
            &terms.map_or_else(String::new, |terms| amount(terms.amount_cents)),
            cx,
        );
        let price = field(
            &terms.map_or_else(String::new, |terms| amount(terms.price_cents)),
            cx,
        );
        let days = field(
            &terms
                .and_then(|terms| terms.validity_days)
                .map_or_else(String::new, |days| days.to_string()),
            cx,
        );
        let changed = [&name, &description, &value, &price, &days, &search]
            .into_iter()
            .map(|field| cx.observe(field, |_, _, cx| cx.notify()))
            .collect();
        Self {
            id: offer.map_or_else(Uuid::now_v7, |offer| offer.id),
            version: offer.map_or(0, |offer| offer.version),
            generation,
            catalogue_revision,
            name,
            description,
            value,
            price,
            days,
            search,
            selected: terms.map_or_else(Vec::new, |terms| terms.eligible_service_ids.clone()),
            published: terms.is_some_and(|terms| terms.published),
            theme: terms.map_or(GiftOfferTheme::Rose, |terms| terms.theme),
            retry: None,
            _changed: changed,
        }
    }

    fn proposal(&self, cx: &App) -> Option<GiftOffer> {
        let days = self.days.read(cx).text().trim();
        let terms = GiftOfferTerms {
            name: self.name.read(cx).text().to_owned(),
            description: self.description.read(cx).text().to_owned(),
            amount_cents: sob_core::billing::parse_reviewed_amount(self.value.read(cx).text())?,
            price_cents: sob_core::billing::parse_reviewed_amount(self.price.read(cx).text())?,
            validity_days: if days.is_empty() {
                None
            } else {
                Some(days.parse().ok()?)
            },
            eligible_service_ids: self.selected.clone(),
            published: self.published,
            theme: self.theme,
        }
        .canonical();
        terms.valid().then_some(GiftOffer {
            id: self.id,
            version: self.version,
            terms,
        })
    }
}

impl Offers {
    pub(super) fn editing(&self) -> bool {
        self.editor.is_some()
    }

    pub(super) fn close_editor(&mut self) -> Option<bool> {
        self.editor.take().map(|editor| editor.retry.is_some())
    }

    pub(super) fn load(&mut self, desk: GiftOfferDesk) {
        self.rows = Some(desk.offers);
        self.catalogue = desk.catalogue;
        self.generation = desk.generation;
        self.catalogue_revision = desk.catalogue_revision;
    }

    pub(super) fn accept(&mut self, saved: GiftOffer) {
        if let Some(rows) = &mut self.rows {
            rows.retain(|offer| offer.id != saved.id);
            rows.push(saved);
            rows.sort_by(|left, right| {
                left.terms
                    .name
                    .cmp(&right.terms.name)
                    .then(left.id.cmp(&right.id))
            });
        }
        self.editor = None;
    }

    pub(super) fn save_failed(&mut self, error: &TransportError) {
        if let Some(editor) = &mut self.editor
            && offer_save_is_terminal(Err(error))
        {
            editor.retry = None;
        }
    }
}

impl Root {
    pub(super) fn can_edit_gift_offers(&self) -> bool {
        self.can_configure_salon() || self.svc.store.cached_catalogue_access()
    }

    pub(super) fn open_gift_offers(&mut self, cx: &mut Context<Self>) {
        if !self.can_edit_gift_offers() {
            return;
        }
        let pending = self
            .svc
            .current_session()
            .map(|session| self.svc.store.pending_gift_offer(&session.user_id))
            .transpose();
        if let Some(desk) = self.gift_cards_desk() {
            desk.view = View::Offers;
            desk.offers = Offers::default();
            match pending {
                Ok(Some(Some(review))) => {
                    let mut editor = Editor::new(
                        Some(&review.proposal),
                        review.generation.clone(),
                        review.catalogue_revision.clone(),
                        cx,
                    );
                    editor.retry = Some(review);
                    desk.offers.editor = Some(editor);
                }
                Err(_) => {
                    desk.error = Some(Key::GiftStorageUnavailable);
                    cx.notify();
                    return;
                }
                _ => {}
            }
            self.request_gift(Request::OfferList, cx);
        }
    }

    fn edit_gift_offer(&mut self, id: Option<Uuid>, cx: &mut Context<Self>) {
        if !self.can_edit_gift_offers() {
            return;
        }
        let Some(desk) = self
            .gift_cards_desk()
            .filter(|desk| desk.view == View::Offers && desk.request.is_none())
        else {
            return;
        };
        let Some(rows) = &desk.offers.rows else {
            return;
        };
        let current = id.and_then(|id| rows.iter().find(|offer| offer.id == id));
        if id.is_some() && current.is_none() {
            return;
        }
        desk.offers.editor = Some(Editor::new(
            current,
            desk.offers.generation.clone(),
            desk.offers.catalogue_revision.clone(),
            cx,
        ));
        desk.error = None;
        cx.notify();
    }

    fn save_gift_offer(&mut self, cx: &mut Context<Self>) {
        if self.status.connectivity != Connectivity::Online || !self.can_edit_gift_offers() {
            return;
        }
        let generation = self.svc.store.verified_reviewed_generation().ok();
        let Some(actor) = self.svc.current_session().map(|session| session.user_id) else {
            return;
        };
        let Some(desk) = self
            .gift_cards_desk()
            .filter(|desk| desk.view == View::Offers && desk.request.is_none())
        else {
            return;
        };
        let Some(editor) = &mut desk.offers.editor else {
            return;
        };
        let Some(generation) = generation else {
            desk.error = Some(Key::GiftOffline);
            cx.notify();
            return;
        };
        if editor.generation != generation {
            desk.error = Some(Key::GiftReviewRestored);
            cx.notify();
            return;
        }
        let review = if let Some(retry) = &editor.retry {
            retry.clone()
        } else {
            let Some(proposal) = editor.proposal(cx) else {
                desk.error = Some(Key::GiftOfferInvalid);
                cx.notify();
                return;
            };
            GiftOfferReview {
                proposal,
                generation,
                catalogue_revision: editor.catalogue_revision.clone(),
            }
        };
        if !self
            .svc
            .store
            .reserve_gift_offer(&actor, &review)
            .unwrap_or(false)
        {
            if let Some(desk) = self.gift_cards_desk() {
                desk.error = Some(Key::GiftStorageUnavailable);
                cx.notify();
            }
            return;
        }
        if let Some(editor) = self
            .gift_cards_desk()
            .and_then(|desk| desk.offers.editor.as_mut())
        {
            editor.retry = Some(review.clone());
        }
        self.request_gift(Request::SaveOffer(Box::new(review)), cx);
    }

    fn discard_restored_offer(&mut self, cx: &mut Context<Self>) {
        let Some(actor) = self.svc.current_session().map(|session| session.user_id) else {
            return;
        };
        let Some(review) = self
            .gift_cards_desk()
            .and_then(|desk| desk.offers.editor.as_ref()?.retry.clone())
        else {
            return;
        };
        if !self
            .svc
            .store
            .verified_reviewed_generation()
            .is_ok_and(|current| current != review.generation)
        {
            return;
        }
        if self
            .svc
            .store
            .settle_gift_offer(
                &actor,
                &review,
                Err(&TransportError::ReplicaGenerationChanged),
            )
            .is_ok()
        {
            if let Some(desk) = self.gift_cards_desk() {
                desk.offers.editor = None;
                desk.error = None;
            }
            self.request_gift(Request::OfferList, cx);
        }
    }

    pub(super) fn render_gift_offers(
        &self,
        desk: &Desk,
        online: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let enabled = online && desk.request.is_none() && self.can_edit_gift_offers();
        let mut body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(self.label(Key::GiftOffers));
        if !self.can_edit_gift_offers() {
            return body.child(self.t(Key::GiftAccessDenied));
        }
        if let Some(editor) = &desk.offers.editor {
            return body.child(self.render_gift_offer_editor(desk, editor, enabled, cx));
        }
        let Some(rows) = &desk.offers.rows else {
            return body.when(enabled, |body| {
                body.child(self.gift_button(
                    "reload-offers",
                    Key::GiftRefresh,
                    Kind::Ghost,
                    |root, cx| root.request_gift(Request::OfferList, cx),
                    cx,
                ))
            });
        };
        if enabled {
            body = body.child(self.gift_button(
                "add-offer",
                Key::GiftOfferNew,
                Kind::Primary,
                |root, cx| root.edit_gift_offer(None, cx),
                cx,
            ));
        }
        body.when(rows.is_empty(), |body| {
            body.child(self.t(Key::GiftOfferEmpty))
        })
        .children(rows.iter().map(|offer| {
            let id = offer.id;
            let label = format!(
                "{} · {} · {}",
                offer.terms.name,
                self.amount_label(i64::from(offer.terms.price_cents), "EUR"),
                self.t(if offer.terms.published {
                    Key::GiftOfferPublished
                } else {
                    Key::GiftOfferDraft
                })
            );
            if enabled {
                div().child(self.button(
                    SharedString::from(format!("gift-offer-{id}")),
                    label,
                    Kind::Ghost,
                    cx.listener(move |root, _, _, cx| root.edit_gift_offer(Some(id), cx)),
                ))
            } else {
                div().child(label)
            }
        }))
    }

    fn render_gift_offer_editor(
        &self,
        desk: &Desk,
        editor: &Editor,
        enabled: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let mut body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(self.label(if editor.version == 0 {
                Key::GiftOfferNew
            } else {
                Key::GiftOfferEdit
            }));
        if let Some(review) = &editor.retry {
            let restored = self
                .svc
                .store
                .verified_reviewed_generation()
                .is_ok_and(|current| current != review.generation);
            return body
                .child(review.proposal.terms.name.clone())
                .child(self.t(if restored {
                    Key::GiftReviewRestored
                } else {
                    Key::GiftOfferUnconfirmed
                }))
                .when(enabled, |body| {
                    body.child(self.gift_button(
                        "retry-offer",
                        if restored {
                            Key::GiftDiscardRestored
                        } else {
                            Key::GiftOfferRetry
                        },
                        Kind::Primary,
                        if restored {
                            Root::discard_restored_offer
                        } else {
                            Root::save_gift_offer
                        },
                        cx,
                    ))
                });
        }
        if !enabled {
            return body;
        }
        let published = editor.published;
        body = body
            .child(self.label(Key::GiftLabel))
            .child(editor.name.clone())
            .child(self.label(Key::GiftOfferDescription))
            .child(editor.description.clone())
            .child(self.label(Key::GiftValue))
            .child(editor.value.clone())
            .child(self.label(Key::GiftPurchasePrice))
            .child(editor.price.clone())
            .child(self.label(Key::GiftValidityAfterPayment))
            .child(editor.days.clone())
            .child(self.label(Key::GiftOfferDesign))
            .child(
                div().flex().flex_wrap().gap_2().children(
                    [
                        (GiftOfferTheme::Rose, Key::GiftThemeRose),
                        (GiftOfferTheme::Sage, Key::GiftThemeSage),
                        (GiftOfferTheme::Ink, Key::GiftThemeInk),
                    ]
                    .into_iter()
                    .map(|(theme, title)| {
                        self.gift_button(
                            ("gift-theme", theme as u8 as usize),
                            title,
                            if editor.theme == theme {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            },
                            move |root, cx| {
                                if let Some(editor) = root
                                    .gift_cards_desk()
                                    .and_then(|desk| desk.offers.editor.as_mut())
                                {
                                    editor.theme = theme;
                                    cx.notify();
                                }
                            },
                            cx,
                        )
                    }),
                ),
            )
            .when_some(editor.proposal(cx), |body, preview| {
                let terms = preview.terms;
                let accent =
                    u32::from_str_radix(&terms.theme.print_accent()[1..], 16).unwrap_or(0xa14468);
                body.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .border_l_4()
                        .border_color(gpui::rgb(accent))
                        .p_3()
                        .child(div().font_weight(FontWeight::SEMIBOLD).child(terms.name))
                        .when(!terms.description.is_empty(), |card| {
                            card.child(terms.description)
                        })
                        .child(format!(
                            "{} · {}",
                            self.t(Key::GiftValue),
                            self.amount_label(i64::from(terms.amount_cents), "EUR")
                        ))
                        .child(format!(
                            "{} · {}",
                            self.t(Key::GiftPurchasePrice),
                            self.amount_label(i64::from(terms.price_cents), "EUR")
                        ))
                        .when_some(terms.validity_days, |card, days| {
                            card.child(format!(
                                "{} · {days}",
                                self.t(Key::GiftValidityAfterPayment)
                            ))
                        })
                        .when(!terms.eligible_service_ids.is_empty(), |card| {
                            let names = terms
                                .eligible_service_ids
                                .iter()
                                .filter_map(|id| {
                                    desk.offers
                                        .catalogue
                                        .iter()
                                        .find(|service| &service.id == id)
                                        .map(|service| service.name.as_str())
                                })
                                .collect::<Vec<_>>()
                                .join(", ");
                            card.child(format!("{} · {names}", self.t(Key::GiftEligibleServices)))
                        }),
                )
            })
            .child(self.gift_button(
                "publish-gift-offer",
                if published {
                    Key::GiftOfferKeepDraft
                } else {
                    Key::GiftOfferPublish
                },
                if published {
                    Kind::Primary
                } else {
                    Kind::Ghost
                },
                move |root, cx| {
                    if let Some(editor) = root
                        .gift_cards_desk()
                        .and_then(|desk| desk.offers.editor.as_mut())
                    {
                        editor.published = !published;
                        cx.notify();
                    }
                },
                cx,
            ))
            .child(self.label(Key::GiftEligibleServices))
            .child(self.label(Key::GiftSearchServices))
            .child(editor.search.clone());
        let term = editor.search.read(cx).text().trim().to_lowercase();
        let chosen = editor.selected.iter().map(|id| {
            let name = desk
                .offers
                .catalogue
                .iter()
                .find(|service| &service.id == id)
                .map_or_else(
                    || self.t(Key::GiftOfferUnavailableTreatment).to_owned(),
                    |service| service.name.clone(),
                );
            (*id, name, true)
        });
        let choices = desk
            .offers
            .catalogue
            .iter()
            .filter(|service| {
                !editor.selected.contains(&service.id)
                    && service.name.to_lowercase().contains(&term)
            })
            .take(10)
            .map(|service| (service.id, service.name.clone(), false));
        body.children(chosen.chain(choices).map(|(id, name, selected)| {
            self.button(
                SharedString::from(format!("offer-service-{id}")),
                format!("{} {name}", if selected { "☑" } else { "☐" }),
                if selected { Kind::Primary } else { Kind::Ghost },
                cx.listener(move |root, _, _, cx| {
                    if let Some(editor) = root
                        .gift_cards_desk()
                        .and_then(|desk| desk.offers.editor.as_mut())
                    {
                        if selected {
                            editor.selected.retain(|selected| *selected != id);
                        } else if editor.selected.len() < MAX_GIFT_SERVICES
                            && !editor.selected.contains(&id)
                        {
                            editor.selected.push(id);
                            editor.selected.sort_unstable();
                        }
                        cx.notify();
                    }
                }),
            )
        }))
        .child(self.gift_button(
            "save-gift-offer",
            Key::GiftOfferSave,
            Kind::Primary,
            Root::save_gift_offer,
            cx,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[gpui::test]
    async fn editing_uses_reviewed_terms_and_holds_an_uncertain_save(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_directory, window) = crate::root::tests::open(cx);
        window
            .update(cx, |_, _, cx| {
                let mut editor = Editor::new(None, "verified".into(), "a".repeat(64), cx);
                editor
                    .name
                    .update(cx, |field, cx| field.set_text("  Facial  ", cx));
                editor
                    .value
                    .update(cx, |field, cx| field.set_text("30,00", cx));
                editor
                    .price
                    .update(cx, |field, cx| field.set_text("24.50", cx));
                editor
                    .days
                    .update(cx, |field, cx| field.set_text("731", cx));
                assert!(editor.proposal(cx).is_none());
                editor.days.update(cx, |field, cx| field.set_text("30", cx));
                let proposal = editor.proposal(cx).unwrap();
                assert_eq!(proposal.terms.name, "Facial");
                assert_eq!(proposal.terms.amount_cents, 3000);
                assert_eq!(proposal.terms.price_cents, 2450);
                assert_eq!(proposal.terms.validity_days, Some(30));
                editor.retry = Some(GiftOfferReview {
                    proposal,
                    generation: "verified".into(),
                    catalogue_revision: "a".repeat(64),
                });

                let mut offers = Offers {
                    editor: Some(editor),
                    ..Default::default()
                };
                offers.save_failed(&TransportError::Offline("fixture".into()));
                assert!(offers.editing());
                offers.save_failed(&TransportError::ReplicaGenerationChanged);
                assert_eq!(offers.close_editor(), Some(false));
                assert!(!offers.editing());
            })
            .unwrap();
    }
}
