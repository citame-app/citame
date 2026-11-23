use super::*;

impl Root {
    pub(in crate::root) fn render_combinations(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let allowed = self.can_create_catalogue_item();
        let editable = allowed && !desk.confirm_close;
        let title = if desk
            .editor
            .as_ref()
            .is_some_and(|editor| editor.version.is_none())
        {
            Key::CombinationNew
        } else {
            Key::CombinationManagement
        };
        let content = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .flex_wrap()
                    .gap_2()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(self.t(title)),
                    )
                    .child(self.button(
                        "combinations-back",
                        self.t(Key::Back),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.close_combinations(cx)),
                    )),
            )
            .when(!allowed, |view| view.child(self.t(Key::CatalogAccessLost)))
            .when(
                allowed && self.status.connectivity != Connectivity::Online,
                |view| {
                    view.child(
                        div()
                            .text_sm()
                            .text_color(theme::muted())
                            .child(self.t(Key::CatalogOffline)),
                    )
                },
            )
            .when_some(desk.notice, |view, key| {
                view.child(div().text_sm().child(self.t(key)))
            })
            .when(desk.confirm_close, |view| {
                view.child(self.t(Key::SalonConfirmDiscard))
                    .child(self.button(
                        "combination-discard",
                        self.t(Key::SalonDiscard),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| {
                            if let Overlay::Combinations(desk) = &mut root.overlay {
                                desk.confirm_close = false;
                                desk.editor = None;
                                desk.notice = None;
                            }
                            cx.notify();
                        }),
                    ))
            })
            .when(editable, |view| {
                if let Some(editor) = &desk.editor {
                    return view
                        .child(self.render_combination_editor(desk, editor, cx))
                        .when(
                            !editor.needs_review(desk.catalogue.as_ref())
                                && (editor.dirty(cx) || editor.conflict.is_some()),
                            |view| {
                                view.child(self.button(
                                    "combination-save",
                                    self.t(Key::CombinationSave),
                                    Kind::Primary,
                                    cx.listener(|root, _, _, cx| root.save_combination(cx)),
                                ))
                            },
                        );
                }
                if desk.catalogue.is_none() {
                    return view.child(self.t(Key::CombinationNeedsSync));
                }
                view.when(!desk.at_limit(), |view| {
                    view.child(self.button(
                        "combination-new",
                        self.t(Key::CombinationNew),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.choose_combination(None, cx)),
                    ))
                })
                .when(desk.at_limit(), |view| {
                    view.child(self.t(Key::CombinationLimit))
                })
                .child(self.render_combination_list(desk, cx))
            });
        self.modal_with_height(
            content,
            (viewport.width - px(24.)).max(px(270.)).min(px(650.)),
            (viewport.height - px(24.)).max(px(230.)).min(px(730.)),
            Some(cx),
        )
    }

    fn render_combination_list(&self, desk: &Desk, cx: &mut Context<Self>) -> impl IntoElement {
        let confirmed = desk
            .catalogue
            .iter()
            .flat_map(|view| view.combinations.iter())
            .filter(|row| !desk.pending.iter().any(|pending| pending.edit.id == row.id));
        let pending = desk.pending.iter().map(|row| {
            let id = row.edit.id.clone();
            let editable = !row.submitted
                && desk.current(&id).map(|current| current.version) == row.edit.version;
            self.combination_summary(&row.edit.proposed, Key::CatalogPending)
                .when(editable, |item| {
                    item.child(self.button(
                        SharedString::from(format!("combination-pending-{id}")),
                        self.t(Key::CombinationEdit),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| root.choose_combination(Some(&id), cx)),
                    ))
                })
        });
        div()
            .id("combination-list")
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_2()
            .when(
                desk.pending.is_empty()
                    && desk
                        .catalogue
                        .as_ref()
                        .is_some_and(|v| v.combinations.is_empty()),
                |view| view.child(self.t(Key::CombinationEmpty)),
            )
            .children(pending)
            .children(confirmed.map(|row| {
                let id = row.id.clone();
                let status = if !row.draft.active {
                    Key::CombinationArchived
                } else if row.bookable
                    && row
                        .draft
                        .fixed_terms
                        .as_ref()
                        .is_some_and(|terms| terms.online_booking == Some(false))
                {
                    Key::CombinationAvailableToStaff
                } else if row.bookable {
                    Key::CombinationLive
                } else {
                    Key::CombinationUnavailable
                };
                self.combination_summary(&row.draft, status)
                    .child(self.button(
                        SharedString::from(format!("combination-edit-{id}")),
                        self.t(Key::CombinationEdit),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| root.choose_combination(Some(&id), cx)),
                    ))
            }))
    }

    fn combination_summary(&self, draft: &CombinationDraft, heading: Key) -> gpui::Div {
        let order = draft
            .service_ids
            .iter()
            .map(|id| self.combination_service_name(id))
            .collect::<Vec<_>>()
            .join(" → ");
        div()
            .rounded_md()
            .border_1()
            .border_color(theme::line())
            .p_2()
            .flex()
            .flex_col()
            .gap_1()
            .child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.t(heading)),
            )
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(draft.name.clone()),
            )
            .when_some(draft.description.as_ref(), |view, value| {
                view.child(div().text_sm().child(value.clone()))
            })
            .child(div().text_sm().child(order))
            .when_some(draft.fixed_terms.as_ref(), |view, terms| {
                let prices = terms
                    .prices_cents
                    .iter()
                    .map(|&cents| self.amount_label(i64::from(cents), "EUR"))
                    .collect::<Vec<_>>()
                    .join(" · ");
                let professionals = terms
                    .staff_ids
                    .iter()
                    .map(|id| {
                        self.staff
                            .iter()
                            .find(|person| person.id == *id)
                            .map_or(id.as_str(), |person| person.display_name.as_str())
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                view.child(
                    div()
                        .text_sm()
                        .child(self.t(combination_visibility(terms.online_booking))),
                )
                .child(div().text_sm().child(prices))
                .child(div().text_sm().child(professionals))
            })
    }

    fn combination_service_name<'a>(&'a self, id: &str) -> &'a str {
        self.services
            .iter()
            .find(|row| row.id == id)
            .map(|row| row.name.as_str())
            .unwrap_or(self.t(Key::CombinationUnknownService))
    }

    fn render_combination_editor(
        &self,
        desk: &Desk,
        editor: &Editor,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let needs_review = editor.needs_review(desk.catalogue.as_ref());
        let fixed = editor.fixed.as_ref().filter(|_| editor.fixed_enabled);
        div()
            .id("combination-editor")
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_2()
            .when(needs_review, |view| {
                view.child(self.render_combination_review(
                    desk,
                    editor,
                    editor.draft(cx).as_ref(),
                    cx,
                ))
            })
            .child(self.label(Key::CombinationName))
            .child(editor.name.clone())
            .child(self.label(Key::CatalogDescription))
            .children(editor.description.iter().enumerate().map(|(index, field)| {
                div()
                    .flex()
                    .gap_1()
                    .child(div().flex_1().min_w_0().child(field.clone()))
                    .when(editor.description.len() > 1, |row| {
                        row.child(self.button(
                            ("combination-remove-line", index),
                            self.t(Key::RemoveNoteLine),
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| {
                                root.edit_combination(cx, |desk, _| {
                                    if let Some(editor) = &mut desk.editor
                                        && editor.description.len() > 1
                                        && index < editor.description.len()
                                    {
                                        editor.description.remove(index);
                                    }
                                })
                            }),
                        ))
                    })
            }))
            .when(editor.description.len() < 1001, |view| {
                view.child(self.button(
                    "combination-add-line",
                    self.t(Key::AddNoteLine),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| {
                        root.edit_combination(cx, |desk, cx| {
                            if let Some(editor) = &mut desk.editor
                                && editor.description.len() < 1001
                            {
                                editor.description.push(description_line("", cx));
                            }
                        })
                    }),
                ))
            })
            .child(self.button(
                "combination-active",
                self.t(if editor.active {
                    Key::CombinationActive
                } else {
                    Key::CombinationArchived
                }),
                if editor.active {
                    Kind::Primary
                } else {
                    Kind::Ghost
                },
                cx.listener(|root, _, _, cx| {
                    root.edit_combination(cx, |desk, _| {
                        if let Some(editor) = &mut desk.editor {
                            editor.active = !editor.active;
                        }
                    })
                }),
            ))
            .child(self.button(
                "combination-toggle-fixed-price",
                self.t(if editor.fixed_enabled {
                    Key::CombinationUseCataloguePrices
                } else {
                    Key::CombinationUseFixedPrice
                }),
                Kind::Ghost,
                cx.listener(|root, _, _, cx| root.toggle_fixed_combination(cx)),
            ))
            .when_some(fixed, |view, fixed| {
                view.child(self.render_fixed_combination_fields(fixed, cx))
            })
            .child(self.label(Key::CombinationOrder))
            .children(editor.service_ids.iter().enumerate().map(|(index, id)| {
                self.render_ordered_combination_service(index, editor.service_ids.len(), id, cx)
                    .when_some(
                        fixed.and_then(|fixed| fixed.prices.get(id)),
                        |row, price| row.child(div().w(px(105.)).child(price.clone())),
                    )
            }))
            .when(editor.service_ids.len() < MAX_SERVICES, |view| {
                view.child(editor.search.clone())
                    .child(self.render_combination_service_picker(editor, cx))
            })
    }

    fn render_fixed_combination_fields(
        &self,
        fixed: &FixedEditor,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let mut professionals = self
            .staff
            .iter()
            .filter(|person| person.active || fixed.staff_ids.contains(&person.id))
            .map(|person| (person.id.clone(), person.display_name.clone()))
            .collect::<Vec<_>>();
        professionals.extend(
            fixed
                .staff_ids
                .iter()
                .filter(|id| self.staff.iter().all(|person| &person.id != *id))
                .map(|id| (id.clone(), id.clone())),
        );
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(self.label(Key::CombinationVisibility))
            .when(fixed.online_booking.is_none(), |view| {
                view.child(
                    div()
                        .text_sm()
                        .child(self.t(Key::CombinationVisibilityUnreviewed)),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_1()
                    .children([false, true].into_iter().map(|online| {
                        self.button(
                            ("combination-visibility", usize::from(online)),
                            self.t(combination_visibility(Some(online))),
                            if fixed.online_booking == Some(online) {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            },
                            cx.listener(move |root, _, _, cx| {
                                root.edit_combination(cx, |desk, _| {
                                    if let Some(fixed) = desk
                                        .editor
                                        .as_mut()
                                        .and_then(|editor| editor.fixed.as_mut())
                                    {
                                        fixed.online_booking = Some(online);
                                    }
                                })
                            }),
                        )
                    })),
            )
            .child(self.label(Key::CombinationFixedProfessionals))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_1()
                    .children(professionals.into_iter().map(|(id, name)| {
                        let selected = fixed.staff_ids.contains(&id);
                        self.button(
                            SharedString::from(format!("combination-staff-{id}")),
                            name,
                            if selected { Kind::Primary } else { Kind::Ghost },
                            cx.listener(move |root, _, _, cx| {
                                let active = root
                                    .staff
                                    .iter()
                                    .any(|person| person.id == id && person.active);
                                root.edit_combination(cx, |desk, _| {
                                    if let Some(fixed) = desk
                                        .editor
                                        .as_mut()
                                        .and_then(|editor| editor.fixed.as_mut())
                                    {
                                        if let Some(index) =
                                            fixed.staff_ids.iter().position(|staff| *staff == id)
                                        {
                                            fixed.staff_ids.remove(index);
                                        } else if active
                                            && fixed.staff_ids.len()
                                                < sob_core::combinations::MAX_FIXED_STAFF
                                        {
                                            fixed.staff_ids.push(id.clone());
                                        }
                                    }
                                });
                            }),
                        )
                    })),
            )
    }

    fn render_combination_review(
        &self,
        desk: &Desk,
        editor: &Editor,
        draft: Option<&CombinationDraft>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let view = desk.catalogue.as_ref();
        let current = view.and_then(|view| editor.current(view));
        let can_review = draft.is_some() && view.is_some_and(|view| editor.can_review(view));
        let overlaps = current.zip(draft).is_some_and(|(row, draft)| {
            !editor.has_legacy_terms(row)
                && draft.rebase(&editor.original, &row.draft, true)
                    != draft.rebase(&editor.original, &row.draft, false)
        });
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(self.t(Key::CombinationChanged))
            .when_some(draft, |view, draft| {
                view.child(self.combination_summary(draft, Key::CombinationDraft))
            })
            .when_some(current, |view, row| {
                view.child(self.combination_summary(&row.draft, Key::CombinationCurrent))
            })
            .when(
                current.is_none() && editor.version.is_some() && view.is_some(),
                |view| view.child(self.t(Key::CombinationMissing)),
            )
            .when(!can_review, |view| {
                view.child(self.t(if draft.is_none() {
                    Key::CombinationPriceUnreviewed
                } else {
                    Key::CombinationNeedsSync
                }))
            })
            .when(can_review, |view| {
                let action = if editor.version.is_some() && current.is_none() {
                    Key::CombinationRestoredNew
                } else if overlaps {
                    Key::CatalogKeepDraftGroups
                } else {
                    Key::CatalogReview
                };
                view.child(self.button(
                    "combination-review",
                    self.t(action),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.review_combination(true, cx)),
                ))
                .when(overlaps, |view| {
                    view.child(self.button(
                        "combination-review-cloud",
                        self.t(Key::CatalogKeepCloudGroups),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.review_combination(false, cx)),
                    ))
                })
            })
    }

    fn render_ordered_combination_service(
        &self,
        index: usize,
        count: usize,
        id: &str,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_1()
            .child(div().flex_1().min_w_0().child(format!(
                "{}. {}",
                index + 1,
                self.combination_service_name(id)
            )))
            .when(index > 0, |row| {
                row.child(self.button(
                    ("combination-move-up", index),
                    self.t(Key::FormMoveUp),
                    Kind::Ghost,
                    cx.listener(move |root, _, _, cx| {
                        root.move_combination_service(index, index - 1, cx)
                    }),
                ))
            })
            .when(index + 1 < count, |row| {
                row.child(self.button(
                    ("combination-move-down", index),
                    self.t(Key::FormMoveDown),
                    Kind::Ghost,
                    cx.listener(move |root, _, _, cx| {
                        root.move_combination_service(index, index + 1, cx)
                    }),
                ))
            })
            .child(self.button(
                ("combination-remove", index),
                self.t(Key::SaleRemove),
                Kind::Ghost,
                cx.listener(move |root, _, _, cx| {
                    root.edit_combination(cx, |desk, _| {
                        if let Some(editor) = &mut desk.editor
                            && index < editor.service_ids.len()
                        {
                            let id = editor.service_ids.remove(index);
                            if let Some(fixed) = &mut editor.fixed {
                                fixed.prices.remove(&id);
                            }
                        }
                    })
                }),
            ))
    }

    fn render_combination_service_picker(
        &self,
        editor: &Editor,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let query = editor.search.read(cx).text().trim().to_lowercase();
        let fixed = editor.fixed.as_ref().filter(|_| editor.fixed_enabled);
        div().flex().flex_wrap().gap_1().children(
            self.services
                .iter()
                .filter(|service| {
                    (if fixed.is_some_and(|terms| terms.online_booking != Some(true)) {
                        service.active
                    } else {
                        online_service(service, &self.services)
                    }) && (fixed.is_none() || service.currency == "EUR")
                        && !editor.service_ids.contains(&service.id)
                        && (query.is_empty() || service.name.to_lowercase().contains(&query))
                })
                .map(|service| {
                    let id = service.id.clone();
                    self.button(
                        SharedString::from(format!("combination-add-{id}")),
                        service.name.clone(),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| {
                            root.edit_combination(cx, |desk, cx| {
                                if let Some(editor) = &mut desk.editor
                                    && editor.service_ids.len() < MAX_SERVICES
                                    && !editor.service_ids.contains(&id)
                                {
                                    editor.service_ids.push(id.clone());
                                    if let Some(fixed) = &mut editor.fixed {
                                        fixed.prices.insert(id.clone(), text_field("EUR", "", cx));
                                    }
                                }
                            })
                        }),
                    )
                }),
        )
    }
}

fn combination_visibility(online: Option<bool>) -> Key {
    match online {
        Some(true) => Key::CombinationOnline,
        Some(false) => Key::CombinationInternal,
        None => Key::CombinationVisibilityUnreviewed,
    }
}
