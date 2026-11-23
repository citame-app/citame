use super::*;
use sob_core::billing::parse_reviewed_amount;
use sob_core::promotions::PromotionWriteError;
use sob_core::promotions::{
    Discount, Eligible, LIVE_TOPIC, Promotion, PromotionsPage, SavePromotion, Terms, Timing,
    local_input, parse_instant, parse_minute,
};
use sob_core::reports::decimal_amount;
use std::collections::BTreeSet;
use std::time::{Duration, Instant};
use uuid::Uuid;

const DAYS: [chrono::Weekday; 7] = [
    chrono::Weekday::Mon,
    chrono::Weekday::Tue,
    chrono::Weekday::Wed,
    chrono::Weekday::Thu,
    chrono::Weekday::Fri,
    chrono::Weekday::Sat,
    chrono::Weekday::Sun,
];

const FIELDS: [Key; 12] = [
    Key::PromoName,
    Key::PromoCode,
    Key::PromoValue,
    Key::PromoMinimum,
    Key::PromoCap,
    Key::PromoLimit,
    Key::PromoPerClient,
    Key::PromoStart,
    Key::PromoEnd,
    Key::PromoFromTime,
    Key::PromoBeforeTime,
    Key::PromoLead,
];

pub(super) struct PromoDesk {
    identity: Arc<()>,
    search: Entity<TextField>,
    applied_search: String,
    list: Option<PromotionsPage>,
    generation: Option<String>,
    editor: Option<Editor>,
    loading: bool,
    list_request: Option<Arc<()>>,
    saving: bool,
    refresh_after: Instant,
    observed: Option<i64>,
    retry_after: Option<(Instant, Duration)>,
    error: Option<Key>,
    saved: bool,
    confirm_exit: bool,
}

enum ListRequest {
    Search,
    Page(u32),
    Refresh(u32),
}

struct Editor {
    initial: Option<Promotion>,
    time_zone: chrono_tz::Tz,
    generation: String,
    fields: [Entity<TextField>; 12],
    kind: Discount,
    active: bool,
    show_online: bool,
    timed: bool,
    kinds: BTreeSet<Eligible>,
    weekdays: BTreeSet<u8>,
    service_ids: BTreeSet<Uuid>,
    service_search: Entity<TextField>,
    pending: Option<SavePromotion>,
    stale: bool,
}

fn optional_number(value: &str) -> Option<Option<u32>> {
    if value.is_empty() {
        Some(None)
    } else {
        value.parse().ok().map(Some)
    }
}

fn optional_amount(value: &str) -> Option<Option<u32>> {
    if value.is_empty() {
        Some(None)
    } else {
        parse_reviewed_amount(value).map(Some)
    }
}

fn input(text: &str, placeholder: &'static str, cx: &mut Context<Root>) -> Entity<TextField> {
    cx.new(|cx| {
        let mut field = TextField::new(placeholder, false, cx);
        field.set_text(text, cx);
        field
    })
}

impl Editor {
    fn new(
        initial: Option<Promotion>,
        tz: chrono_tz::Tz,
        generation: String,
        service_placeholder: &'static str,
        cx: &mut Context<Root>,
    ) -> Self {
        let terms = initial.as_ref().map(|p| &p.terms);
        let timing = terms.and_then(|terms| terms.timing.as_ref());
        let number = |value: Option<u32>| value.map(|value| value.to_string()).unwrap_or_default();
        let amount = |value: u32| decimal_amount(u64::from(value));
        let values = [
            terms.map_or("", |t| &t.name).into(),
            terms.map_or("", |t| &t.code).into(),
            amount(terms.map_or(1000, |t| t.value)),
            amount(terms.map_or(0, |t| t.minimum_spend_cents)),
            terms
                .and_then(|t| t.maximum_discount_cents)
                .map(amount)
                .unwrap_or_default(),
            number(terms.and_then(|t| t.usage_limit)),
            number(terms.map_or(Some(1), |t| t.per_client_limit)),
            local_input(tz, terms.and_then(|t| t.starts_at)),
            local_input(tz, terms.and_then(|t| t.ends_at)),
            timing
                .map(|t| i18n::promotion_clock(t.start_minute))
                .unwrap_or_default(),
            timing
                .map(|t| i18n::promotion_clock(t.end_minute))
                .unwrap_or_default(),
            number(timing.and_then(|t| t.last_minute_hours).map(u32::from)),
        ];
        let service_search = input("", service_placeholder, cx);
        cx.subscribe(&service_search, |_, _, event, cx| {
            if matches!(event, FieldEvent::Changed) {
                cx.notify();
            }
        })
        .detach();
        Self {
            fields: values.map(|value: String| input(&value, "", cx)),
            kind: terms.map_or(Discount::Percent, |t| t.kind),
            active: terms.is_none_or(|t| t.active),
            show_online: terms.is_some_and(|t| t.show_online == Some(true)),
            timed: timing.is_some(),
            kinds: terms.map_or_else(
                || BTreeSet::from([Eligible::Service, Eligible::Product, Eligible::Custom]),
                |t| t.eligible_kinds.iter().copied().collect(),
            ),
            weekdays: timing
                .map(|t| t.weekdays.iter().copied().collect())
                .unwrap_or_default(),
            service_ids: terms
                .map(|t| t.service_ids.iter().copied().collect())
                .unwrap_or_default(),
            service_search,
            initial,
            time_zone: tz,
            generation,
            pending: None,
            stale: false,
        }
    }

    fn submission(&self, generation: String, cx: &App) -> Option<SavePromotion> {
        let field = |index: usize| self.fields[index].read(cx).text().trim();
        let initial = self.initial.as_ref();
        let timing = if self.timed {
            Some(Timing {
                weekdays: self.weekdays.iter().copied().collect(),
                start_minute: parse_minute(field(9), false)?,
                end_minute: parse_minute(field(10), true)?,
                last_minute_hours: optional_number(field(11))?
                    .map(u16::try_from)
                    .transpose()
                    .ok()?,
            })
        } else {
            None
        };
        let terms = Terms {
            name: field(0).to_owned(),
            code: field(1).to_uppercase(),
            kind: self.kind,
            value: parse_reviewed_amount(field(2))?,
            minimum_spend_cents: parse_reviewed_amount(field(3))?,
            maximum_discount_cents: optional_amount(field(4))?,
            usage_limit: optional_number(field(5))?,
            per_client_limit: optional_number(field(6))?,
            starts_at: parse_instant(
                self.time_zone,
                field(7),
                initial.and_then(|p| p.terms.starts_at),
            )?,
            ends_at: parse_instant(
                self.time_zone,
                field(8),
                initial.and_then(|p| p.terms.ends_at),
            )?,
            eligible_kinds: self.kinds.iter().copied().collect(),
            service_ids: self.service_ids.iter().copied().collect(),
            active: self.active,
            show_online: (self.show_online
                || initial.is_some_and(|p| p.terms.show_online == Some(true)))
            .then_some(self.show_online),
            timing,
        };
        terms.valid().then_some(SavePromotion {
            generation,
            revision: initial.map(|p| (p.id, p.version)),
            terms,
        })
    }
}

impl Root {
    fn promotion_desk(&mut self) -> Option<&mut PromoDesk> {
        self.marketing_desk()?.promotions.as_mut()
    }

    pub(super) fn open_promotions(&mut self, cx: &mut Context<Self>) {
        let search = self.t(Key::PromoSearch);
        let Some(desk) = self.marketing_desk() else {
            return;
        };
        desk.promotions = Some(PromoDesk {
            identity: Arc::new(()),
            search: input("", search, cx),
            applied_search: String::new(),
            list: None,
            generation: None,
            editor: None,
            loading: false,
            list_request: None,
            saving: false,
            refresh_after: Instant::now(),
            observed: None,
            retry_after: None,
            error: None,
            saved: false,
            confirm_exit: false,
        });
        self.load_promotions(ListRequest::Search, cx);
        cx.notify();
    }

    pub(super) fn refresh_promotions(&mut self, reconnected: bool, cx: &mut Context<Self>) {
        let observed = self.svc.store.live_view_revision(LIVE_TOPIC).ok();
        let now = Instant::now();
        let Some(desk) = self.promotion_desk() else {
            return;
        };
        if desk.saving
            || desk.list_request.is_some()
            || desk
                .retry_after
                .is_some_and(|(started, delay)| now.duration_since(started) < delay)
            || (!reconnected && desk.observed == observed && now < desk.refresh_after)
        {
            return;
        }
        let page = desk.list.as_ref().map_or(1, |list| list.pagination.page);
        self.load_promotions(ListRequest::Refresh(page), cx);
    }

    fn load_promotions(&mut self, request: ListRequest, cx: &mut Context<Self>) {
        let background = matches!(request, ListRequest::Refresh(_));
        let page = match request {
            ListRequest::Search => 1,
            ListRequest::Page(page) | ListRequest::Refresh(page) => page,
        };
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let generation = self.svc.store.verified_reviewed_generation().ok();
        let observed = self.svc.store.live_view_revision(LIVE_TOPIC).ok();
        let session = self.svc.session.clone();
        let Some(desk) = self
            .promotion_desk()
            .filter(|desk| !desk.loading && !desk.saving)
        else {
            return;
        };
        if matches!(request, ListRequest::Search) {
            let search = desk.search.read(cx).text().trim();
            if search.encode_utf16().count() > 100 {
                desk.error = Some(Key::PromoInvalid);
                cx.notify();
                return;
            }
            desk.applied_search = search.to_owned();
        }
        let search = desk.applied_search.clone();
        let list_request = Arc::new(());
        desk.list_request = Some(list_request.clone());
        desk.loading = !background;
        if desk.editor.is_none() {
            desk.error = None;
        }
        let identity = desk.identity.clone();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.promotions(page, &search) })
                .await;
            let _ = root.update(cx, move |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || root.svc.current_session().is_none()
                {
                    return;
                }
                let Some(desk) = root.promotion_desk().filter(|desk| {
                    Arc::ptr_eq(&identity, &desk.identity)
                        && desk
                            .list_request
                            .as_ref()
                            .is_some_and(|current| Arc::ptr_eq(current, &list_request))
                }) else {
                    return;
                };
                desk.loading = false;
                desk.list_request = None;
                desk.refresh_after = Instant::now() + Duration::from_secs(10);
                match result {
                    Ok(list) => {
                        desk.observed = observed;
                        desk.retry_after = None;
                        desk.list = Some(list);
                        desk.generation = generation;
                    }
                    Err(TransportError::Forbidden(_) | TransportError::Unauthorized) => {
                        desk.observed = observed;
                        desk.retry_after = None;
                        desk.list = None;
                        desk.editor = None;
                        desk.generation = None;
                        desk.confirm_exit = false;
                        desk.error = Some(Key::PromoLoadFailed);
                    }
                    Err(error) => {
                        let minimum = Duration::from_secs(3);
                        let delay = match error {
                            TransportError::RateLimited(Some(retry)) => retry.max(minimum),
                            _ => minimum,
                        };
                        desk.retry_after = Some((Instant::now(), delay));
                        if !background {
                            desk.list = None;
                            desk.generation = None;
                        }
                        if desk.editor.is_none() {
                            desk.error = Some(Key::PromoLoadFailed);
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn edit_promotion(&mut self, id: Option<Uuid>, cx: &mut Context<Self>) {
        let zone = self.tz;
        let generation = self.svc.store.verified_reviewed_generation().ok();
        let service_placeholder = self.t(Key::AssignmentSearch);
        let Some(desk) = self.promotion_desk().filter(|desk| !desk.loading) else {
            return;
        };
        let Some(generation) =
            generation.filter(|generation| desk.generation.as_ref() == Some(generation))
        else {
            desk.error = Some(Key::PromoRestore);
            cx.notify();
            return;
        };
        let initial = id
            .and_then(|id| {
                desk.list
                    .as_ref()
                    .and_then(|list| list.promotions.iter().find(|p| p.id == id))
            })
            .cloned();
        if id.is_some() && initial.is_none() {
            return;
        }
        desk.editor = Some(Editor::new(
            initial,
            zone,
            generation,
            service_placeholder,
            cx,
        ));
        desk.saved = false;
        desk.error = None;
        cx.notify();
    }

    fn save_promotion(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let generation = self.svc.store.verified_reviewed_generation().ok();
        let session = self.svc.session.clone();
        let zone = self.tz;
        let Some(desk) = self
            .promotion_desk()
            .filter(|d| !d.loading && !d.saving && !d.confirm_exit)
        else {
            return;
        };
        let Some(editor) = desk.editor.as_mut().filter(|editor| !editor.stale) else {
            return;
        };
        if editor.time_zone != zone {
            editor.stale = true;
            desk.error = Some(Key::PromoTimeZoneChanged);
            cx.notify();
            return;
        }
        let Some(generation) = generation.filter(|g| &editor.generation == g) else {
            editor.stale = true;
            editor.pending = None;
            desk.error = Some(Key::PromoRestore);
            cx.notify();
            return;
        };
        let Some(packet) = editor
            .pending
            .clone()
            .or_else(|| editor.submission(generation, cx))
        else {
            desk.error = Some(Key::PromoInvalid);
            cx.notify();
            return;
        };
        editor.pending = Some(packet.clone());
        desk.saving = true;
        desk.list_request = None;
        desk.error = None;
        let identity = desk.identity.clone();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.save_promotion(&packet) })
                .await;
            let _ = root.update(cx, move |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || root.svc.current_session().is_none()
                {
                    return;
                }
                let Some(desk) = root
                    .promotion_desk()
                    .filter(|desk| Arc::ptr_eq(&identity, &desk.identity))
                else {
                    return;
                };
                desk.saving = false;
                match result {
                    Ok(_) => {
                        desk.editor = None;
                        desk.saved = true;
                        root.load_promotions(ListRequest::Page(1), cx);
                    }
                    Err(error) => {
                        let Some(editor) = desk.editor.as_mut() else {
                            return;
                        };
                        desk.error = Some(match error {
                            PromotionWriteError::Conflict => {
                                editor.pending = None;
                                editor.stale = true;
                                Key::PromoConflict
                            }
                            PromotionWriteError::Transport(
                                TransportError::ReplicaGenerationChanged,
                            ) => {
                                editor.pending = None;
                                editor.stale = true;
                                Key::PromoRestore
                            }
                            PromotionWriteError::Transport(
                                TransportError::Offline(_)
                                | TransportError::Server(_)
                                | TransportError::Unauthorized
                                | TransportError::RateLimited(_),
                            ) => Key::PromoUnconfirmed,
                            PromotionWriteError::Transport(TransportError::Forbidden(_)) => {
                                desk.editor = None;
                                desk.list = None;
                                Key::PromoLoadFailed
                            }
                            _ => {
                                editor.pending = None;
                                Key::PromoRejected
                            }
                        });
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn back_from_promotions(&mut self, confirm: bool, cx: &mut Context<Self>) {
        let Some(view) = self.promotion_desk() else {
            return;
        };
        if view.saving {
            return;
        }
        if view.editor.is_none() {
            if let Some(desk) = self.marketing_desk() {
                desk.promotions = None;
            }
        } else if view.confirm_exit && confirm {
            view.editor = None;
            view.error = None;
            view.confirm_exit = false;
            self.load_promotions(ListRequest::Page(1), cx);
        } else {
            view.confirm_exit = !view.confirm_exit;
        }
        cx.notify();
    }

    pub(super) fn render_promotions(
        &self,
        desk: &PromoDesk,
        ready: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let ready = ready && !desk.loading && !desk.saving;
        let mut body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(self.label(Key::PromoTitle))
            .when(desk.loading || desk.saving, |body| {
                body.child(self.t(Key::MarketingLoading))
            })
            .when(desk.saved, |body| body.child(self.t(Key::PromoSaved)))
            .when_some(desk.error, |body, error| {
                body.child(div().text_color(theme::conflict_fg()).child(self.t(error)))
            });
        if let Some(editor) = &desk.editor {
            return body.child(self.render_promotion_editor(desk, editor, ready, cx));
        }
        body = body.child(
            div()
                .flex()
                .flex_wrap()
                .gap_2()
                .child(desk.search.clone())
                .when(ready, |row| {
                    row.child(self.marketing_button(
                        "promo-search",
                        Key::PromoSearch,
                        Kind::Ghost,
                        |root, cx| root.load_promotions(ListRequest::Search, cx),
                        cx,
                    ))
                    .child(self.marketing_button(
                        "promo-new",
                        Key::PromoNew,
                        Kind::Primary,
                        |root, cx| root.edit_promotion(None, cx),
                        cx,
                    ))
                }),
        );
        let Some(list) = &desk.list else {
            return body;
        };
        body.when(list.promotions.is_empty(), |body| {
            body.child(self.t(Key::PromoEmpty))
        })
        .children(list.promotions.iter().map(|promotion| {
            let id = promotion.id;
            let terms = &promotion.terms;
            let amount = if terms.kind == Discount::Percent {
                format!("{}%", decimal_amount(u64::from(terms.value)))
            } else {
                format!("{} EUR", decimal_amount(u64::from(terms.value)))
            };
            div()
                .flex()
                .flex_col()
                .gap_1()
                .p_3()
                .rounded_lg()
                .border_1()
                .border_color(theme::line())
                .child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(terms.name.clone()),
                )
                .child(format!("{} · {}", terms.code, amount))
                .child(format!(
                    "{} · {} / {}",
                    self.t(Key::PromoUses),
                    promotion.used_count,
                    terms.usage_limit.map_or("∞".into(), |v| v.to_string())
                ))
                .when(terms.show_online == Some(true), |card| {
                    card.child(self.t(Key::PromoOnlineConfigured))
                })
                .when(!terms.active, |card| card.child(self.t(Key::PromoInactive)))
                .when_some(terms.timing.as_ref(), |card, timing| {
                    card.child(i18n::promotion_timing_label(
                        self.locale,
                        timing,
                        &self.tz.to_string(),
                    ))
                    .when_some(timing.last_minute_hours, |card, hours| {
                        card.child(format!("{} · {hours}", self.t(Key::PromoLead)))
                    })
                })
                .when(ready, |card| {
                    card.child(self.marketing_button(
                        SharedString::from(format!("edit-promo-{id}")),
                        Key::PromoEdit,
                        Kind::Ghost,
                        move |root, cx| root.edit_promotion(Some(id), cx),
                        cx,
                    ))
                })
        }))
        .when(ready, |body| {
            let page = list.pagination.page;
            body.child(
                div()
                    .flex()
                    .gap_2()
                    .when(page > 1, |row| {
                        row.child(self.marketing_button(
                            "promo-prev",
                            Key::MarketingPreviousPage,
                            Kind::Ghost,
                            move |root, cx| root.load_promotions(ListRequest::Page(page - 1), cx),
                            cx,
                        ))
                    })
                    .when(list.pagination.has_next(), |row| {
                        row.child(self.marketing_button(
                            "promo-next",
                            Key::MarketingNextPage,
                            Kind::Ghost,
                            move |root, cx| root.load_promotions(ListRequest::Page(page + 1), cx),
                            cx,
                        ))
                    }),
            )
        })
    }

    fn promo_toggle(
        &self,
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        selected: bool,
        action: impl Fn(&mut Editor) + 'static,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        self.chip(
            id,
            label,
            selected,
            cx.listener(move |root, _, _, cx| {
                if let Some(editor) = root.promotion_desk().and_then(|desk| desk.editor.as_mut()) {
                    action(editor);
                    cx.notify();
                }
            }),
        )
        .tab_index(0)
        .focus(|style| style.border_color(theme::text()))
    }

    fn render_promotion_editor(
        &self,
        desk: &PromoDesk,
        editor: &Editor,
        ready: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        if desk.confirm_exit {
            return div()
                .child(self.t(if editor.pending.is_some() {
                    Key::PromoExitCheck
                } else {
                    Key::MarketingDiscardWarning
                }))
                .child(self.marketing_button(
                    "continue-promotion",
                    Key::PromoContinue,
                    Kind::Ghost,
                    |root, cx| root.back_from_promotions(false, cx),
                    cx,
                ));
        }
        if editor.pending.is_some() && !editor.stale {
            return div().when(ready, |view| {
                view.child(self.marketing_button(
                    "retry-promotion",
                    Key::MarketingRetry,
                    Kind::Primary,
                    Root::save_promotion,
                    cx,
                ))
            });
        }
        let field = |index: usize| {
            div()
                .flex()
                .flex_col()
                .gap_1()
                .min_w(px(200.))
                .flex_1()
                .child(
                    self.label(if index == 2 && editor.kind == Discount::Percent {
                        Key::PromoPercentValue
                    } else {
                        FIELDS[index]
                    }),
                )
                .child(editor.fields[index].clone())
        };
        let search = editor.service_search.read(cx).text().trim().to_lowercase();
        let services = self.svc.store.services().unwrap_or_default();
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(self.label(if editor.initial.is_some() {
                Key::PromoEdit
            } else {
                Key::PromoNew
            }))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.promo_toggle(
                        "promo-percent",
                        self.t(Key::PromoPercent),
                        editor.kind == Discount::Percent,
                        |editor| editor.kind = Discount::Percent,
                        cx,
                    ))
                    .child(self.promo_toggle(
                        "promo-fixed",
                        self.t(Key::PromoFixed),
                        editor.kind == Discount::Fixed,
                        |editor| editor.kind = Discount::Fixed,
                        cx,
                    )),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .children((0..9).map(&field)),
            )
            .child(self.promo_toggle(
                "promo-timed",
                self.t(Key::PromoTimed),
                editor.timed,
                |editor| {
                    editor.timed = !editor.timed;
                    if editor.timed {
                        editor.kinds = BTreeSet::from([Eligible::Service]);
                    }
                },
                cx,
            ))
            .when(editor.timed, |body| {
                body.child(self.label(Key::PromoDays))
                    .child(editor.time_zone.to_string())
                    .child(div().flex().flex_wrap().gap_2().children(
                        DAYS.into_iter().enumerate().map(|(index, day)| {
                            let n = index as u8 + 1;
                            self.promo_toggle(
                                ("promo-day", index),
                                i18n::weekday_short(self.locale, day),
                                editor.weekdays.contains(&n),
                                move |editor| flip(&mut editor.weekdays, n),
                                cx,
                            )
                        }),
                    ))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_2()
                            .children((9..12).map(&field)),
                    )
            })
            .when(!editor.timed, |body| {
                body.child(self.label(Key::PromoScope)).child(
                    div().flex().flex_wrap().gap_2().children(
                        [
                            (Eligible::Service, Key::PromoServices),
                            (Eligible::Product, Key::PromoProducts),
                            (Eligible::Custom, Key::PromoCustom),
                        ]
                        .into_iter()
                        .enumerate()
                        .map(|(index, (kind, key))| {
                            self.promo_toggle(
                                ("promo-kind", index),
                                self.t(key),
                                editor.kinds.contains(&kind),
                                move |editor| flip(&mut editor.kinds, kind),
                                cx,
                            )
                        }),
                    ),
                )
            })
            .child(self.label(Key::PromoServiceScope))
            .child(editor.service_search.clone())
            .child(
                div()
                    .id("promotion-services")
                    .max_h(px(220.))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .children(services.iter().filter_map(|service| {
                        let id = service.id.parse::<Uuid>().ok()?;
                        if !editor.service_ids.contains(&id)
                            && !service.name.to_lowercase().contains(&search)
                        {
                            return None;
                        }
                        let label = if service.active {
                            service.name.clone()
                        } else {
                            format!("{} · {}", service.name, self.t(Key::PromoInactive))
                        };
                        Some(self.promo_toggle(
                            SharedString::from(format!("promo-service-{id}")),
                            label,
                            editor.service_ids.contains(&id),
                            move |editor| flip(&mut editor.service_ids, id),
                            cx,
                        ))
                    })),
            )
            .child(self.promo_toggle(
                "promo-active",
                self.t(Key::PromoActive),
                editor.active,
                |editor| editor.active = !editor.active,
                cx,
            ))
            .child(self.promo_toggle(
                "promo-show-online",
                self.t(Key::PromoShowOnline),
                editor.show_online,
                |editor| editor.show_online = !editor.show_online,
                cx,
            ))
            .child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.t(Key::PromoShowOnlineHelp)),
            )
            .when(ready && !editor.stale, |view| {
                view.child(self.marketing_button(
                    "save-promotion",
                    Key::PromoSave,
                    Kind::Primary,
                    Root::save_promotion,
                    cx,
                ))
            })
    }

    pub(super) fn promotion_back_key(&self, desk: &PromoDesk) -> Option<Key> {
        (!desk.saving).then_some(if desk.confirm_exit {
            Key::PromoDiscard
        } else {
            Key::Back
        })
    }
}

fn flip<T: Ord + Copy>(values: &mut BTreeSet<T>, value: T) {
    if !values.remove(&value) {
        values.insert(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[gpui::test]
    async fn promotions_open_from_marketing_without_a_campaign(cx: &mut gpui::TestAppContext) {
        let (_directory, config) = crate::root::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| {
            let mut root = Root::new(config, window, cx);
            root.svc.stop_sync();
            root.status.connectivity = Connectivity::Offline;
            root.open_marketing(cx);
            root.status.connectivity = Connectivity::Online;
            root
        });
        cx.simulate_resize(gpui::size(px(1100.), px(720.)));
        cx.run_until_parked();
        let link = cx.debug_bounds("marketing-promotions").unwrap().center();
        cx.simulate_click(link, Default::default());
        cx.run_until_parked();
        root.update(cx, |root, _| {
            assert!(root.promotion_desk().is_some());
            assert!(root.svc.store.outbox(5).unwrap().is_empty());
        });
        let back = cx.debug_bounds("back-from-promotions").unwrap().center();
        cx.simulate_click(back, Default::default());
        cx.run_until_parked();
        root.update(cx, |root, _| assert!(root.promotion_desk().is_none()));
    }
}
