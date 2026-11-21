use super::catalogue::Scope;
use super::*;
use sob_core::loyalty::stamps::{
    Appearance, RewardKind,
    programme::{APPEARANCES, AWARD_MODES, AwardOn, EXPIRY_BASES, ExpiryFrom, REWARD_KINDS},
};

fn appearance(value: Appearance) -> Key {
    match value {
        Appearance::Neutral => Key::StampAppearanceNeutral,
        Appearance::Rose => Key::StampAppearanceRose,
        Appearance::Mint => Key::StampAppearanceMint,
    }
}

fn award_on(value: AwardOn) -> Key {
    match value {
        AwardOn::Checkout => Key::StampAwardCheckout,
        AwardOn::Appointment => Key::StampAwardVisit,
    }
}

fn expiry_from(value: ExpiryFrom) -> Key {
    match value {
        ExpiryFrom::Issue => Key::StampExpiryIssue,
        ExpiryFrom::Activity => Key::StampExpiryActivity,
    }
}

fn reward_kind(value: RewardKind) -> Key {
    match value {
        RewardKind::Service => Key::StampServiceReward,
        RewardKind::Product => Key::StampProductReward,
        RewardKind::Other => Key::StampOtherReward,
    }
}

fn disposition(value: ExistingCards) -> Key {
    match value {
        ExistingCards::Keep => Key::StampProgrammeKeepCards,
        ExistingCards::Void => Key::StampProgrammeVoidCards,
    }
}

impl Root {
    fn update_stamp_draft(&mut self, update: impl FnOnce(&mut Editor), cx: &mut Context<Self>) {
        if let Some(editor) = self.stamp_programme().filter(|editor| {
            !editor.busy
                && editor.review.is_none()
                && !editor.confirm_exit
                && editor.draft.is_some()
        }) {
            update(editor);
            editor.feedback = None;
            cx.notify();
        }
    }

    fn programme_field(&self, editor: &Editor, field: Field) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(self.label(field.label()))
            .child(editor.fields[field as usize].clone())
    }

    fn stamp_choices<T: Copy + PartialEq + 'static>(
        &self,
        title: Key,
        current: T,
        options: impl IntoIterator<Item = (T, Key)>,
        update: impl Fn(&mut Editor, T) + Copy + 'static,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let options = options
            .into_iter()
            .enumerate()
            .map(|(index, (value, label))| {
                self.chip(
                    SharedString::from(format!("stamp-option-{}-{index}", self.t(title))),
                    self.t(label),
                    value == current,
                    cx.listener(move |root, _, _, cx| {
                        root.update_stamp_draft(|editor| update(editor, value), cx)
                    }),
                )
                .tab_index(0)
                .focus(|style| style.border_color(theme::text()))
            })
            .collect::<Vec<_>>();
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(self.label(title))
            .child(div().flex().flex_wrap().gap_2().children(options))
    }

    fn stamp_section(&self, title: Key) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap_3()
            .border_1()
            .border_color(theme::line())
            .rounded_lg()
            .p_3()
            .child(self.label(title))
    }

    pub(in crate::root::loyalty) fn render_stamp_programme(
        &self,
        editor: &Editor,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let ready = online && !editor.busy && !editor.limited();
        let stale = editor.base.is_some() && editor.base != editor.current && !editor.can_confirm();
        let can_mutate = self.can_configure_points();
        let mut body = div()
            .flex()
            .flex_col()
            .gap_3()
            .when(!online, |body| body.child(self.t(Key::StampOffline)))
            .when(
                editor.busy || (editor.refreshing && editor.draft.is_none()),
                |body| body.child(self.t(Key::MarketingLoading)),
            )
            .when_some(editor.feedback, |body, feedback| {
                body.child(self.t(feedback))
            })
            .when(
                stale && editor.feedback != Some(Key::StampProgrammeConflict),
                |body| body.child(self.t(Key::StampProgrammeConflict)),
            );
        if !can_mutate {
            body = body.child(self.t(Key::StampProgrammeLoadFailed));
        } else if editor.confirm_exit {
            body = body
                .child(self.t(Key::LoyaltyProgrammeDiscard))
                .child(self.loyalty_button(
                    "stamp-programme-keep-editing",
                    Key::Back,
                    Kind::Ghost,
                    |root, cx| root.close_stamp_programme(false, cx),
                    cx,
                ));
        } else if let Some(review) = &editor.review {
            body = body
                .child(self.render_programme_review(editor, review))
                .when(ready && editor.can_confirm(), |body| {
                    body.child(
                        self.loyalty_button(
                            "stamp-programme-confirm",
                            if editor.feedback == Some(Key::StampProgrammeUnconfirmed) {
                                Key::MarketingRetry
                            } else {
                                Key::LoyaltyProgrammeSave
                            },
                            Kind::Primary,
                            Root::save_stamp_programme,
                            cx,
                        )
                        .debug_selector(|| "stamp-programme-confirm".to_owned()),
                    )
                })
                .when(
                    !editor.busy && editor.feedback != Some(Key::StampProgrammeUnconfirmed),
                    |body| {
                        body.child(self.loyalty_button(
                            "stamp-programme-edit",
                            Key::Back,
                            Kind::Ghost,
                            |root, cx| {
                                if let Some(editor) = root.stamp_programme() {
                                    editor.review = None;
                                    cx.notify();
                                }
                            },
                            cx,
                        ))
                    },
                );
        } else if let Some(picker) = &editor.catalogue.picker {
            body = body.child(self.render_stamp_catalogue(editor, picker, cx));
        } else if let Some(draft) = &editor.draft {
            body = body
                .child(self.render_programme_form(editor, draft, online, cx))
                .when(ready && !stale && editor.dirty(cx), |body| {
                    body.child(
                        self.loyalty_button(
                            "stamp-programme-review",
                            Key::StampProgrammeReview,
                            Kind::Primary,
                            Root::review_stamp_programme,
                            cx,
                        )
                        .debug_selector(|| "stamp-programme-review".to_owned()),
                    )
                });
        }
        self.modal_with_height(
            div()
                .tab_group()
                .child(self.label(Key::StampProgramme))
                .child(
                    div()
                        .id("stamp-programme-scroll")
                        .min_h_0()
                        .overflow_y_scroll()
                        .child(body),
                )
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .when(
                            ready
                                && can_mutate
                                && !editor.confirm_exit
                                && editor.catalogue.picker.is_none()
                                && (editor.base.is_none()
                                    || stale
                                    || editor.feedback == Some(Key::StampProgrammeUnconfirmed)),
                            |row| {
                                row.child(self.loyalty_button(
                                    "stamp-programme-reload",
                                    Key::LoyaltyProgrammeReload,
                                    Kind::Ghost,
                                    |root, cx| root.request_stamp_programme(Request::Replace, cx),
                                    cx,
                                ))
                            },
                        )
                        .when(!editor.busy && editor.catalogue.picker.is_none(), |row| {
                            row.child(self.loyalty_button(
                                "stamp-programme-close",
                                if editor.confirm_exit {
                                    Key::LoyaltyProgrammeDrop
                                } else {
                                    Key::Close
                                },
                                Kind::Ghost,
                                |root, cx| root.close_stamp_programme(true, cx),
                                cx,
                            ))
                        }),
                ),
            (viewport.width - px(24.)).clamp(px(0.), px(690.)),
            (viewport.height - px(24.)).clamp(px(0.), px(755.)),
            None,
        )
    }

    fn render_programme_form(
        &self,
        editor: &Editor,
        draft: &ProgrammeTerms,
        online: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let card = &draft.card;
        let reward = &card.reward;
        let label = reward
            .target_id
            .and_then(|id| editor.catalogue.name(id, reward.kind));
        let general = self
            .stamp_section(Key::StampProgrammeSetup)
            .child(self.stamp_choices(
                Key::StampProgrammeStatus,
                card.enabled,
                [
                    (true, Key::StampProgrammeEnabled),
                    (false, Key::StampProgrammeDisabled),
                ],
                |editor, value| editor.draft.as_mut().unwrap().card.enabled = value,
                cx,
            ))
            .child(self.programme_field(editor, Field::Name))
            .child(self.stamp_choices(
                Key::StampProgrammeAppearance,
                card.appearance,
                APPEARANCES.map(|value| (value, appearance(value))),
                |editor, value| editor.draft.as_mut().unwrap().card.appearance = value,
                cx,
            ));
        let earning = self
            .stamp_section(Key::StampProgrammeEarning)
            .child(
                div().flex().flex_wrap().gap_3().children(
                    [Field::Goal, Field::Welcome, Field::Minimum]
                        .map(|field| self.programme_field(editor, field)),
                ),
            )
            .child(self.stamp_choices(
                Key::StampProgrammeAwardOn,
                draft.award_on,
                AWARD_MODES.map(|value| (value, award_on(value))),
                |editor, value| editor.draft.as_mut().unwrap().award_on = value,
                cx,
            ))
            .child(self.label(Key::StampProgrammeQualifying))
            .child(self.qualifying_summary(editor, draft, true, cx))
            .child(self.loyalty_button(
                "stamp-programme-qualifying",
                Key::StampProgrammeChooseServices,
                Kind::Ghost,
                |root, cx| root.open_stamp_catalogue(Scope::Qualifying, cx),
                cx,
            ))
            .when(!draft.qualifying_service_ids.is_empty(), |panel| {
                panel.child(self.loyalty_button(
                    "stamp-programme-clear-treatments",
                    Key::StampProgrammeClearServices,
                    Kind::Ghost,
                    |root, cx| {
                        root.update_stamp_draft(
                            |editor| {
                                editor
                                    .draft
                                    .as_mut()
                                    .unwrap()
                                    .qualifying_service_ids
                                    .clear();
                            },
                            cx,
                        )
                    },
                    cx,
                ))
            })
            .child(self.stamp_choices(
                Key::StampProgrammeAutomatic,
                draft.automatic_issue,
                [
                    (true, Key::StampProgrammeAutomaticOn),
                    (false, Key::StampProgrammeManualOn),
                ],
                |editor, value| editor.draft.as_mut().unwrap().automatic_issue = value,
                cx,
            ))
            .child(self.programme_field(editor, Field::StampExpiry))
            .child(self.stamp_choices(
                Key::StampProgrammeExpiryFrom,
                draft.expiry_from,
                EXPIRY_BASES.map(|value| (value, expiry_from(value))),
                |editor, value| editor.draft.as_mut().unwrap().expiry_from = value,
                cx,
            ));
        let reward_section = self
            .stamp_section(Key::StampProgrammeReward)
            .child(self.programme_field(editor, Field::RewardName))
            .child(self.stamp_choices(
                Key::StampProgrammeRewardType,
                reward.kind,
                REWARD_KINDS.map(|value| (value, reward_kind(value))),
                |editor, value| {
                    let reward = &mut editor.draft.as_mut().unwrap().card.reward;
                    if reward.kind != value {
                        reward.kind = value;
                        reward.target_id = None;
                    }
                },
                cx,
            ))
            .when(reward.kind != RewardKind::Other, |panel| {
                let scope = if reward.kind == RewardKind::Product {
                    Scope::RewardProduct
                } else {
                    Scope::RewardService
                };
                panel
                    .child(self.label(Key::StampProgrammeTarget))
                    .child(
                        label
                            .unwrap_or_else(|| {
                                self.t(if reward.target_id.is_some() {
                                    Key::StampProgrammeExistingTarget
                                } else {
                                    Key::StampProgrammeNoTarget
                                })
                            })
                            .to_owned(),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_2()
                            .when(reward.kind != RewardKind::Product || online, |row| {
                                row.child(self.loyalty_button(
                                    "stamp-programme-select-target",
                                    Key::StampProgrammeChooseTarget,
                                    Kind::Ghost,
                                    move |root, cx| root.open_stamp_catalogue(scope, cx),
                                    cx,
                                ))
                            })
                            .when(reward.target_id.is_some(), |row| {
                                row.child(self.loyalty_button(
                                    "stamp-programme-clear-target",
                                    Key::StampProgrammeClearTarget,
                                    Kind::Ghost,
                                    |root, cx| {
                                        root.update_stamp_draft(
                                            |editor| {
                                                editor
                                                    .draft
                                                    .as_mut()
                                                    .unwrap()
                                                    .card
                                                    .reward
                                                    .target_id = None
                                            },
                                            cx,
                                        )
                                    },
                                    cx,
                                ))
                            }),
                    )
            })
            .child(
                div().flex().flex_wrap().gap_3().children(
                    [Field::Discount, Field::RewardExpiry]
                        .map(|field| self.programme_field(editor, field)),
                ),
            );
        let terms_offset = editor.terms_page * TERMS_PER_PAGE;
        let terms = self
            .stamp_section(Key::StampProgrammeTerms)
            .children(
                editor
                    .terms
                    .iter()
                    .enumerate()
                    .skip(terms_offset)
                    .take(TERMS_PER_PAGE)
                    .map(|(index, line)| {
                        let id = line.clone();
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(line.clone())
                            .when(editor.terms.len() > 1, |row| {
                                row.child(self.loyalty_button(
                                    SharedString::from(format!("stamp-terms-delete-{index}")),
                                    Key::StampProgrammeRemoveLine,
                                    Kind::Ghost,
                                    move |root, cx| {
                                        root.update_stamp_draft(
                                            |editor| {
                                                editor.terms.retain(|line| *line != id);
                                                editor.update_terms_budget();
                                                editor.terms_page = editor.terms_page.min(
                                                    editor.terms.len().saturating_sub(1)
                                                        / TERMS_PER_PAGE,
                                                );
                                            },
                                            cx,
                                        )
                                    },
                                    cx,
                                ))
                            })
                    })
                    .collect::<Vec<_>>(),
            )
            .when(editor.terms_lines_remaining.get() > 0, |panel| {
                panel.child(self.loyalty_button(
                    "stamp-programme-add-line",
                    Key::StampProgrammeAddLine,
                    Kind::Ghost,
                    Root::add_stamp_terms_line,
                    cx,
                ))
            });
        let terms = terms.child(
            div()
                .flex()
                .gap_2()
                .when(editor.terms_page > 0, |row| {
                    row.child(self.loyalty_button(
                        "stamp-terms-prev",
                        Key::MarketingPreviousPage,
                        Kind::Ghost,
                        |root, cx| {
                            root.update_stamp_draft(
                                |editor| {
                                    editor.terms_page = editor.terms_page.saturating_sub(1);
                                },
                                cx,
                            )
                        },
                        cx,
                    ))
                })
                .when(terms_offset + TERMS_PER_PAGE < editor.terms.len(), |row| {
                    row.child(self.loyalty_button(
                        "stamp-terms-next",
                        Key::MarketingNextPage,
                        Kind::Ghost,
                        |root, cx| root.update_stamp_draft(|editor| editor.terms_page += 1, cx),
                        cx,
                    ))
                }),
        );
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(general)
            .child(earning)
            .child(reward_section)
            .child(terms)
            .child(self.stamp_choices(
                Key::StampProgrammeExistingCards,
                editor.existing_cards,
                [ExistingCards::Keep, ExistingCards::Void].map(|value| (value, disposition(value))),
                |editor, value| editor.existing_cards = value,
                cx,
            ))
    }

    fn qualifying_summary(
        &self,
        editor: &Editor,
        draft: &ProgrammeTerms,
        editable: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        if draft.qualifying_service_ids.is_empty() {
            return div().child(self.t(Key::StampProgrammeAnyService));
        }
        let choices = draft
            .qualifying_service_ids
            .iter()
            .map(|id| {
                let id = *id;
                let name = editor
                    .catalogue
                    .name(id, RewardKind::Service)
                    .map(str::to_owned)
                    .unwrap_or_else(|| self.t(Key::StampProgrammeUnavailableService).to_owned());
                if editable {
                    self.chip(
                        SharedString::from(format!("stamp-programme-remove-{id}")),
                        format!("{name} ×"),
                        true,
                        cx.listener(move |root, _, _, cx| {
                            root.update_stamp_draft(
                                |editor| {
                                    editor
                                        .draft
                                        .as_mut()
                                        .unwrap()
                                        .qualifying_service_ids
                                        .retain(|current| *current != id)
                                },
                                cx,
                            )
                        }),
                    )
                    .tab_index(0)
                    .focus(|style| style.border_color(theme::text()))
                    .into_any_element()
                } else {
                    div().child(name).into_any_element()
                }
            })
            .collect::<Vec<_>>();
        div().flex().flex_wrap().gap_2().children(choices)
    }

    fn render_programme_review(&self, editor: &Editor, review: &Review) -> gpui::Div {
        let draft = &review.reviewed.program;
        let card = &draft.card;
        let reward = &card.reward;
        let row = |key, value: String| div().child(self.label(key)).child(value);
        let figure = |key| self.t(key).to_owned();
        let target = reward
            .target_id
            .map(|id| {
                editor
                    .catalogue
                    .name(id, reward.kind)
                    .unwrap_or(self.t(Key::StampProgrammeExistingTarget))
                    .to_owned()
            })
            .unwrap_or_else(|| figure(Key::StampProgrammeNoTarget));
        let services: Vec<_> = draft
            .qualifying_service_ids
            .iter()
            .map(|id| {
                editor
                    .catalogue
                    .name(*id, RewardKind::Service)
                    .unwrap_or(self.t(Key::StampProgrammeUnavailableService))
            })
            .collect();
        self.stamp_section(Key::StampProgrammeReview)
            .child(row(
                Key::StampProgrammeStatus,
                figure(if card.enabled {
                    Key::StampProgrammeEnabled
                } else {
                    Key::StampProgrammeDisabled
                }),
            ))
            .child(row(
                Key::StampProgrammeAppearance,
                figure(appearance(card.appearance)),
            ))
            .children(Field::ALL.map(|field| {
                let value = field.value(draft);
                row(
                    field.label(),
                    if value.is_empty() {
                        figure(match field {
                            Field::Discount => Key::StampProgrammeNoDiscount,
                            _ => Key::LoyaltyProgrammeNoExpiry,
                        })
                    } else {
                        value
                    },
                )
            }))
            .child(row(
                Key::StampProgrammeAwardOn,
                figure(award_on(draft.award_on)),
            ))
            .child(row(
                Key::StampProgrammeQualifying,
                if services.is_empty() {
                    figure(Key::StampProgrammeAnyService)
                } else {
                    services.join(" · ")
                },
            ))
            .child(row(
                Key::StampProgrammeAutomatic,
                figure(if draft.automatic_issue {
                    Key::StampProgrammeAutomaticOn
                } else {
                    Key::StampProgrammeManualOn
                }),
            ))
            .child(row(
                Key::StampProgrammeExpiryFrom,
                figure(expiry_from(draft.expiry_from)),
            ))
            .child(row(
                Key::StampProgrammeRewardType,
                figure(reward_kind(reward.kind)),
            ))
            .when(reward.kind != RewardKind::Other, |body| {
                body.child(row(Key::StampProgrammeTarget, target))
            })
            .when(!card.terms.is_empty(), |body| {
                body.child(row(Key::StampProgrammeTerms, card.terms.clone()))
            })
            .child(row(
                Key::StampProgrammeExistingCards,
                figure(disposition(review.existing_cards)),
            ))
            .when(review.existing_cards == ExistingCards::Void, |body| {
                body.child(
                    div()
                        .text_color(theme::conflict_fg())
                        .child(self.t(Key::StampProgrammeVoidWarning)),
                )
            })
    }
}
