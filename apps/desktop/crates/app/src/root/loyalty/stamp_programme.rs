use super::*;
use sob_core::loyalty::stamps::programme::{
    ExistingCards, Fields, Programme, ProgrammeTerms, Review,
};
use std::{cell::Cell, rc::Rc};

mod catalogue;
mod view;
use catalogue::{Catalogue, service_choices};

const TERMS_PER_PAGE: usize = 12;
use sob_core::loyalty::stamps::programme::MAX_TERMS_UTF16 as TERMS_LIMIT;

#[derive(Clone, Copy)]
#[repr(usize)]
enum Field {
    Name,
    Goal,
    Welcome,
    Minimum,
    StampExpiry,
    RewardName,
    Discount,
    RewardExpiry,
}

impl Field {
    const ALL: [Self; 8] = [
        Self::Name,
        Self::Goal,
        Self::Welcome,
        Self::Minimum,
        Self::StampExpiry,
        Self::RewardName,
        Self::Discount,
        Self::RewardExpiry,
    ];

    fn label(self) -> Key {
        match self {
            Self::Name => Key::StampProgrammeName,
            Self::Goal => Key::StampProgrammeGoal,
            Self::Welcome => Key::StampProgrammeWelcome,
            Self::Minimum => Key::StampProgrammeMinimum,
            Self::StampExpiry => Key::StampProgrammeExpiryDays,
            Self::RewardName => Key::StampProgrammeRewardName,
            Self::Discount => Key::StampProgrammeDiscount,
            Self::RewardExpiry => Key::StampProgrammeRewardExpiry,
        }
    }

    fn value(self, programme: &ProgrammeTerms) -> String {
        use sob_core::reports::decimal_amount;
        let days = |value: Option<u32>| value.map(|n| n.to_string()).unwrap_or_default();
        match self {
            Self::Name => programme.card.name.clone(),
            Self::Goal => programme.card.goal.to_string(),
            Self::Welcome => programme.card.welcome_stamps.to_string(),
            Self::Minimum => decimal_amount(programme.minimum_spend_cents.into()),
            Self::StampExpiry => days(programme.stamp_expiry_days),
            Self::RewardName => programme.card.reward.name.clone(),
            Self::Discount => programme
                .card
                .reward
                .discount_basis_points
                .map(|n| decimal_amount(n.into()))
                .unwrap_or_default(),
            Self::RewardExpiry => days(programme.reward_expiry_days),
        }
    }
}

pub(super) struct Editor {
    identity: Arc<()>,
    current: Option<Programme>,
    base: Option<Programme>,
    draft: Option<ProgrammeTerms>,
    fields: [Entity<TextField>; 8],
    terms: Vec<Entity<TextField>>,
    terms_page: usize,
    terms_lines_remaining: Rc<Cell<usize>>,
    existing_cards: ExistingCards,
    review: Option<Review>,
    feedback: Option<Key>,
    busy: bool,
    refreshing: bool,
    confirm_exit: bool,
    observed: Option<i64>,
    refresh_at: Instant,
    retry_at: Option<Instant>,
    catalogue: Catalogue,
}

enum Request {
    Refresh,
    Replace,
    Save(Box<Review>),
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
            || Field::ALL
                .into_iter()
                .any(|field| self.fields[field as usize].read(cx).text() != field.value(original))
    }

    fn update_terms_budget(&self) {
        self.terms_lines_remaining
            .set((TERMS_LIMIT + 1).saturating_sub(self.terms.len()));
    }

    fn terms_text(&self, cx: &App) -> String {
        self.terms
            .iter()
            .map(|line| line.read(cx).text())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn proposed(&self, cx: &App) -> Option<ProgrammeTerms> {
        let input = |field: Field| self.fields[field as usize].read(cx).text();
        self.draft.as_ref()?.parse_fields(Fields {
            name: input(Field::Name),
            goal: input(Field::Goal),
            welcome: input(Field::Welcome),
            minimum: input(Field::Minimum),
            stamp_expiry: input(Field::StampExpiry),
            reward_name: input(Field::RewardName),
            discount: input(Field::Discount),
            reward_expiry: input(Field::RewardExpiry),
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
        for field in Field::ALL {
            let value = field.value(&programme.program);
            self.fields[field as usize].update(cx, |field, cx| field.set_text(&value, cx));
        }
        self.terms = programme
            .program
            .card
            .terms
            .split('\n')
            .map(|line| terms_line(line, &self.terms_lines_remaining, cx))
            .collect();
        self.terms_page = 0;
        self.update_terms_budget();
        self.draft = Some(programme.program.clone());
        self.current = Some(programme.clone());
        self.base = Some(programme);
        self.existing_cards = ExistingCards::Keep;
        self.review = None;
        self.catalogue.clear_picker();
    }
}

fn terms_line(text: &str, budget: &Rc<Cell<usize>>, cx: &mut Context<Root>) -> Entity<TextField> {
    let input = cx.new(|cx| {
        let mut field =
            TextField::new("", false, cx).with_bounded_line_paste(TERMS_LIMIT, budget.clone());
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
            FieldEvent::PasteLines(tail) => {
                let budget = &editor.terms_lines_remaining;
                editor.terms.splice(
                    index + 1..index + 1,
                    tail.iter().map(|line| terms_line(line, budget, cx)),
                );
                editor.update_terms_budget();
            }
            FieldEvent::PasteTooLong => editor.feedback = Some(Key::StampProgrammeInvalid),
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
        let labels = Field::ALL.map(|field| self.t(field.label()));
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
            terms_lines_remaining: Rc::new(Cell::new(TERMS_LIMIT)),
            existing_cards: ExistingCards::Keep,
            review: None,
            feedback: None,
            busy: false,
            refreshing: false,
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
        desk.loading = false;
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
        editor.refreshing = false;
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
        if !editor.refreshing
            && (reconnected || observed != editor.observed || Instant::now() >= editor.refresh_at)
        {
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
        let saving = matches!(request, Request::Save(_));
        let replacing = matches!(request, Request::Replace);
        if !saving && !replacing && editor.refreshing {
            return;
        }
        let identity = Arc::new(());
        editor.identity = identity.clone();
        editor.busy = saving || replacing;
        editor.refreshing = !editor.busy;
        editor.observed = observed;
        if let Some(services) = services {
            editor.catalogue.services = services;
        }
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match request {
                        Request::Refresh | Request::Replace => transport.stamp_programme(),
                        Request::Save(review) => transport.save_stamp_programme(&review),
                    }
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
                editor.refreshing = false;
                editor.refresh_at = Instant::now() + Duration::from_secs(15);
                match result {
                    Ok(programme)
                        if saving
                            || replacing
                            || (!editor.dirty(cx) && editor.review.is_none()) =>
                    {
                        if saving || replacing || editor.base.as_ref() != Some(&programme) {
                            if editor.feedback == Some(Key::StampProgrammeSaved) {
                                editor.feedback = None;
                            }
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
                    Ok(programme) => {
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
                root.resolve_stamp_programme_product(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn add_stamp_terms_line(&mut self, cx: &mut Context<Self>) {
        let Some(editor) = self.stamp_programme().filter(|editor| {
            !editor.busy
                && editor.review.is_none()
                && !editor.confirm_exit
                && editor.terms_lines_remaining.get() > 0
        }) else {
            return;
        };
        editor.terms_page = editor.terms.len() / TERMS_PER_PAGE;
        editor
            .terms
            .push(terms_line("", &editor.terms_lines_remaining, cx));
        editor.update_terms_budget();
        cx.notify();
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
            self.request_stamp_programme(Request::Save(Box::new(review)), cx);
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
