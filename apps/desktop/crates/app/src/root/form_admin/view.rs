use super::*;
use gpui::{Pixels, Size};

impl Root {
    pub(in crate::root) fn render_intake_forms(
        &self,
        desk: &Desk,
        viewport: Size<Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let body = div()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::BOLD)
                    .child(self.t(Key::FormAdmin)),
            )
            .when_some(desk.error, |body, error| {
                body.child(
                    div()
                        .text_sm()
                        .text_color(theme::conflict_fg())
                        .child(self.t(error)),
                )
            })
            .when_some(desk.notice, |body, notice| {
                body.child(div().text_sm().child(self.t(notice)))
            })
            .when(desk.request.is_some(), |body| {
                body.child(self.t(Key::FormWorking))
            })
            .when(desk.request.is_none(), |body| {
                let content = if let Some(confirm) = desk.confirm {
                    self.render_form_confirmation(desk, confirm, cx)
                } else if let Some(action) = &desk.retry {
                    let action = action.clone();
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .child(self.t(Key::FormRetryExplanation))
                        .child(self.button(
                            "form-retry",
                            self.t(Key::FormRetry),
                            Kind::Primary,
                            cx.listener(move |root, _, _, cx| {
                                root.write_intake_form(action.clone(), cx)
                            }),
                        ))
                } else if let Some(editor) = &desk.editor {
                    self.render_form_editor(editor, cx)
                } else {
                    self.render_form_list(desk, cx)
                };
                let scroll_id = if desk.confirm.is_some() {
                    "form-admin-review-scroll"
                } else if desk.editor.is_some() {
                    "form-admin-editor-scroll"
                } else {
                    "form-admin-list-scroll"
                };
                body.child(
                    div()
                        .id(scroll_id)
                        .debug_selector(move || scroll_id.to_owned())
                        .min_h(px(0.))
                        .flex_shrink()
                        .overflow_y_scroll()
                        .child(content),
                )
            })
            .when(desk.request.is_none(), |body| {
                body.child(
                    div().flex_shrink_0().flex().gap_2().child(
                        self.button(
                            "form-back",
                            self.t(if desk.confirm.is_some() {
                                Key::Cancel
                            } else if desk.editor.is_some() {
                                Key::FormBack
                            } else {
                                Key::Close
                            }),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.close_intake_forms(cx)),
                        )
                        .debug_selector(|| "form-back".to_owned()),
                    ),
                )
            });
        self.modal_with_height(
            body,
            (viewport.width - px(32.)).max(px(220.)).min(px(750.)),
            (viewport.height - px(28.)).max(px(140.)),
            Some(cx),
        )
    }

    fn render_form_list(&self, desk: &Desk, cx: &mut Context<Self>) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .when(desk.loaded && !desk.denied, |row| {
                        row.child(self.button(
                            "form-new",
                            self.t(Key::FormNew),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| root.select_form(None, cx)),
                        ))
                    })
                    .child(self.button(
                        "form-reload-list",
                        self.t(Key::FormReload),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.load_intake_forms(cx)),
                    )),
            )
            .when(
                desk.loaded && !desk.denied && desk.forms.is_empty(),
                |list| list.child(self.t(Key::FormEmpty)),
            )
            .children(desk.forms.iter().enumerate().map(|(index, form)| {
                let state = match (form.active, form.published_number) {
                    (true, Some(version)) => {
                        format!("{} · v{version}", self.t(Key::FormStateActive))
                    }
                    (false, Some(version)) => {
                        format!("{} · v{version}", self.t(Key::FormStateArchived))
                    }
                    _ => self.t(Key::FormStateDraft).to_owned(),
                };
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .border_1()
                    .rounded_md()
                    .border_color(theme::line())
                    .p_2()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .min_w_0()
                            .child(form.title.clone())
                            .child(div().text_sm().text_color(theme::muted()).child(state)),
                    )
                    .child(self.button(
                        ("form-select", index),
                        self.t(Key::FormEdit),
                        Kind::Ghost,
                        cx.listener(move |root, _, _, cx| root.select_form(Some(index), cx)),
                    ))
            }))
    }

    fn select_form(&mut self, index: Option<usize>, cx: &mut Context<Self>) {
        let Overlay::IntakeForms(desk) = &mut self.overlay else {
            return;
        };
        if desk.denied || desk.request.is_some() || !desk.loaded {
            return;
        }
        if let Some(index) = index {
            if let Some(form) = desk.forms.get(index) {
                let id = form.id.clone();
                self.read_intake_forms(FormRead::Detail(id), cx);
            }
            return;
        }
        desk.editor = Some(Editor::new(None, cx));
        desk.notice = None;
        desk.error = None;
        cx.notify();
    }

    fn render_form_editor(&self, editor: &Editor, cx: &mut Context<Self>) -> gpui::Div {
        let dirty = editor.dirty(cx);
        let waiver = editor.kind == FormKind::Waiver;
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(self.form_control(Key::FormTitle, &editor.title))
            .child(self.render_lines(&editor.description, None, Key::FormDescription, cx))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.form_edit_button(
                        "form-waiver",
                        Key::FormWaiver,
                        waiver,
                        Edit::Waiver,
                        cx,
                    ))
                    .child(self.form_edit_button(
                        "form-required",
                        Key::FormRequired,
                        editor.required,
                        Edit::Required,
                        cx,
                    ))
                    .child(self.form_edit_button(
                        "form-team",
                        Key::FormTeam,
                        editor.team,
                        Edit::Team,
                        cx,
                    )),
            )
            .child(self.form_scope(editor, cx))
            .children(editor.fields.iter().enumerate().map(|(index, field)| {
                self.render_form_field(index, field, editor.fields.len(), cx)
            }))
            .when(editor.fields.len() < 30, |body| {
                body.child(self.form_edit_button(
                    "form-field-add",
                    Key::FormAddQuestion,
                    false,
                    Edit::AddField,
                    cx,
                ))
            })
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .when(dirty, |row| {
                        row.child(self.button(
                            "form-save",
                            self.t(Key::FormSave),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| root.save_intake_form(cx)),
                        ))
                    })
                    .when(
                        editor.base.as_ref().is_some_and(AdminForm::can_publish) && !dirty,
                        |row| {
                            row.child(self.form_confirm_button(
                                "form-review",
                                Key::FormReview,
                                Confirm::Publish,
                                cx,
                            ))
                        },
                    )
                    .when(
                        editor.base.as_ref().is_some_and(|base| base.active) && !dirty,
                        |row| {
                            row.child(self.form_confirm_button(
                                "form-archive",
                                Key::FormStop,
                                Confirm::Archive,
                                cx,
                            ))
                        },
                    )
                    .when(editor.base.is_some(), |row| {
                        row.child(self.form_confirm_button(
                            "form-reload",
                            Key::FormReload,
                            Confirm::Reload,
                            cx,
                        ))
                    }),
            )
    }

    fn form_confirm_button(
        &self,
        id: &'static str,
        key: Key,
        confirm: Confirm,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        self.button(
            id,
            self.t(key),
            Kind::Ghost,
            cx.listener(move |root, _, _, cx| {
                if let Overlay::IntakeForms(desk) = &mut root.overlay
                    && desk.request.is_none()
                {
                    desk.confirm = Some(confirm);
                    cx.notify();
                }
            }),
        )
    }

    fn form_control(&self, key: Key, input: &Input) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap_1()
            .min_w_0()
            .child(div().text_sm().child(self.t(key)))
            .child(input.clone())
    }

    fn form_edit_button(
        &self,
        id: impl Into<ElementId>,
        key: Key,
        selected: bool,
        edit: Edit,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        self.form_edit_label(id, self.t(key), selected, edit, cx)
    }

    fn form_edit_label(
        &self,
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        selected: bool,
        edit: Edit,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        self.button(
            id,
            label,
            if selected { Kind::Primary } else { Kind::Ghost },
            cx.listener(move |root, _, _, cx| root.form_edit(edit.clone(), cx)),
        )
    }

    fn render_lines(
        &self,
        lines: &Lines,
        field: Option<usize>,
        key: Key,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let group = field.map_or(0, |i| i + 1);
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .child(div().text_sm().child(self.t(key)))
                    .when(lines.fields.len() > 1, |row| {
                        let inputs = lines.fields.clone();
                        row.child(self.button(
                            ("form-copy-lines", group),
                            self.t(Key::FormCopyText),
                            Kind::Ghost,
                            move |_, _, cx| {
                                let text = inputs
                                    .iter()
                                    .map(|line| value(line, cx))
                                    .collect::<Vec<_>>()
                                    .join("\n");
                                cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
                            },
                        ))
                    }),
            )
            .children(lines.fields.iter().enumerate().map(|(i, line)| {
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(div().flex_1().min_w_0().child(line.clone()))
                    .when(lines.fields.len() > 1, |row| {
                        row.child(self.form_edit_button(
                            ("form-line-remove", group * 16384 + i),
                            Key::FormRemove,
                            false,
                            Edit::RemoveLine(field, i),
                            cx,
                        ))
                    })
            }))
            .when(lines.budget.get() > 0, |body| {
                body.child(self.form_edit_button(
                    ("form-line-add", group),
                    Key::FormAddLine,
                    false,
                    Edit::AddLine(field),
                    cx,
                ))
            })
    }

    fn form_scope(&self, editor: &Editor, cx: &mut Context<Self>) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(self.form_edit_button(
                "form-all-services",
                Key::FormAllServices,
                editor.all_services,
                Edit::AllServices,
                cx,
            ))
            .when(!editor.all_services, |panel| {
                let search = value(&editor.search, cx).trim().to_lowercase();
                let services = self.services.iter().filter(|service| {
                    !editor.services.contains(&service.id)
                        && (service.name.to_lowercase().contains(&search)
                            || service.id.contains(&search))
                });
                let chosen = editor
                    .services
                    .iter()
                    .enumerate()
                    .map(|(index, id)| {
                        let label = self
                            .services
                            .iter()
                            .find(|service| service.id == *id)
                            .map(|service| service.name.clone())
                            .unwrap_or_else(|| {
                                format!("{} · {id}", self.t(Key::FormUnavailableService))
                            });
                        self.form_edit_label(
                            ("form-service-selected", index),
                            label,
                            true,
                            Edit::Service(id.clone()),
                            cx,
                        )
                    })
                    .collect::<Vec<_>>();
                panel
                    .child(div().text_sm().child(format!(
                        "{} · {}/100",
                        self.t(Key::FormSelectService),
                        editor.services.len()
                    )))
                    .child(div().flex().flex_wrap().gap_2().children(chosen))
                    .when(editor.services.len() < 100, |panel| {
                        panel
                            .child(self.form_control(Key::FormSearchServices, &editor.search))
                            .child(
                                div()
                                    .id("form-service-options")
                                    .max_h(px(156.))
                                    .overflow_y_scroll()
                                    .child(div().flex().flex_col().gap_1().children(
                                        services.enumerate().map(|(index, service)| {
                                            let label = format!(
                                                "{} · {} · {}",
                                                service.name,
                                                format_args!("{} min", service.duration_minutes),
                                                service
                                                    .id
                                                    .rsplit('-')
                                                    .next()
                                                    .unwrap_or(&service.id)
                                            );
                                            self.form_edit_label(
                                                ("form-service-option", index),
                                                label,
                                                false,
                                                Edit::Service(service.id.clone()),
                                                cx,
                                            )
                                        }),
                                    )),
                            )
                    })
            })
    }

    fn render_form_field(
        &self,
        index: usize,
        field: &Field,
        count: usize,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap_2()
            .p_3()
            .rounded_md()
            .border_1()
            .border_color(theme::line())
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .items_center()
                    .child(div().font_weight(FontWeight::SEMIBOLD).child(format!(
                        "{} {}",
                        self.t(Key::FormQuestion),
                        index + 1
                    )))
                    .when(index > 0, |row| {
                        row.child(self.form_edit_button(
                            ("form-question-up", index),
                            Key::FormMoveUp,
                            false,
                            Edit::MoveField(index, index - 1),
                            cx,
                        ))
                    })
                    .when(index + 1 < count, |row| {
                        row.child(self.form_edit_button(
                            ("form-question-down", index),
                            Key::FormMoveDown,
                            false,
                            Edit::MoveField(index, index + 1),
                            cx,
                        ))
                    })
                    .when(count > 1, |row| {
                        row.child(self.form_edit_button(
                            ("form-question-remove", index),
                            Key::FormRemove,
                            false,
                            Edit::RemoveField(index),
                            cx,
                        ))
                    }),
            )
            .child(self.form_control(Key::FormQuestionLabel, &field.label))
            .child(self.render_lines(&field.help, Some(index), Key::FormHelp, cx))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .children(KINDS.into_iter().enumerate().map(|(position, kind)| {
                        self.form_edit_button(
                            ("form-question-kind", index * KINDS.len() + position),
                            kind.label(),
                            field.kind == kind,
                            Edit::Kind(index, kind),
                            cx,
                        )
                    })),
            )
            .child(self.form_edit_button(
                ("form-question-required", index),
                Key::FormFieldRequired,
                field.required,
                Edit::FieldRequired(index),
                cx,
            ))
            .when(
                matches!(field.kind, FieldKind::Text | FieldKind::Textarea),
                |body| body.child(self.form_control(Key::FormMaxLength, &field.lower)),
            )
            .when(field.kind == FieldKind::Number, |body| {
                body.child(self.form_control(Key::FormMinimum, &field.lower))
                    .child(self.form_control(Key::FormMaximum, &field.upper))
            })
            .when(field.kind.has_choices(), |body| {
                body.children(
                    field
                        .options
                        .iter()
                        .enumerate()
                        .map(|(position, (_, option))| {
                            let element = index * 30 + position;
                            div()
                                .flex()
                                .flex_wrap()
                                .gap_2()
                                .child(self.form_control(Key::FormChoice, option).flex_1())
                                .when(position > 0, |row| {
                                    row.child(self.form_edit_button(
                                        ("form-choice-up", element),
                                        Key::FormMoveUp,
                                        false,
                                        Edit::MoveChoice(index, position, position - 1),
                                        cx,
                                    ))
                                })
                                .when(position + 1 < field.options.len(), |row| {
                                    row.child(self.form_edit_button(
                                        ("form-choice-down", element),
                                        Key::FormMoveDown,
                                        false,
                                        Edit::MoveChoice(index, position, position + 1),
                                        cx,
                                    ))
                                })
                                .when(field.options.len() > 1, |row| {
                                    row.child(self.form_edit_button(
                                        ("form-choice-delete", element),
                                        Key::FormRemove,
                                        false,
                                        Edit::RemoveChoice(index, position),
                                        cx,
                                    ))
                                })
                        }),
                )
                .when(field.options.len() < 30, |body| {
                    body.child(self.form_edit_button(
                        ("form-choice-add", index),
                        Key::FormAddChoice,
                        false,
                        Edit::AddChoice(index),
                        cx,
                    ))
                })
            })
    }

    fn render_form_confirmation(
        &self,
        desk: &Desk,
        confirm: Confirm,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let (prompt, action) = match confirm {
            Confirm::Publish => (Key::FormPublishExplanation, Key::FormPublish),
            Confirm::Archive => (Key::FormArchiveExplanation, Key::FormStop),
            Confirm::Close => (
                if desk.retry.is_some() {
                    Key::FormDiscardPending
                } else {
                    Key::FormDiscardExplanation
                },
                Key::FormDiscard,
            ),
            Confirm::Reload => (Key::FormReloadExplanation, Key::FormReload),
        };
        let saved = desk.editor.as_ref().and_then(|editor| editor.base.as_ref());
        let preview = saved.map(|form| &form.draft);
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(self.t(prompt))
            .when_some(
                preview.filter(|_| confirm == Confirm::Publish),
                |panel, draft| {
                    panel
                        .child(
                            div()
                                .font_weight(FontWeight::BOLD)
                                .child(draft.title.clone()),
                        )
                        .child(draft.description.clone())
                        .child(
                            div()
                                .text_sm()
                                .child(self.t(if draft.kind == FormKind::Waiver {
                                    Key::FormWaiver
                                } else {
                                    Key::FormQuestionnaire
                                })),
                        )
                        .when(draft.required_at_booking, |panel| {
                            panel.child(self.t(Key::FormRequired))
                        })
                        .when(draft.allow_team_responses, |panel| {
                            panel.child(self.t(Key::FormTeam))
                        })
                        .when(draft.all_services, |panel| {
                            panel.child(self.t(Key::FormAllServices))
                        })
                        .when(!draft.all_services, |panel| {
                            panel.child(div().flex().flex_col().gap_1().children(
                                draft.service_ids.iter().map(|id| {
                                    self.services
                                        .iter()
                                        .find(|service| service.id == *id)
                                        .map(|service| service.name.clone())
                                        .unwrap_or_else(|| id.clone())
                                }),
                            ))
                        })
                        .children(
                            draft
                                .fields
                                .iter()
                                .map(|question| self.form_question_preview(question)),
                        )
                },
            )
            .child(self.button(
                "form-confirm-action",
                self.t(action),
                if matches!(confirm, Confirm::Archive | Confirm::Close) {
                    Kind::Danger
                } else {
                    Kind::Primary
                },
                cx.listener(|root, _, _, cx| root.confirm_intake_action(cx)),
            ))
    }

    fn form_question_preview(&self, question: &Question) -> gpui::Div {
        let kind = FieldKind::from(&question.kind).label();
        let detail = match &question.kind {
            QuestionKind::Text { max_length } | QuestionKind::Textarea { max_length } => {
                format!("{} · {max_length}", self.t(Key::FormMaxLength))
            }
            QuestionKind::Number { minimum, maximum } => format!(
                "{}: {} · {}: {}",
                self.t(Key::FormMinimum),
                minimum.map(|n| n.to_string()).unwrap_or_default(),
                self.t(Key::FormMaximum),
                maximum.map(|n| n.to_string()).unwrap_or_default()
            ),
            QuestionKind::SingleChoice { options } | QuestionKind::MultipleChoice { options } => {
                options
                    .iter()
                    .map(|option| option.label.as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            }
            _ => String::new(),
        };
        div()
            .flex()
            .flex_col()
            .gap_1()
            .rounded_md()
            .border_1()
            .border_color(theme::line())
            .p_2()
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(question.label.clone()),
            )
            .child(div().text_sm().child(question.help.clone()))
            .child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.t(kind)),
            )
            .when(question.required, |box_| {
                box_.child(self.t(Key::FormFieldRequired))
            })
            .when(!detail.is_empty(), |box_| box_.child(detail))
    }
}
