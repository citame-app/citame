use super::*;
use sob_core::loyalty::stamps::programme::{
    ExistingCards, Fields, Programme, ProgrammeTerms, Review,
};

mod catalogue;
mod view;
use catalogue::{Catalogue, product_choice, service_choices};
use sob_core::loyalty::stamps::RewardKind;

const TERMS_PER_PAGE: usize = 12;

const FIELD_LABELS: [Key; 8] = [
    Key::StampProgrammeName,
    Key::StampProgrammeGoal,
    Key::StampProgrammeWelcome,
    Key::StampProgrammeMinimum,
    Key::StampProgrammeExpiryDays,
    Key::StampProgrammeRewardName,
    Key::StampProgrammeDiscount,
    Key::StampProgrammeRewardExpiry,
];

pub(super) struct Editor {
    identity: Arc<()>,
    current: Option<Programme>,
    base: Option<Programme>,
    draft: Option<ProgrammeTerms>,
    fields: [Entity<TextField>; 8],
    terms: Vec<Entity<TextField>>,
    terms_page: usize,
    existing_cards: ExistingCards,
    review: Option<Review>,
    feedback: Option<Key>,
    busy: bool,
    confirm_exit: bool,
    observed: Option<i64>,
    refresh_at: Instant,
    retry_at: Option<Instant>,
    catalogue: Catalogue,
}

enum Request {
    Refresh,
    Replace,
    Save(Review),
}

fn values(programme: &ProgrammeTerms) -> [String; 8] {
    use sob_core::reports::decimal_amount;
    let days = |value: Option<u32>| value.map(|n| n.to_string()).unwrap_or_default();
    [
        programme.card.name.clone(),
        programme.card.goal.to_string(),
        programme.card.welcome_stamps.to_string(),
        decimal_amount(programme.minimum_spend_cents.into()),
        days(programme.stamp_expiry_days),
        programme.card.reward.name.clone(),
        programme
            .card
            .reward
            .discount_basis_points
            .map(|n| decimal_amount(n.into()))
            .unwrap_or_default(),
        days(programme.reward_expiry_days),
    ]
}

impl Editor {
    fn limited(&self) -> bool {
        self.retry_at
            .is_some_and(|deadline| Instant::now() < deadline)
    }

    fn dirty(&self, cx: &App) -> bool {
        let Some(base) = &self.base else {
            return false;
        };
        let original = &base.program;
        self.existing_cards != ExistingCards::Keep
            || self.draft.as_ref() != Some(original)
            || self.terms_text(cx) != original.card.terms
            || self
                .fields
                .iter()
                .zip(values(original))
                .any(|(field, value)| field.read(cx).text() != value)
    }

    fn terms_text(&self, cx: &App) -> String {
        self.terms
            .iter()
            .map(|line| line.read(cx).text())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn proposed(&self, cx: &App) -> Option<ProgrammeTerms> {
        let [
            name,
            goal,
            welcome,
            minimum,
            stamp_expiry,
            reward_name,
            discount,
            reward_expiry,
        ] = self.fields.each_ref().map(|field| field.read(cx).text());
        self.draft.as_ref()?.parse_fields(Fields {
            name,
            goal,
            welcome,
            minimum,
            stamp_expiry,
            reward_name,
            discount,
            reward_expiry,
            terms: &self.terms_text(cx),
        })
    }

    fn can_confirm(&self) -> bool {
        let (Some(base), Some(current), Some(review)) = (&self.base, &self.current, &self.review)
        else {
            return false;
        };
        base == current
            || (self.feedback == Some(Key::StampProgrammeUnconfirmed)
                && review.matches_successor(current))
    }

    fn replace(&mut self, programme: Programme, cx: &mut Context<Root>) {
        for (field, value) in self.fields.iter().zip(values(&programme.program)) {
            field.update(cx, |field, cx| field.set_text(&value, cx));
        }
        self.terms = programme
            .program
            .card
            .terms
            .split('\n')
            .map(|line| terms_line(line, cx))
            .collect();
        self.terms_page = 0;
        self.draft = Some(programme.program.clone());
        self.current = Some(programme.clone());
        self.base = Some(programme);
        self.existing_cards = ExistingCards::Keep;
        self.review = None;
        self.catalogue.clear_picker();
    }
}

fn terms_line(text: &str, cx: &mut Context<Root>) -> Entity<TextField> {
    let input = cx.new(|cx| {
        let mut field = TextField::new("", false, cx).with_line_paste(2_000);
        field.set_text(text, cx);
        field
    });
    cx.observe(&input, |_, _, cx| cx.notify()).detach();
    cx.subscribe(&input, |root, origin, event, cx| {
        let Some(editor) = root
            .stamp_programme()
            .filter(|editor| editor.review.is_none() && !editor.confirm_exit)
        else {
            return;
        };
        let Some(index) = editor.terms.iter().position(|line| *line == origin) else {
            return;
        };
        match event {
            FieldEvent::PasteLines(tail)
                if editor.terms.len().saturating_add(tail.len()) <= 2001 =>
            {
                editor.terms.splice(
                    index + 1..index + 1,
                    tail.iter().map(|line| terms_line(line, cx)),
                );
            }
            FieldEvent::PasteLines(_) | FieldEvent::PasteTooLong => {
                editor.feedback = Some(Key::StampProgrammeInvalid)
            }
            _ => {}
        }
        cx.notify();
    })
    .detach();
    input
}

impl Root {
    fn stamp_programme(&mut self) -> Option<&mut Editor> {
        self.loyalty_desk()?.stamp_programme.as_mut()
    }

    pub(super) fn open_stamp_programme(&mut self, cx: &mut Context<Self>) {
        if !self.can_configure_points() {
            return;
        }
        let catalogue = Catalogue::new(self);
        let labels = FIELD_LABELS.map(|key| self.t(key));
        let Some(desk) = self
            .loyalty_desk()
            .filter(|desk| !desk.saving && desk.adjustment.is_none())
        else {
            return;
        };
        desk.stamp_programme = Some(Editor {
            identity: Arc::new(()),
            current: None,
            base: None,
            draft: None,
            fields: labels.map(|label| {
                let field = cx.new(|cx| TextField::new(label, false, cx));
                cx.observe(&field, |_, _, cx| cx.notify()).detach();
                field
            }),
            terms: Vec::new(),
            terms_page: 0,
            existing_cards: ExistingCards::Keep,
            review: None,
            feedback: None,
            busy: false,
            confirm_exit: false,
            observed: None,
            refresh_at: Instant::now(),
            retry_at: None,
            catalogue,
        });
        self.request_stamp_programme(Request::Refresh, cx);
        cx.notify();
    }

    pub(in crate::root) fn preserve_open_stamp_programme(
        &mut self,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.can_configure_points() {
            return false;
        }
        let Some(desk) = self.loyalty_desk() else {
            return false;
        };
        let Some(editor) = &mut desk.stamp_programme else {
            return false;
        };
        desk.selected = None;
        desk.results.clear();
        desk.statement = None;
        desk.stamps = super::stamps::CardList::default();
        desk.request = None;
        for field in [&desk.search, &desk.points, &desk.reason] {
            field.update(cx, |field, cx| field.clear(cx));
        }
        editor.identity = Arc::new(());
        if editor.busy && editor.review.is_some() {
            editor.feedback = Some(Key::StampProgrammeUnconfirmed);
        }
        if editor.feedback == Some(Key::StampProgrammeSaved) {
            editor.feedback = None;
        }
        editor.current = None;
        editor.busy = false;
        editor.observed = None;
        editor.refresh_at = Instant::now();
        editor.catalogue.clear_picker();
        true
    }

    pub(super) fn refresh_stamp_programme(
        &mut self,
        reconnected: bool,
        observed: Option<i64>,
        cx: &mut Context<Self>,
    ) {
        if !self.can_configure_points() {
            self.overlay = Overlay::None;
            cx.notify();
            return;
        }
        let Some(editor) = self
            .stamp_programme()
            .filter(|editor| !editor.busy && !editor.limited())
        else {
            return;
        };
        if editor.retry_at.take().is_some() {
            cx.notify();
        }
        if reconnected || observed != editor.observed || Instant::now() >= editor.refresh_at {
            self.request_stamp_programme(Request::Refresh, cx);
        }
    }

    fn request_stamp_programme(&mut self, request: Request, cx: &mut Context<Self>) {
        let Some(transport) = self.svc.transport().filter(|_| {
            self.can_configure_points() && self.status.connectivity == Connectivity::Online
        }) else {
            return;
        };
        let session = self.svc.session.clone();
        let observed = self.svc.store.live_view_revision(LIVE_TOPIC).ok();
        let services = service_choices(self);
        let Some(editor) = self
            .stamp_programme()
            .filter(|editor| !editor.busy && !editor.limited())
        else {
            return;
        };
        let identity = editor.identity.clone();
        let saving = matches!(request, Request::Save(_));
        let replacing = matches!(request, Request::Replace);
        let known_product = editor.catalogue.target.as_ref().map(|choice| choice.id);
        editor.busy = true;
        editor.observed = observed;
        editor.refresh_at = Instant::now() + Duration::from_secs(15);
        if let Some(services) = services {
            editor.catalogue.services = services;
        }
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let programme = match request {
                        Request::Refresh | Request::Replace => transport.stamp_programme(),
                        Request::Save(review) => transport.save_stamp_programme(&review),
                    }?;
                    let reward = &programme.program.card.reward;
                    let product = reward
                        .target_id
                        .filter(|id| {
                            reward.kind == RewardKind::Product && Some(*id) != known_product
                        })
                        .and_then(|id| transport.inventory_product(id).ok())
                        .map(product_choice);
                    Ok::<_, TransportError>((programme, product))
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || !root.can_configure_points() {
                    return;
                }
                let Some(editor) = root
                    .stamp_programme()
                    .filter(|editor| Arc::ptr_eq(&identity, &editor.identity))
                else {
                    return;
                };
                editor.busy = false;
                match result {
                    Ok((programme, product))
                        if saving
                            || replacing
                            || (!editor.dirty(cx) && editor.review.is_none()) =>
                    {
                        if let Some(product) = product {
                            editor.catalogue.target = Some(product);
                        }
                        if saving || replacing || editor.base.as_ref() != Some(&programme) {
                            editor.replace(programme, cx);
                        } else {
                            editor.current = Some(programme);
                        }
                        if saving {
                            editor.feedback = Some(Key::StampProgrammeSaved);
                        } else if replacing
                            || editor.feedback == Some(Key::StampProgrammeLoadFailed)
                        {
                            editor.feedback = None;
                        }
                    }
                    Ok((programme, product)) => {
                        if let Some(product) = product
                            && editor
                                .draft
                                .as_ref()
                                .and_then(|draft| draft.card.reward.target_id)
                                == Some(product.id)
                        {
                            editor.catalogue.target = Some(product);
                        }
                        editor.current = Some(programme);
                        if editor.feedback == Some(Key::StampProgrammeLoadFailed) {
                            editor.feedback = None;
                        }
                    }
                    Err(TransportError::Unauthorized | TransportError::Forbidden(_)) => {
                        editor.current = None;
                        editor.base = None;
                        editor.draft = None;
                        editor.review = None;
                        editor.catalogue.clear_picker();
                        editor.feedback = Some(Key::StampProgrammeLoadFailed);
                    }
                    Err(error) => {
                        if let TransportError::RateLimited(delay) = &error {
                            editor.retry_at = Instant::now().checked_add(
                                delay
                                    .unwrap_or(Duration::from_secs(10))
                                    .max(Duration::from_secs(1)),
                            );
                        }
                        if saving {
                            editor.feedback = Some(match error {
                                TransportError::BadRequest(_)
                                | TransportError::ReplicaGenerationChanged => {
                                    editor.current = None;
                                    editor.review = None;
                                    editor.refresh_at = Instant::now();
                                    Key::StampProgrammeConflict
                                }
                                TransportError::RateLimited(_)
                                    if editor.feedback != Some(Key::StampProgrammeUnconfirmed) =>
                                {
                                    Key::StampProgrammeRateLimited
                                }
                                _ => Key::StampProgrammeUnconfirmed,
                            });
                        } else if (replacing
                            && editor.feedback != Some(Key::StampProgrammeUnconfirmed))
                            || editor.feedback.is_none()
                        {
                            editor.feedback = Some(Key::StampProgrammeLoadFailed);
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn review_stamp_programme(&mut self, cx: &mut Context<Self>) {
        let Some(editor) = self.stamp_programme().filter(|editor| {
            !editor.busy
                && editor.base == editor.current
                && editor.review.is_none()
                && editor.dirty(cx)
        }) else {
            return;
        };
        let (Some(base), Some(terms)) = (editor.base.as_ref(), editor.proposed(cx)) else {
            editor.feedback = Some(Key::StampProgrammeInvalid);
            cx.notify();
            return;
        };
        if base.program == terms && editor.existing_cards == ExistingCards::Keep {
            return;
        }
        editor.review = Some(Review {
            reviewed: Programme {
                version: base.version,
                generation: base.generation.clone(),
                program: terms,
            },
            existing_cards: editor.existing_cards,
        });
        editor.catalogue.clear_picker();
        editor.feedback = None;
        cx.notify();
    }

    fn save_stamp_programme(&mut self, cx: &mut Context<Self>) {
        if let Some(review) = self
            .stamp_programme()
            .filter(|editor| editor.can_confirm())
            .and_then(|editor| editor.review.clone())
        {
            self.request_stamp_programme(Request::Save(review), cx);
        }
    }

    pub(super) fn close_stamp_programme(&mut self, confirm: bool, cx: &mut Context<Self>) {
        let directory = self.directory_enabled();
        let Some(editor) = self.stamp_programme().filter(|editor| !editor.busy) else {
            return;
        };
        if editor.catalogue.picker.is_some() {
            editor.catalogue.clear_picker();
        } else if editor.confirm_exit && !confirm {
            editor.confirm_exit = false;
        } else if !editor.confirm_exit && (editor.dirty(cx) || editor.review.is_some()) {
            editor.confirm_exit = true;
        } else if !directory {
            self.overlay = Overlay::None;
        } else if let Some(desk) = self.loyalty_desk() {
            desk.stamp_programme = None;
        }
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[gpui::test]
    async fn a_programme_review_freezes_the_card_disposition_and_rejects_a_restored_generation(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_directory, window) = crate::root::tests::open(cx);
        window.update(cx, |root, _, cx| {
            root.svc.stop_sync();
            root.svc.store.set_meta("client_directory", "allowed").unwrap();
            root.status.connectivity = Connectivity::Offline;
            root.open_loyalty(cx);
            root.open_stamp_programme(cx);
            let programme: Programme = serde_json::from_value(serde_json::json!({
                "version": 1, "generation": "before",
                "program": {
                    "enabled": true, "name": "Loyalty card", "appearance": "rose", "goal": 8,
                    "welcomeStamps": 0, "qualifyingServiceIds": [], "minimumSpendCents": 0,
                    "expiryFrom": "issue", "automaticIssue": true, "awardOn": "checkout",
                    "terms": "First line\nSecond line",
                    "reward": {"name": "Gift", "kind": "other", "targetId": null, "discountBasisPoints": null}
                }
            })).unwrap();
            let editor = root.stamp_programme().unwrap();
            editor.replace(programme, cx);
            assert!(!editor.dirty(cx));
            editor.existing_cards = ExistingCards::Void;
            root.review_stamp_programme(cx);
            let editor = root.stamp_programme().unwrap();
            assert!(editor.can_confirm());
            assert_eq!(editor.review.as_ref().unwrap().existing_cards, ExistingCards::Void);

            root.replica_generation = Some("before".into());
            root.reload(cx);
            let editor = root.stamp_programme().unwrap();
            assert!(!editor.can_confirm());
            let review = editor.review.as_ref().unwrap().clone();
            let mut successor = review.reviewed.clone();
            successor.version += 1;
            successor.generation = "restored".into();
            editor.current = Some(successor.clone());
            editor.feedback = Some(Key::StampProgrammeUnconfirmed);
            assert!(!editor.can_confirm());
            successor.generation = "before".into();
            editor.current = Some(successor);
            assert!(editor.can_confirm());
        }).unwrap();
    }
}
