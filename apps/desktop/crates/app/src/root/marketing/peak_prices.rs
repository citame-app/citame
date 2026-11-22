use super::*;
use chrono::Weekday;
use sob_core::booking::{
    MAX_PEAK_PRICE_RULES, MAX_PEAK_PRICE_SERVICES, PeakPricePolicy, PeakPriceRule,
};
use sob_core::booking_policy::PolicyWriteError;

const DAYS: [Weekday; 7] = [
    Weekday::Mon,
    Weekday::Tue,
    Weekday::Wed,
    Weekday::Thu,
    Weekday::Fri,
    Weekday::Sat,
    Weekday::Sun,
];

pub(super) struct PeakPriceDesk {
    identity: Arc<()>,
    baseline: Option<PeakPricePolicy>,
    draft: Vec<PeakPriceRule>,
    editor: Option<RuleEditor>,
    pending: Option<PeakPricePolicy>,
    pub(super) busy: bool,
    pub(super) confirm_exit: bool,
    error: Option<Key>,
    saved: bool,
    stale: bool,
}

struct RuleEditor {
    index: Option<usize>,
    rule: PeakPriceRule,
    start: Entity<TextField>,
    end: Entity<TextField>,
    increase: Entity<TextField>,
    search: Entity<TextField>,
}

impl PeakPriceDesk {
    fn dirty(&self) -> bool {
        self.editor.is_some()
            || self
                .baseline
                .as_ref()
                .is_some_and(|base| base.rules != self.draft)
    }
}

fn clock(minute: u16) -> String {
    format!("{:02}:{:02}", minute / 60, minute % 60)
}

fn editor_field(label: &'static str, initial: &str, cx: &mut Context<Root>) -> Entity<TextField> {
    cx.new(|cx| {
        let mut field = TextField::new(label, false, cx);
        field.set_text(initial, cx);
        field
    })
}

impl Root {
    fn peak_price_desk(&mut self) -> Option<&mut PeakPriceDesk> {
        self.marketing_desk()?.peak_prices.as_mut()
    }

    pub(super) fn open_peak_prices(&mut self, cx: &mut Context<Self>) {
        if let Some(desk) = self.marketing_desk() {
            desk.peak_prices = Some(PeakPriceDesk {
                identity: Arc::new(()),
                baseline: None,
                draft: Vec::new(),
                editor: None,
                pending: None,
                busy: false,
                confirm_exit: false,
                error: None,
                saved: false,
                stale: false,
            });
            self.request_peak_prices(false, cx);
        }
    }

    pub(super) fn back_from_peak_prices(&mut self, cx: &mut Context<Self>) {
        let Some(desk) = self.marketing_desk() else {
            return;
        };
        let Some(peak) = desk.peak_prices.as_mut() else {
            return;
        };
        if peak.busy {
            return;
        }
        if !peak.confirm_exit && (peak.dirty() || peak.pending.is_some()) {
            peak.confirm_exit = true;
        } else {
            desk.peak_prices = None;
        }
        cx.notify();
    }

    pub(super) fn refresh_peak_prices(&mut self, reconnected: bool, cx: &mut Context<Self>) {
        let remote_version = self
            .svc
            .store
            .peak_price_snapshot()
            .ok()
            .flatten()
            .map(|snapshot| snapshot.version);
        let refresh = self.peak_price_desk().is_some_and(|peak| {
            !peak.busy
                && !peak.dirty()
                && peak.pending.is_none()
                && (reconnected
                    || peak.baseline.as_ref().is_some_and(|base| {
                        remote_version.is_some_and(|version| version != base.version)
                    }))
        });
        if refresh {
            self.request_peak_prices(false, cx);
        }
    }

    fn request_peak_prices(&mut self, write: bool, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let session = self.svc.session.clone();
        let Some(peak) = self.peak_price_desk().filter(|peak| !peak.busy) else {
            return;
        };
        if write {
            if peak.stale || peak.editor.is_some() {
                return;
            }
            if peak.pending.is_none() {
                let Some(baseline) = peak.baseline.as_ref().filter(|_| peak.dirty()) else {
                    return;
                };
                peak.pending = Some(PeakPricePolicy {
                    rules: peak.draft.clone(),
                    ..baseline.clone()
                });
            }
        }
        let pending = if write { peak.pending.clone() } else { None };
        let identity = peak.identity.clone();
        peak.busy = true;
        peak.error = None;
        peak.saved = false;
        cx.notify();
        cx.spawn(async move |view, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match pending.as_ref() {
                        Some(policy) => transport.write_peak_price_policy(policy),
                        None => transport
                            .peak_price_policy()
                            .map_err(PolicyWriteError::from),
                    }
                })
                .await;
            let _ = view.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || root.svc.current_session().is_none()
                {
                    return;
                }
                let Some(peak) = root
                    .peak_price_desk()
                    .filter(|peak| Arc::ptr_eq(&peak.identity, &identity))
                else {
                    return;
                };
                peak.busy = false;
                match result {
                    Ok(policy) => {
                        peak.draft = policy.rules.clone();
                        peak.baseline = Some(policy);
                        peak.editor = None;
                        peak.pending = None;
                        peak.stale = false;
                        peak.confirm_exit = false;
                        peak.saved = write;
                    }
                    Err(PolicyWriteError::Conflict) => {
                        peak.pending = None;
                        peak.stale = true;
                        peak.error = Some(Key::PeakPriceStale);
                    }
                    Err(PolicyWriteError::Transport(
                        TransportError::Unauthorized
                        | TransportError::Forbidden(_)
                        | TransportError::BadRequest(_),
                    )) => {
                        peak.pending = None;
                        peak.error = Some(Key::PeakPriceLoadFailed);
                    }
                    Err(_) => {
                        peak.error = Some(if write {
                            Key::PeakPriceUnconfirmed
                        } else {
                            Key::PeakPriceLoadFailed
                        });
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn edit_peak_rule(&mut self, index: Option<usize>, cx: &mut Context<Self>) {
        let labels = [
            self.t(Key::PeakPriceFrom),
            self.t(Key::PeakPriceUntil),
            self.t(Key::PeakPricePercent),
            self.t(Key::SearchServices),
        ];
        let Some(peak) = self
            .peak_price_desk()
            .filter(|peak| !peak.busy && peak.pending.is_none() && !peak.stale)
        else {
            return;
        };
        let rule = match index {
            Some(index) => {
                let Some(rule) = peak.draft.get(index) else {
                    return;
                };
                rule.clone()
            }
            None if peak.draft.len() < MAX_PEAK_PRICE_RULES => PeakPriceRule::default(),
            None => return,
        };
        peak.editor = Some(RuleEditor {
            index,
            start: editor_field(labels[0], &clock(rule.start_minute), cx),
            end: editor_field(labels[1], &clock(rule.end_minute), cx),
            increase: editor_field(
                labels[2],
                &sob_core::reports::decimal_amount(u64::from(rule.increase_basis_points)),
                cx,
            ),
            search: editor_field(labels[3], "", cx),
            rule,
        });
        peak.error = None;
        peak.confirm_exit = false;
        cx.notify();
    }

    fn apply_peak_rule(&mut self, cx: &mut Context<Self>) {
        let Some(peak) = self.peak_price_desk() else {
            return;
        };
        let Some(editor) = peak.editor.as_ref() else {
            return;
        };
        let Some(rule) = editor.rule.clone().with_input(
            editor.start.read(cx).text(),
            editor.end.read(cx).text(),
            editor.increase.read(cx).text(),
        ) else {
            peak.error = Some(Key::PeakPriceInvalid);
            cx.notify();
            return;
        };
        match editor.index {
            Some(index) => peak.draft[index] = rule,
            None => peak.draft.push(rule),
        }
        peak.editor = None;
        peak.error = None;
        cx.notify();
    }

    pub(super) fn render_peak_prices(
        &self,
        peak: &PeakPriceDesk,
        online: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let mut body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(self.label(Key::PeakPriceTitle))
            .child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.t(Key::PeakPriceHelp)),
            )
            .child(div().text_sm().child(self.tz.to_string()));
        if peak.busy {
            return body.child(self.t(Key::MarketingLoading));
        }
        body = body.when_some(peak.error, |body, key| {
            body.child(div().text_color(theme::conflict_fg()).child(self.t(key)))
        });
        if let Some(editor) = &peak.editor {
            return body.child(self.render_peak_rule(editor, cx));
        }
        if peak.saved {
            body = body.child(self.t(Key::PeakPriceSaved));
        }
        if !online {
            return body.child(self.t(Key::MarketingUnavailable));
        }
        if peak.baseline.is_none() || peak.stale || peak.pending.is_some() {
            return body.child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.marketing_button(
                        "peak-reload",
                        Key::PolicyReload,
                        Kind::Ghost,
                        |root, cx| root.request_peak_prices(false, cx),
                        cx,
                    ))
                    .when(peak.pending.is_some(), |buttons| {
                        buttons.child(self.marketing_button(
                            "peak-retry",
                            Key::MarketingRetry,
                            Kind::Primary,
                            |root, cx| root.request_peak_prices(true, cx),
                            cx,
                        ))
                    }),
            );
        }
        body = body.children(peak.draft.iter().enumerate().map(|(index, rule)| {
            let day = DAYS
                .get(usize::from(rule.weekday.saturating_sub(1)))
                .copied()
                .unwrap_or(Weekday::Mon);
            let amount = sob_core::reports::decimal_amount(u64::from(rule.increase_basis_points));
            let names = rule
                .service_ids
                .iter()
                .map(|id| {
                    self.services
                        .iter()
                        .find(|service| &service.id == id)
                        .map_or(id.as_str(), |service| service.name.as_str())
                })
                .collect::<Vec<_>>()
                .join(", ");
            div()
                .p_3()
                .rounded_md()
                .bg(theme::bg())
                .flex()
                .flex_col()
                .gap_2()
                .child(format!(
                    "{} · {}–{} · +{amount}%",
                    i18n::weekday_short(self.locale, day),
                    clock(rule.start_minute),
                    clock(rule.end_minute)
                ))
                .child(div().text_sm().child(if names.is_empty() {
                    self.t(Key::PeakPriceAll).to_owned()
                } else {
                    names
                }))
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .child(self.marketing_button(
                            ("peak-edit", index),
                            Key::PeakPriceEdit,
                            Kind::Ghost,
                            move |root, cx| root.edit_peak_rule(Some(index), cx),
                            cx,
                        ))
                        .when(peak.draft.len() < MAX_PEAK_PRICE_RULES, |buttons| {
                            buttons.child(self.marketing_button(
                                ("peak-copy", index),
                                Key::PeakPriceCopy,
                                Kind::Ghost,
                                move |root, cx| {
                                    if let Some(peak) = root.peak_price_desk()
                                        && peak.draft.len() < MAX_PEAK_PRICE_RULES
                                        && let Some(mut rule) = peak.draft.get(index).cloned()
                                    {
                                        rule.weekday = (rule.weekday % 7) + 1;
                                        peak.draft.push(rule);
                                        cx.notify();
                                    }
                                },
                                cx,
                            ))
                        })
                        .child(self.marketing_button(
                            ("peak-remove", index),
                            Key::PeakPriceRemove,
                            Kind::Ghost,
                            move |root, cx| {
                                if let Some(peak) = root.peak_price_desk()
                                    && index < peak.draft.len()
                                {
                                    peak.draft.remove(index);
                                    cx.notify();
                                }
                            },
                            cx,
                        )),
                )
        }));
        body.child(
            div()
                .flex()
                .flex_wrap()
                .gap_2()
                .when(peak.draft.len() < MAX_PEAK_PRICE_RULES, |buttons| {
                    buttons.child(self.marketing_button(
                        "peak-add",
                        Key::PeakPriceAdd,
                        Kind::Ghost,
                        |root, cx| root.edit_peak_rule(None, cx),
                        cx,
                    ))
                })
                .when(peak.dirty(), |buttons| {
                    buttons.child(self.marketing_button(
                        "peak-save",
                        Key::PeakPriceSave,
                        Kind::Primary,
                        |root, cx| root.request_peak_prices(true, cx),
                        cx,
                    ))
                }),
        )
    }

    fn render_peak_rule(&self, editor: &RuleEditor, cx: &mut Context<Self>) -> gpui::Div {
        let search = editor.search.read(cx).text().to_lowercase();
        let selected = |id: &str| {
            editor
                .rule
                .service_ids
                .iter()
                .any(|selected| selected == id)
        };
        let service_choices = editor
            .rule
            .service_ids
            .iter()
            .map(|id| {
                let name = self
                    .services
                    .iter()
                    .find(|service| &service.id == id)
                    .map_or(id.as_str(), |service| service.name.as_str());
                (id, name)
            })
            .chain(
                self.services
                    .iter()
                    .filter(|service| {
                        service.active
                            && !selected(&service.id)
                            && service.name.to_lowercase().contains(&search)
                    })
                    .take(15)
                    .map(|service| (&service.id, service.name.as_str())),
            );
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .children(DAYS.into_iter().enumerate().map(|(index, day)| {
                        let weekday = index as u8 + 1;
                        self.chip(
                            ("peak-weekday", index),
                            i18n::weekday_short(self.locale, day),
                            editor.rule.weekday == weekday,
                            cx.listener(move |root, _, _, cx| {
                                if let Some(editor) =
                                    root.peak_price_desk().and_then(|peak| peak.editor.as_mut())
                                {
                                    editor.rule.weekday = weekday;
                                    cx.notify();
                                }
                            }),
                        )
                        .tab_index(0)
                    })),
            )
            .children(
                [
                    (Key::PeakPriceFrom, &editor.start),
                    (Key::PeakPriceUntil, &editor.end),
                    (Key::PeakPricePercent, &editor.increase),
                ]
                .into_iter()
                .map(|(label, field)| {
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(self.label(label))
                        .child(field.clone())
                }),
            )
            .child(editor.search.clone())
            .when(editor.rule.service_ids.is_empty(), |body| {
                body.child(self.t(Key::PeakPriceAll))
            })
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .children(service_choices.map(|(id, name)| {
                        let id = id.clone();
                        self.chip(
                            SharedString::from(format!("peak-service-{id}")),
                            SharedString::from(name.to_owned()),
                            selected(&id),
                            cx.listener(move |root, _, _, cx| {
                                if let Some(editor) =
                                    root.peak_price_desk().and_then(|peak| peak.editor.as_mut())
                                {
                                    let selected = &mut editor.rule.service_ids;
                                    if let Some(index) =
                                        selected.iter().position(|item| item == &id)
                                    {
                                        selected.remove(index);
                                    } else if selected.len() < MAX_PEAK_PRICE_SERVICES {
                                        selected.push(id.clone());
                                    }
                                    cx.notify();
                                }
                            }),
                        )
                        .tab_index(0)
                    })),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.marketing_button(
                        "peak-editor-back",
                        Key::Back,
                        Kind::Ghost,
                        |root, cx| {
                            if let Some(peak) = root.peak_price_desk() {
                                peak.editor = None;
                                peak.error = None;
                                cx.notify();
                            }
                        },
                        cx,
                    ))
                    .child(self.marketing_button(
                        "peak-editor-apply",
                        Key::PeakPriceReview,
                        Kind::Primary,
                        Root::apply_peak_rule,
                        cx,
                    )),
            )
    }
}
