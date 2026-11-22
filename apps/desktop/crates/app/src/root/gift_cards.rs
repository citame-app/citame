use super::*;
use checkout::CheckoutReview;
use sob_core::billing::{AppointmentCheckout, normalize_gift_card_code};
use sob_core::http::{
    HttpTransport,
    gift_cards::{
        GiftBalance, GiftCard, GiftMovementKind, GiftMovements, GiftPage, GiftPurchase,
        GiftPurchaseResult, GiftReveal, GiftStatus,
    },
};
use sob_core::{receipt_print::ReceiptPreview, sync::TransportError};
use uuid::Uuid;

#[derive(Clone, Copy, PartialEq, Eq)]
enum View {
    List,
    Detail(Uuid),
    Issue,
    Check,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Edit {
    Expiry,
    Reissue,
}

pub(super) struct Desk {
    pub(super) receipt: Option<CheckoutReview>,
    issued_receipt: bool,
    view: View,
    search: Entity<TextField>,
    filter: Option<GiftStatus>,
    page: Option<GiftPage>,
    card: Option<GiftCard>,
    movements: Option<GiftMovements>,
    revealed: Option<String>,
    checker: Entity<TextField>,
    checked: Option<GiftBalance>,
    value: Entity<TextField>,
    label: Entity<TextField>,
    buyer_search: Entity<TextField>,
    buyer: Option<(Uuid, String)>,
    expiry: Entity<TextField>,
    reason: Entity<TextField>,
    edit: Option<Edit>,
    purchase: Option<GiftPurchase>,
    request: Option<Arc<()>>,
    observed: Option<i64>,
    refresh_after: Option<Instant>,
    can_manage: bool,
    error: Option<Key>,
    _buyer_changed: Option<Subscription>,
}

enum Request {
    List {
        page: u32,
        search: String,
        status: Option<GiftStatus>,
    },
    Detail(Uuid, u32),
    Issue(GiftPurchase),
    Check(String),
    Reveal(Uuid),
    Print {
        id: Uuid,
        salon: String,
        tz: Tz,
        locale: Locale,
    },
    Checkout(Uuid),
    Edit {
        kind: Edit,
        id: Uuid,
        version: u32,
        reason: String,
        expiry: Option<DateTime<Utc>>,
        generation: String,
    },
}

enum Loaded {
    List(GiftPage, bool),
    Detail(GiftCard, GiftMovements),
    Issued(Box<GiftPurchaseResult>),
    Balance(GiftBalance),
    Revealed(GiftReveal),
    Print(ReceiptPreview),
    Receipt(Box<AppointmentCheckout>),
    Edited(GiftCard),
}

impl Request {
    fn run(self, http: &HttpTransport) -> Result<Loaded, TransportError> {
        Ok(match self {
            Self::List {
                page,
                search,
                status,
            } => Loaded::List(
                http.gift_cards(page, &search, status)?,
                http.can_manage_gift_cards()?,
            ),
            Self::Detail(id, page) => {
                Loaded::Detail(http.gift_card(id)?, http.gift_card_movements(id, page)?)
            }
            Self::Issue(purchase) => Loaded::Issued(Box::new(http.purchase_gift_card(&purchase)?)),
            Self::Check(code) => Loaded::Balance(http.check_gift_card(&code)?),
            Self::Reveal(id) => Loaded::Revealed(http.reveal_gift_card(id)?),
            Self::Print {
                id,
                salon,
                tz,
                locale,
            } => Loaded::Print(
                ReceiptPreview::gift_voucher(&http.reveal_gift_card(id)?, &salon, tz, locale)
                    .map_err(|error| TransportError::Server(error.to_string()))?,
            ),
            Self::Checkout(id) => Loaded::Receipt(Box::new(http.open_saved_checkout(id)?)),
            Self::Edit {
                kind,
                id,
                version,
                reason,
                expiry,
                generation,
            } => Loaded::Edited(match kind {
                Edit::Expiry => {
                    http.change_gift_card_expiry(id, version, &reason, expiry, &generation)?
                }
                Edit::Reissue => http.reissue_gift_card(id, version, &reason, &generation)?,
            }),
        })
    }
}

fn search_term(input: &str) -> String {
    let text = input.trim();
    if let Some(code) = normalize_gift_card_code(text) {
        return code[code.len() - 4..].to_owned();
    }
    if text
        .get(..3)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("SOB"))
        && text.get(3..).is_some_and(|rest| {
            rest.starts_with([' ', '-'])
                || (!rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_hexdigit()))
        })
    {
        return String::new();
    }
    text.chars().take(100).collect()
}

fn expiry_date(tz: Tz, input: &str) -> Option<Option<DateTime<Utc>>> {
    if input.trim().is_empty() {
        return Some(None);
    }
    let next_day = reports::parse_report_date(input)?.succ_opt()?;
    Some(Some(
        tz.from_local_datetime(&next_day.and_hms_opt(0, 0, 0)?)
            .earliest()?
            .with_timezone(&Utc),
    ))
}

impl Root {
    fn gift_cards_desk(&mut self) -> Option<&mut Desk> {
        match &mut self.overlay {
            Overlay::GiftCards(desk) => Some(desk),
            _ => None,
        }
    }

    pub(super) fn open_gift_cards(&mut self, cx: &mut Context<Self>) {
        let search = self.t(Key::GiftSearch);
        let pending = self
            .svc
            .current_session()
            .map(|session| self.svc.store.pending_gift_purchase(&session.user_id))
            .transpose();
        let storage_error = pending.is_err();
        let purchase = pending.ok().flatten().flatten();
        let view = if purchase.is_some() {
            View::Issue
        } else {
            View::List
        };
        let mut desk = Desk {
            receipt: None,
            issued_receipt: false,
            view,
            search: cx.new(|cx| TextField::new(search, false, cx)),
            filter: None,
            page: None,
            card: None,
            movements: None,
            revealed: None,
            checker: cx.new(|cx| TextField::new("SOB-…", true, cx)),
            checked: None,
            value: cx.new(|cx| TextField::new("EUR", false, cx)),
            label: cx.new(|cx| TextField::new("", false, cx)),
            buyer_search: cx.new(|cx| TextField::new("", false, cx)),
            buyer: None,
            expiry: cx.new(|cx| TextField::new("", false, cx)),
            reason: cx.new(|cx| TextField::new("", false, cx)),
            edit: None,
            purchase,
            request: None,
            observed: None,
            refresh_after: None,
            can_manage: false,
            error: storage_error.then_some(Key::GiftStorageUnavailable),
            _buyer_changed: None,
        };
        desk._buyer_changed = Some(cx.observe(&desk.buyer_search, |_, _, cx| cx.notify()));
        self.overlay = Overlay::GiftCards(Box::new(desk));
        if view == View::List && !storage_error {
            self.load_gift_list(1, cx);
        }
        cx.notify();
    }

    fn load_gift_list(&mut self, page: u32, cx: &mut Context<Self>) {
        let Some(desk) = self.gift_cards_desk() else {
            return;
        };
        if desk.request.is_some() {
            return;
        }
        let search = search_term(desk.search.read(cx).text());
        if search != desk.search.read(cx).text() {
            desk.search
                .update(cx, |field, cx| field.set_text(&search, cx));
        }
        let status = desk.filter;
        self.request_gift(
            Request::List {
                page,
                search,
                status,
            },
            cx,
        );
    }

    fn open_gift_detail(&mut self, id: Uuid, cx: &mut Context<Self>) {
        let Some(desk) = self.gift_cards_desk() else {
            return;
        };
        if desk.request.is_some() {
            return;
        }
        desk.view = View::Detail(id);
        desk.card = None;
        desk.movements = None;
        desk.revealed = None;
        desk.edit = None;
        self.request_gift(Request::Detail(id, 1), cx);
        cx.notify();
    }

    pub(super) fn dismiss_gift_cards(&mut self, cx: &mut Context<Self>) {
        let actor = self.svc.current_session().map(|session| session.user_id);
        let storage_error = self.t(Key::GiftStorageUnavailable).to_owned();
        let Some(desk) = self.gift_cards_desk() else {
            return;
        };
        if desk.request.is_some() {
            return;
        }
        if let Some(receipt) = &desk.receipt {
            if !receipt.can_go_back() {
                return;
            }
            let purchase = desk.issued_receipt.then(|| desk.purchase.clone()).flatten();
            let view = desk.view;
            let acknowledged = match (actor, purchase) {
                (Some(actor), Some(purchase)) => self
                    .svc
                    .store
                    .settle_gift_purchase(&actor, &purchase, Ok(()))
                    .unwrap_or(false),
                (_, None) => true,
                (None, Some(_)) => false,
            };
            let Some(desk) = self.gift_cards_desk() else {
                return;
            };
            if !acknowledged {
                if let Some(receipt) = &mut desk.receipt {
                    receipt.show_error(storage_error);
                }
                cx.notify();
                return;
            }
            desk.receipt = None;
            if desk.issued_receipt {
                desk.purchase = None;
                desk.issued_receipt = false;
            }
            if let View::Detail(id) = view {
                self.request_gift(Request::Detail(id, 1), cx);
            }
        } else if desk.revealed.take().is_some() || desk.edit.take().is_some() {
            desk.error = None;
        } else if desk.view == View::List {
            self.load_register(cx);
        } else {
            desk.view = View::List;
            desk.error = None;
            let page = desk.page.as_ref().map_or(1, |page| page.pagination.page);
            self.load_gift_list(page, cx);
        }
        cx.notify();
    }

    pub(super) fn refresh_gift_cards(&mut self, reconnected: bool, cx: &mut Context<Self>) {
        let observed = self.svc.store.live_view_revision("commerce").ok();
        let online = self.status.connectivity == Connectivity::Online;
        let Some(desk) = self.gift_cards_desk() else {
            return;
        };
        let changed = desk.observed != observed;
        if (!online || reconnected || changed) && desk.revealed.take().is_some() {
            cx.notify();
        }
        if (!online || reconnected || changed) && desk.checked.take().is_some() {
            cx.notify();
        }
        if !online {
            return;
        }
        if desk.request.is_some()
            || desk.receipt.is_some()
            || desk.edit.is_some()
            || (!reconnected
                && (!changed || desk.refresh_after.is_some_and(|at| Instant::now() < at)))
        {
            return;
        }
        match desk.view {
            View::List => {
                let page = desk.page.as_ref().map_or(1, |page| page.pagination.page);
                self.load_gift_list(page, cx);
            }
            View::Detail(id) => {
                let page = desk
                    .movements
                    .as_ref()
                    .map_or(1, |history| history.pagination.page);
                self.request_gift(Request::Detail(id, page), cx);
            }
            _ => {}
        }
    }

    fn request_gift(&mut self, request: Request, cx: &mut Context<Self>) {
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let observation = self.svc.store.live_view_revision("commerce").ok();
        let session = self.svc.session.clone();
        let pending = match &request {
            Request::Issue(purchase) => self
                .svc
                .current_session()
                .map(|session| (session.user_id, purchase.clone())),
            _ => None,
        };
        let Some(desk) = self.gift_cards_desk().filter(|desk| desk.request.is_none()) else {
            return;
        };
        let token = Arc::new(());
        let issue = pending.is_some();
        let edit = matches!(&request, Request::Edit { .. });
        let print = matches!(&request, Request::Print { .. });
        if edit || matches!(&request, Request::Checkout(_)) {
            desk.revealed = None;
        }
        desk.request = Some(token.clone());
        desk.error = None;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let reply = cx
                .background_executor()
                .spawn(async move { request.run(&transport) })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let online = root.status.connectivity == Connectivity::Online;
                let revision = root.svc.store.live_view_revision("commerce").ok();
                let retired = pending.as_ref().zip(reply.as_ref().err()).is_some_and(
                    |((actor, purchase), error)| {
                        root.svc
                            .store
                            .settle_gift_purchase(actor, purchase, Err(error))
                            .unwrap_or(false)
                    },
                );
                let Some(desk) = root.gift_cards_desk().filter(|desk| {
                    desk.request
                        .as_ref()
                        .is_some_and(|active| Arc::ptr_eq(active, &token))
                }) else {
                    return;
                };
                desk.request = None;
                match reply {
                    Ok(Loaded::List(page, capability)) => {
                        desk.observed = observation;
                        desk.refresh_after = None;
                        desk.page = Some(page);
                        desk.can_manage = capability;
                    }
                    Ok(Loaded::Detail(card, movements)) => {
                        desk.observed = observation;
                        desk.refresh_after = None;
                        if desk
                            .card
                            .as_ref()
                            .is_none_or(|before| before.code_revision != card.code_revision)
                            || matches!(card.balance.status, GiftStatus::Pending | GiftStatus::Void)
                        {
                            desk.revealed = None;
                        }
                        desk.card = Some(card);
                        desk.movements = Some(movements);
                    }
                    Ok(Loaded::Issued(purchase)) => {
                        desk.issued_receipt = true;
                        desk.view = View::Detail(purchase.card.id);
                        desk.card = Some(purchase.card);
                        desk.movements = None;
                        desk.receipt = Some(CheckoutReview::from_receipt(
                            purchase.checkout,
                            observation.unwrap_or(0),
                            cx,
                        ));
                    }
                    Ok(Loaded::Balance(balance)) if online && observation == revision => {
                        desk.observed = observation;
                        desk.checked = Some(balance);
                    }
                    Ok(Loaded::Revealed(reveal)) if online && observation == revision => {
                        desk.observed = observation;
                        desk.card = Some(reveal.card);
                        desk.revealed = Some(reveal.code);
                    }
                    Ok(Loaded::Print(preview)) => {
                        if online && observation == revision && desk.revealed.is_some() {
                            cx.open_url(&preview.url());
                            cx.background_executor()
                                .spawn(async move {
                                    preview.serve();
                                })
                                .detach();
                        } else {
                            desk.error = Some(Key::GiftPrintFailed);
                        }
                    }
                    Ok(Loaded::Receipt(receipt)) => {
                        desk.receipt = Some(CheckoutReview::from_receipt(
                            *receipt,
                            observation.unwrap_or(0),
                            cx,
                        ));
                    }
                    Ok(Loaded::Edited(card)) => {
                        desk.card = Some(card);
                        desk.revealed = None;
                        desk.edit = None;
                    }
                    Ok(_) => {}
                    Err(error) => {
                        desk.refresh_after = Some(Instant::now() + Duration::from_secs(5));
                        let uncertain = matches!(
                            error,
                            TransportError::Offline(_)
                                | TransportError::Server(_)
                                | TransportError::Unauthorized
                                | TransportError::RateLimited(_)
                        );
                        if issue && retired {
                            desk.purchase = None
                        }
                        if edit {
                            desk.revealed = None
                        }
                        desk.error = Some(match error {
                            TransportError::ReplicaGenerationChanged => Key::GiftReviewRestored,
                            TransportError::BadRequest(_) if edit => Key::GiftReviewChanged,
                            TransportError::Forbidden(_) => Key::GiftAccessDenied,
                            _ if print => Key::GiftPrintFailed,
                            _ if issue && uncertain => Key::GiftIssueUnconfirmed,
                            _ => Key::GiftUnavailable,
                        });
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn open_gift_form(&mut self, view: View, cx: &mut Context<Self>) {
        let Some(desk) = self.gift_cards_desk() else {
            return;
        };
        if desk.request.is_some() {
            return;
        }
        desk.view = view;
        desk.error = None;
        desk.checked = None;
        desk.checker.update(cx, |field, cx| field.clear(cx));
        if view == View::Issue && desk.purchase.is_none() {
            for field in [&desk.value, &desk.label, &desk.buyer_search, &desk.expiry] {
                field.update(cx, |field, cx| field.clear(cx));
            }
            desk.buyer = None;
        }
        cx.notify();
    }

    fn issue_gift(&mut self, cx: &mut Context<Self>) {
        if self.status.connectivity != Connectivity::Online || self.svc.transport().is_none() {
            return;
        }
        let tz = self.tz;
        let generation = self.svc.store.verified_reviewed_generation().ok();
        let Some(actor) = self.svc.current_session().map(|session| session.user_id) else {
            return;
        };
        let Some(desk) = self
            .gift_cards_desk()
            .filter(|desk| desk.view == View::Issue && desk.request.is_none())
        else {
            return;
        };
        if let Some(purchase) = desk.purchase.clone() {
            if generation.as_deref() == Some(&purchase.generation) {
                self.request_gift(Request::Issue(purchase), cx);
            } else {
                desk.error = Some(if generation.is_some() {
                    Key::GiftReviewRestored
                } else {
                    Key::GiftOffline
                });
                cx.notify();
            }
            return;
        }
        let purchase = generation.and_then(|generation| {
            GiftPurchase::review(
                desk.value.read(cx).text(),
                desk.label.read(cx).text(),
                desk.buyer.as_ref().map(|(id, _)| *id),
                expiry_date(tz, desk.expiry.read(cx).text())?,
                generation,
                Utc::now(),
            )
        });
        let Some(purchase) = purchase else {
            desk.error = Some(Key::GiftIssueInvalid);
            cx.notify();
            return;
        };
        match self.svc.store.reserve_gift_purchase(&actor, &purchase) {
            Ok(true) => {
                if let Some(desk) = self.gift_cards_desk() {
                    desk.purchase = Some(purchase.clone());
                }
                self.request_gift(Request::Issue(purchase), cx);
            }
            Ok(false) => {
                let pending = self.svc.store.pending_gift_purchase(&actor);
                if let Some(desk) = self.gift_cards_desk() {
                    desk.purchase = pending.ok().flatten();
                    desk.error = Some(if desk.purchase.is_some() {
                        Key::GiftIssueUnconfirmed
                    } else {
                        Key::GiftStorageUnavailable
                    });
                }
                cx.notify();
            }
            Err(_) => {
                if let Some(desk) = self.gift_cards_desk() {
                    desk.error = Some(Key::GiftStorageUnavailable);
                }
                cx.notify();
            }
        }
    }

    fn discard_restored_gift_purchase(&mut self, cx: &mut Context<Self>) {
        let generation = self.svc.store.verified_reviewed_generation().ok();
        let Some(actor) = self.svc.current_session().map(|session| session.user_id) else {
            return;
        };
        let Some(purchase) = self
            .gift_cards_desk()
            .and_then(|desk| desk.purchase.clone())
        else {
            return;
        };
        if !generation.is_some_and(|generation| generation != purchase.generation) {
            return;
        }
        let cleared = self
            .svc
            .store
            .clear_gift_purchase(&actor, &purchase)
            .is_ok();
        if let Some(desk) = self.gift_cards_desk() {
            if cleared {
                desk.purchase = None;
                desk.error = None;
            } else {
                desk.error = Some(Key::GiftStorageUnavailable);
            }
        }
        cx.notify();
    }

    fn check_gift(&mut self, cx: &mut Context<Self>) {
        let Some(desk) = self
            .gift_cards_desk()
            .filter(|desk| desk.view == View::Check && desk.request.is_none())
        else {
            return;
        };
        desk.checked = None;
        let Some(code) = normalize_gift_card_code(desk.checker.read(cx).text()) else {
            desk.error = Some(Key::CheckoutGiftCodeInvalid);
            cx.notify();
            return;
        };
        desk.checker.update(cx, |field, cx| field.clear(cx));
        self.request_gift(Request::Check(code), cx);
    }

    fn start_gift_edit(&mut self, kind: Edit, cx: &mut Context<Self>) {
        let tz = self.tz;
        let Some(desk) = self
            .gift_cards_desk()
            .filter(|desk| desk.can_manage && desk.request.is_none())
        else {
            return;
        };
        let Some(card) = desk.card.as_ref() else {
            return;
        };
        if kind == Edit::Reissue
            && matches!(card.balance.status, GiftStatus::Pending | GiftStatus::Void)
        {
            return;
        }
        let expiry = card
            .balance
            .expires_at
            .and_then(|value| value.checked_sub_signed(Span::milliseconds(1)))
            .map(|value| value.with_timezone(&tz).date_naive().to_string())
            .unwrap_or_default();
        desk.expiry
            .update(cx, |field, cx| field.set_text(&expiry, cx));
        desk.reason.update(cx, |field, cx| field.clear(cx));
        desk.revealed = None;
        desk.edit = Some(kind);
        desk.error = None;
        cx.notify();
    }

    fn commit_gift_edit(&mut self, cx: &mut Context<Self>) {
        let tz = self.tz;
        let generation = self.svc.store.verified_reviewed_generation().ok();
        let Some(desk) = self
            .gift_cards_desk()
            .filter(|desk| desk.can_manage && desk.request.is_none())
        else {
            return;
        };
        let (Some(card), Some(kind), Some(generation)) = (&desk.card, desk.edit, generation) else {
            return;
        };
        let reason = desk.reason.read(cx).text().trim().to_owned();
        let expiry = if kind == Edit::Expiry {
            expiry_date(tz, desk.expiry.read(cx).text())
        } else {
            Some(None)
        };
        let Some(expiry) = expiry.filter(|_| (3..=300).contains(&reason.chars().count())) else {
            desk.error = Some(Key::GiftEditInvalid);
            cx.notify();
            return;
        };
        let request = Request::Edit {
            kind,
            id: card.id,
            version: card.version,
            reason,
            expiry,
            generation,
        };
        self.request_gift(request, cx);
    }

    fn print_gift(&mut self, id: Uuid, cx: &mut Context<Self>) {
        let salon = self
            .svc
            .store
            .salon_settings()
            .ok()
            .flatten()
            .map_or_else(|| "Citame".to_owned(), |salon| salon.name);
        self.request_gift(
            Request::Print {
                id,
                salon,
                tz: self.tz,
                locale: self.locale,
            },
            cx,
        );
    }

    fn gift_button(
        &self,
        id: impl Into<ElementId>,
        key: Key,
        kind: Kind,
        action: impl Fn(&mut Root, &mut Context<Root>) + 'static,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        self.button(
            id,
            self.t(key),
            kind,
            cx.listener(move |root, _, _, cx| action(root, cx)),
        )
    }

    pub(super) fn render_gift_cards(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        if let Some(receipt) = &desk.receipt {
            return self.render_checkout(receipt, cx);
        }
        let online = self.status.connectivity == Connectivity::Online;
        let ready = online && desk.request.is_none();
        let title = div()
            .text_lg()
            .font_weight(FontWeight::BOLD)
            .child(self.t(Key::GiftCards));
        let content = match desk.view {
            View::List => self.render_gift_list(desk, ready, cx),
            View::Detail(id) => self.render_gift_detail(desk, id, ready, cx),
            View::Issue => self.render_gift_issue(desk, ready, cx),
            View::Check => {
                let body = div()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(self.label(Key::CheckoutGiftCode));
                let body = body.when(ready, |body| {
                    body.child(desk.checker.clone()).child(self.gift_button(
                        "submit-gift-check",
                        Key::GiftCheck,
                        Kind::Primary,
                        Root::check_gift,
                        cx,
                    ))
                });
                if let Some(balance) = &desk.checked {
                    body.child(self.render_gift_balance(balance))
                } else {
                    body
                }
            }
        };
        let height = (viewport.height - px(24.)).max(px(180.)).min(px(680.));
        let width = (viewport.width - px(24.)).max(px(260.)).min(px(680.));
        let body = div()
            .child(title)
            .when(!online, |body| body.child(self.t(Key::GiftOffline)))
            .when(desk.request.is_some(), |body| {
                body.child(self.t(Key::CheckoutLoading))
            })
            .when_some(desk.error, |body, key| {
                body.child(div().text_color(theme::conflict_fg()).child(self.t(key)))
            })
            .child(
                div()
                    .id("gift-cards-content")
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(content),
            )
            .when(desk.request.is_none(), |body| {
                body.child(self.gift_button(
                    "back-from-gifts",
                    Key::Back,
                    Kind::Ghost,
                    Root::dismiss_gift_cards,
                    cx,
                ))
            });
        self.modal_with_height(body, width, height, Some(cx))
    }

    fn render_gift_list(&self, desk: &Desk, ready: bool, cx: &mut Context<Self>) -> gpui::Div {
        let body = div().flex().flex_col().gap_3().when(ready, |body| {
            body.child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.gift_button(
                        "issue-gift",
                        Key::GiftIssue,
                        Kind::Primary,
                        |root, cx| root.open_gift_form(View::Issue, cx),
                        cx,
                    ))
                    .child(self.gift_button(
                        "check-gift",
                        Key::GiftCheck,
                        Kind::Ghost,
                        |root, cx| root.open_gift_form(View::Check, cx),
                        cx,
                    )),
            )
            .child(desk.search.clone())
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.gift_button(
                        "search-gift-cards",
                        Key::GiftSearch,
                        Kind::Ghost,
                        |root, cx| root.load_gift_list(1, cx),
                        cx,
                    ))
                    .children(
                        [
                            None,
                            Some(GiftStatus::Pending),
                            Some(GiftStatus::Active),
                            Some(GiftStatus::Void),
                            Some(GiftStatus::Expired),
                        ]
                        .into_iter()
                        .enumerate()
                        .map(|(index, status)| {
                            self.gift_button(
                                ("gift-status", index),
                                status.map_or(Key::SalesAllStatuses, gift_status_key),
                                if desk.filter == status {
                                    Kind::Primary
                                } else {
                                    Kind::Ghost
                                },
                                move |root, cx| {
                                    if let Some(desk) = root.gift_cards_desk() {
                                        desk.filter = status;
                                        desk.page = None;
                                        root.load_gift_list(1, cx);
                                    }
                                },
                                cx,
                            )
                        }),
                    ),
            )
        });
        let Some(page) = &desk.page else { return body };
        let body = body.when(page.cards.is_empty(), |body| {
            body.child(self.t(Key::GiftEmpty))
        });
        let body = body.children(page.cards.iter().map(|card| {
            let id = card.id;
            let title = if card.label.is_empty() {
                self.t(Key::SalesGiftCard)
            } else {
                &card.label
            };
            let label = format!(
                "{title} · •••• {} · {} · {}",
                card.balance.code_last4,
                self.t(gift_status_key(card.balance.status)),
                self.amount_label(
                    i64::from(card.balance.available_cents),
                    &card.balance.currency
                ),
            );
            if ready {
                div().child(self.button(
                    SharedString::from(format!("open-gift-card-{id}")),
                    label,
                    Kind::Ghost,
                    cx.listener(move |root, _, _, cx| root.open_gift_detail(id, cx)),
                ))
            } else {
                div().child(label)
            }
        }));
        let pagination = &page.pagination;
        body.when(ready, |body| {
            body.child(
                div()
                    .flex()
                    .gap_2()
                    .when(pagination.page > 1, |row| {
                        let page = pagination.page - 1;
                        row.child(self.gift_button(
                            "previous-gift-page",
                            Key::GiftPrevious,
                            Kind::Ghost,
                            move |root, cx| root.load_gift_list(page, cx),
                            cx,
                        ))
                    })
                    .when(pagination.has_next(), |row| {
                        let page = pagination.page + 1;
                        row.child(self.gift_button(
                            "next-gift-page",
                            Key::GiftNext,
                            Kind::Ghost,
                            move |root, cx| root.load_gift_list(page, cx),
                            cx,
                        ))
                    }),
            )
        })
    }

    fn render_gift_balance(&self, balance: &GiftBalance) -> gpui::Div {
        let money = |amount| self.amount_label(i64::from(amount), &balance.currency);
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(format!(
                "•••• {} · {}",
                balance.code_last4,
                self.t(gift_status_key(balance.status))
            ))
            .child(format!(
                "{} · {}",
                self.t(Key::GiftAvailable),
                money(balance.available_cents)
            ))
            .child(format!(
                "{} · {}",
                self.t(Key::GiftBalance),
                money(balance.balance_cents)
            ))
            .when(balance.reserved_cents > 0, |body| {
                body.child(format!(
                    "{} · {}",
                    self.t(Key::GiftReserved),
                    money(balance.reserved_cents)
                ))
            })
            .when_some(balance.expires_at, |body, expiry| {
                body.child(format!(
                    "{} · {}",
                    self.t(Key::GiftExpiry),
                    self.date_time_label(expiry)
                ))
            })
    }

    fn render_gift_issue(&self, desk: &Desk, ready: bool, cx: &mut Context<Self>) -> gpui::Div {
        let mut body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(self.label(Key::GiftIssue));
        if let Some(pending) = &desk.purchase {
            body = body.child(self.amount_label(i64::from(pending.amount_cents), "EUR"));
            if !pending.label.is_empty() {
                body = body.child(pending.label.clone());
            }
            let restored = self
                .svc
                .store
                .verified_reviewed_generation()
                .is_ok_and(|generation| generation != pending.generation);
            return body.when(ready, |body| {
                if restored {
                    body.child(self.t(Key::GiftReviewRestored))
                        .child(self.gift_button(
                            "discard-restored-gift",
                            Key::GiftDiscardRestored,
                            Kind::Danger,
                            Root::discard_restored_gift_purchase,
                            cx,
                        ))
                } else {
                    body.child(self.gift_button(
                        "retry-gift",
                        Key::GiftRetry,
                        Kind::Primary,
                        Root::issue_gift,
                        cx,
                    ))
                }
            });
        }
        let search = desk.buyer_search.read(cx).text().trim().to_lowercase();
        let choices = if ready && search.chars().count() >= 2 && desk.buyer.is_none() {
            self.clients
                .iter()
                .zip(&self.client_search_names)
                .filter(|(_, searchable)| searchable.contains(&search))
                .filter_map(|((id, name), _)| Some((id.parse::<Uuid>().ok()?, name.clone())))
                .take(8)
                .collect::<Vec<_>>()
        } else {
            vec![]
        };
        body.child(self.label(Key::GiftValue))
            .child(desk.value.clone())
            .child(self.label(Key::GiftLabel))
            .child(desk.label.clone())
            .child(self.label(Key::GiftExpiryInput))
            .child(desk.expiry.clone())
            .child(self.label(Key::GiftBuyer))
            .when_some(desk.buyer.as_ref(), |body, (_, name)| {
                body.child(name.clone()).when(ready, |body| {
                    body.child(self.gift_button(
                        "clear-gift-buyer",
                        Key::GiftRemoveBuyer,
                        Kind::Ghost,
                        |root, cx| {
                            if let Some(desk) = root.gift_cards_desk() {
                                desk.buyer = None;
                                desk.buyer_search.update(cx, |field, cx| field.clear(cx));
                                cx.notify();
                            }
                        },
                        cx,
                    ))
                })
            })
            .when(desk.buyer.is_none(), |body| {
                body.child(desk.buyer_search.clone())
                    .children(choices.into_iter().map(|(id, name)| {
                        self.button(
                            SharedString::from(format!("gift-buyer-option-{id}")),
                            name.clone(),
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| {
                                if let Some(desk) = root.gift_cards_desk() {
                                    desk.buyer = Some((id, name.clone()));
                                    cx.notify();
                                }
                            }),
                        )
                    }))
            })
            .when(ready, |body| {
                body.child(self.gift_button(
                    "submit-gift-issue",
                    Key::SaleCreateReceipt,
                    Kind::Primary,
                    Root::issue_gift,
                    cx,
                ))
            })
    }

    fn render_gift_detail(
        &self,
        desk: &Desk,
        id: Uuid,
        ready: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let Some(card) = &desk.card else {
            return div().when(ready, |body| {
                body.child(self.gift_button(
                    "retry-gift-detail",
                    Key::GiftRefresh,
                    Kind::Ghost,
                    move |root, cx| root.request_gift(Request::Detail(id, 1), cx),
                    cx,
                ))
            });
        };
        let title = if card.label.is_empty() {
            self.t(Key::SalesGiftCard)
        } else {
            &card.label
        };
        let money = |cents| self.amount_label(cents, &card.balance.currency);
        let mut body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(title.to_owned()),
            )
            .child(format!(
                "{} · {}",
                self.t(Key::GiftValue),
                money(i64::from(card.amount_cents))
            ))
            .child(self.render_gift_balance(&card.balance));
        if let Some(edit) = desk.edit {
            return body
                .child(self.label(if edit == Edit::Expiry {
                    Key::GiftEditExpiry
                } else {
                    Key::GiftReissue
                }))
                .when(edit == Edit::Expiry, |body| {
                    body.child(self.label(Key::GiftExpiryInput))
                        .child(desk.expiry.clone())
                })
                .when(edit == Edit::Reissue, |body| {
                    body.child(self.t(Key::GiftReissueHelp))
                })
                .child(self.label(Key::GiftReason))
                .child(desk.reason.clone())
                .when(ready, |body| {
                    body.child(self.gift_button(
                        "commit-gift-edit",
                        Key::GiftSave,
                        Kind::Primary,
                        Root::commit_gift_edit,
                        cx,
                    ))
                });
        }
        if let Some(code) = &desk.revealed {
            let text = code.clone();
            body = body.child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_2()
                    .child(code.clone())
                    .child(self.gift_button(
                        "copy-gift-code",
                        Key::GiftCopyCode,
                        Kind::Ghost,
                        move |_, cx| {
                            cx.write_to_clipboard(gpui::ClipboardItem::new_string(text.clone()))
                        },
                        cx,
                    ))
                    .when(ready, |buttons| {
                        buttons.child(self.gift_button(
                            "print-gift-voucher",
                            Key::GiftPrint,
                            Kind::Ghost,
                            move |root, cx| root.print_gift(id, cx),
                            cx,
                        ))
                    })
                    .child(self.gift_button(
                        "hide-gift-code",
                        Key::GiftHideCode,
                        Kind::Ghost,
                        |root, cx| {
                            if let Some(desk) = root.gift_cards_desk() {
                                desk.revealed = None;
                                cx.notify();
                            }
                        },
                        cx,
                    )),
            );
        }
        let receipt = card.checkout_id;
        body = body.when(ready, |body| {
            body.child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.gift_button(
                        "open-gift-receipt",
                        Key::SaleCreateReceipt,
                        Kind::Ghost,
                        move |root, cx| root.request_gift(Request::Checkout(receipt), cx),
                        cx,
                    ))
                    .child(self.gift_button(
                        "refresh-gift-detail",
                        Key::GiftRefresh,
                        Kind::Ghost,
                        move |root, cx| root.request_gift(Request::Detail(id, 1), cx),
                        cx,
                    ))
                    .when(
                        desk.revealed.is_none()
                            && matches!(
                                card.balance.status,
                                GiftStatus::Active | GiftStatus::Expired
                            ),
                        |row| {
                            row.child(self.gift_button(
                                "reveal-gift-code",
                                Key::GiftRevealCode,
                                Kind::Ghost,
                                move |root, cx| root.request_gift(Request::Reveal(id), cx),
                                cx,
                            ))
                        },
                    )
                    .when(desk.can_manage, |row| {
                        row.child(self.gift_button(
                            "edit-gift-expiry",
                            Key::GiftEditExpiry,
                            Kind::Ghost,
                            |root, cx| root.start_gift_edit(Edit::Expiry, cx),
                            cx,
                        ))
                        .when(
                            matches!(
                                card.balance.status,
                                GiftStatus::Active | GiftStatus::Expired
                            ),
                            |row| {
                                row.child(self.gift_button(
                                    "reissue-gift-code",
                                    Key::GiftReissue,
                                    Kind::Ghost,
                                    |root, cx| root.start_gift_edit(Edit::Reissue, cx),
                                    cx,
                                ))
                            },
                        )
                    }),
            )
        });
        if let Some(history) = &desk.movements {
            let pagination = &history.pagination;
            body = body
                .child(self.label(Key::GiftMovements))
                .when(history.movements.is_empty(), |body| {
                    body.child(self.t(Key::GiftNoMovements))
                })
                .children(history.movements.iter().map(|item| {
                    div().text_sm().child(format!(
                        "{} · {} · {}",
                        self.date_time_label(item.created_at),
                        self.t(gift_movement_key(item.kind)),
                        money(item.amount_cents),
                    ))
                }))
                .when(ready, |body| {
                    body.child(
                        div()
                            .flex()
                            .gap_2()
                            .when(pagination.page > 1, |row| {
                                let page = pagination.page - 1;
                                row.child(self.gift_button(
                                    "previous-gift-movements",
                                    Key::GiftPrevious,
                                    Kind::Ghost,
                                    move |root, cx| {
                                        root.request_gift(Request::Detail(id, page), cx)
                                    },
                                    cx,
                                ))
                            })
                            .when(pagination.has_next(), |row| {
                                let page = pagination.page + 1;
                                row.child(self.gift_button(
                                    "next-gift-movements",
                                    Key::GiftNext,
                                    Kind::Ghost,
                                    move |root, cx| {
                                        root.request_gift(Request::Detail(id, page), cx)
                                    },
                                    cx,
                                ))
                            }),
                    )
                });
        }
        body
    }
}

fn gift_status_key(value: GiftStatus) -> Key {
    match value {
        GiftStatus::Pending => Key::GiftPending,
        GiftStatus::Active => Key::GiftActive,
        GiftStatus::Void => Key::SalesStatusVoid,
        GiftStatus::Expired => Key::GiftExpired,
    }
}

fn gift_movement_key(value: GiftMovementKind) -> Key {
    match value {
        GiftMovementKind::Activation => Key::GiftActivation,
        GiftMovementKind::Redemption => Key::GiftRedemption,
        GiftMovementKind::RedemptionRefund => Key::GiftRedemptionRefund,
        GiftMovementKind::PurchaseRefund => Key::GiftPurchaseRefund,
        GiftMovementKind::PurchaseRefundReversal => Key::GiftPurchaseRefundReversal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn searching_sends_only_the_last_four_characters_of_a_gift_code() {
        assert_eq!(search_term("SOB-AABB-CCDD-0011-2233-4455-6677"), "6677");
        assert_eq!(search_term("sobaabbccdd0011223344556677"), "6677");
        assert_eq!(search_term("SOB-AA"), "");
        assert_eq!(search_term("sobaabbccdd001122334455667"), "");
        assert_eq!(search_term("  Regalo Natalia  "), "Regalo Natalia");
    }

    #[test]
    fn the_last_valid_day_uses_midnight_in_the_centres_time_zone() {
        let expiry = expiry_date(chrono_tz::Europe::Madrid, "2026-03-29").flatten();
        assert_eq!(expiry.unwrap().to_rfc3339(), "2026-03-29T22:00:00+00:00");
        assert_eq!(expiry_date(chrono_tz::Europe::Madrid, ""), Some(None));
        assert_eq!(expiry_date(chrono_tz::Europe::Madrid, "2026-02-31"), None);
    }
    #[gpui::test]
    async fn closed_gift_desk_reopens_the_same_unconfirmed_purchase(cx: &mut gpui::TestAppContext) {
        let (_directory, window) = crate::root::tests::open(cx);
        window.update(cx, |root, _, cx| {
            let actor = root.svc.current_session().expect("local test session").user_id;
            let purchase = GiftPurchase::review("25,00", "Regalo", None, None, "reviewed".into(), Utc::now()).unwrap();
            assert!(root.svc.store.reserve_gift_purchase(&actor, &purchase).unwrap());
            root.status.connectivity = Connectivity::Offline;
            root.open_gift_cards(cx);
            assert!(matches!(&root.overlay, Overlay::GiftCards(desk) if desk.view == View::Issue));
            root.issue_gift(cx);
            root.dismiss_gift_cards(cx);
            root.dismiss_gift_cards(cx);
            root.open_gift_cards(cx);
            assert!(matches!(&root.overlay, Overlay::GiftCards(desk)
                if desk.view == View::Issue
                    && desk.purchase.as_ref().is_some_and(|saved| saved.idempotency_key == purchase.idempotency_key)));
            assert_eq!(root.svc.store.outbox_len().unwrap(), 0);
        }).unwrap();
    }
}
