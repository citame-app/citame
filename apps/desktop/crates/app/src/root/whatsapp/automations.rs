use super::*;
pub(super) use sob_core::http::whatsapp::ReviewedAutomations as Editor;
use sob_core::http::whatsapp::{ApprovedTemplate, EVENTS, ReviewedOutcome, RulesChange, VARIABLES};
use sob_core::sync::TransportError;

enum Operation {
    Open(String),
    Save(RulesChange),
    Disconnect(String),
}

enum Reply {
    Open(String, Vec<ApprovedTemplate>),
    Saved(ReviewedOutcome),
    Disconnected(String, ReviewedOutcome),
}

impl Root {
    pub(super) fn open_whatsapp_automations(&mut self, cx: &mut Context<Self>) {
        let Overlay::Whatsapp(desk) = &self.overlay else {
            return;
        };
        let Some(connection) = desk
            .snapshot
            .as_ref()
            .and_then(|view| view.connection.as_ref())
        else {
            return;
        };
        if let Some(revision) = &connection.revision {
            self.request_whatsapp_action(Operation::Open(revision.clone()), cx);
        }
    }

    fn save_whatsapp_automations(&mut self, cx: &mut Context<Self>) {
        let Overlay::Whatsapp(desk) = &self.overlay else {
            return;
        };
        let Some(editor) = &desk.editor else { return };
        if desk.automations_stale() || !editor.dirty() {
            return;
        }
        if let Some(proposed) = editor.proposed() {
            self.request_whatsapp_action(Operation::Save(proposed), cx);
        }
    }

    pub(super) fn confirm_whatsapp_disconnect(&mut self, cx: &mut Context<Self>) {
        let Overlay::Whatsapp(desk) = &self.overlay else {
            return;
        };
        let Some(review) = &desk.disconnect_review else {
            return;
        };
        if desk.sender_revision() == Some(review.revision.as_str()) {
            self.request_whatsapp_action(Operation::Disconnect(review.revision.clone()), cx);
        }
    }

    fn request_whatsapp_action(&mut self, operation: Operation, cx: &mut Context<Self>) {
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let Overlay::Whatsapp(desk) = &mut self.overlay else {
            return;
        };
        if desk.action_pending {
            return;
        }
        let connecting_templates = matches!(&operation, Operation::Open(_));
        let disconnecting = matches!(&operation, Operation::Disconnect(_));
        desk.action_pending = true;
        desk.action_message = None;
        let identity = desk.identity.clone();
        let session = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match operation {
                        Operation::Open(revision) => transport
                            .whatsapp_templates()
                            .map(|templates| Reply::Open(revision, templates)),
                        Operation::Save(change) => {
                            transport.save_whatsapp_rules(&change).map(Reply::Saved)
                        }
                        Operation::Disconnect(revision) => transport
                            .disconnect_whatsapp(&revision)
                            .map(|outcome| Reply::Disconnected(revision, outcome)),
                    }
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session) {
                    return;
                }
                let Overlay::Whatsapp(desk) = &mut root.overlay else {
                    return;
                };
                if !Arc::ptr_eq(&desk.identity, &identity) {
                    return;
                }
                desk.action_pending = false;
                match result {
                    Ok(Reply::Open(revision, templates)) => {
                        let current = desk
                            .snapshot
                            .as_ref()
                            .and_then(|view| view.connection.as_ref())
                            .filter(|connection| {
                                connection.revision.as_deref() == Some(revision.as_str())
                            });
                        if let Some(connection) = current {
                            if let Some(editor) = &mut desk.editor {
                                editor.templates = templates;
                            } else {
                                desk.editor = Editor::new(connection, templates);
                            }
                        } else {
                            desk.action_message = Some(Key::WhatsappRulesChanged);
                        }
                    }
                    Ok(Reply::Saved(ReviewedOutcome::Applied)) => {
                        desk.editor = None;
                        desk.action_message = Some(Key::WhatsappRulesSaved);
                        root.load_whatsapp_desk(true, cx);
                    }
                    Ok(Reply::Saved(ReviewedOutcome::Conflict)) => {
                        desk.action_message = Some(Key::WhatsappRulesChanged);
                        root.load_whatsapp_desk(true, cx);
                    }
                    Ok(Reply::Disconnected(revision, outcome)) => {
                        desk.disconnect_review = None;
                        desk.action_message = Some(match outcome {
                            ReviewedOutcome::Applied => {
                                // Ignore a desk read started before this acknowledgement.
                                desk.identity = Arc::new(());
                                desk.loading = false;
                                if let Some(snapshot) = &mut desk.snapshot
                                    && snapshot
                                        .connection
                                        .as_ref()
                                        .and_then(|value| value.revision.as_deref())
                                        == Some(revision.as_str())
                                {
                                    snapshot.connection = None;
                                }
                                Key::WhatsappDisconnected
                            }
                            ReviewedOutcome::Conflict => Key::WhatsappDisconnectChanged,
                        });
                        root.load_whatsapp_desk(true, cx);
                    }
                    Err(_) if connecting_templates => {
                        desk.action_message = Some(Key::WhatsappTemplatesFailed);
                    }
                    Err(_) if disconnecting => {
                        desk.disconnect_review = None;
                        desk.action_message = Some(Key::WhatsappDisconnectUnconfirmed);
                        root.load_whatsapp_desk(true, cx);
                    }
                    Err(TransportError::BadRequest(_)) => {
                        desk.action_message = Some(Key::WhatsappRulesInvalid);
                        root.load_whatsapp_desk(true, cx);
                    }
                    Err(_) => {
                        desk.action_message = Some(Key::WhatsappRulesUnconfirmed);
                        root.load_whatsapp_desk(true, cx);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn render_whatsapp_automations(
        &self,
        desk: &Desk,
        editor: &Editor,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let selected = editor.entries[editor.selected].as_ref();
        let template = selected.and_then(|rule| {
            editor
                .templates
                .iter()
                .find(|item| item.id == rule.template_id)
        });
        let stale = desk.automations_stale();
        let can_edit =
            self.status.connectivity == Connectivity::Online && !stale && !desk.action_pending;
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::WhatsappAutomations)),
            )
            .when(stale, |body| body.child(self.t(Key::WhatsappRulesChanged)))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_1()
                    .children(EVENTS.into_iter().enumerate().map(|(index, event)| {
                        self.button(
                            ("whatsapp-rule-event", index),
                            self.t(event_key(event)),
                            if index == editor.selected {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            },
                            cx.listener(move |root, _, _, cx| {
                                if let Overlay::Whatsapp(desk) = &mut root.overlay
                                    && let Some(editor) = &mut desk.editor
                                {
                                    editor.selected = index;
                                    cx.notify();
                                }
                            }),
                        )
                    })),
            )
            .child(div().text_sm().child(self.t(Key::WhatsappTemplate)))
            .when(can_edit, |body| {
                body.child(self.button(
                    "whatsapp-refresh-templates",
                    self.t(Key::WhatsappRefreshTemplates),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.open_whatsapp_automations(cx)),
                ))
            })
            .when(selected.is_some() && template.is_none(), |body| {
                body.child(self.t(Key::WhatsappTemplateMissing))
            })
            .when(can_edit, |body| {
                body.child(
                    div()
                        .id(("whatsapp-template-list", editor.selected))
                        .max_h(px(160.))
                        .overflow_y_scroll()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(self.whatsapp_template_button(
                            None,
                            self.t(Key::SalonOff).into(),
                            selected.is_none(),
                            cx,
                        ))
                        .children(editor.templates.iter().enumerate().map(|(index, item)| {
                            self.whatsapp_template_button(
                                Some(index),
                                format!("{} · {}", item.name, item.language).into(),
                                selected.is_some_and(|rule| rule.template_id == item.id),
                                cx,
                            )
                        })),
                )
            })
            .when_some(template.zip(selected), |body, (template, selected)| {
                body.children(
                    template
                        .parameters
                        .iter()
                        .enumerate()
                        .map(|(index, parameter)| {
                            div()
                                .flex()
                                .flex_col()
                                .gap_1()
                                .child(format!("{{{{{parameter}}}}}"))
                                .child(div().flex().flex_wrap().gap_1().children(
                                    VARIABLES.into_iter().enumerate().map(
                                        |(position, variable)| {
                                            self.button(
                                                (
                                                    "whatsapp-variable",
                                                    index * VARIABLES.len() + position,
                                                ),
                                                self.t(variable_key(variable)),
                                                if selected.variables.get(index).copied().flatten()
                                                    == Some(variable)
                                                {
                                                    Kind::Primary
                                                } else {
                                                    Kind::Ghost
                                                },
                                                cx.listener(move |root, _, _, cx| {
                                                    if let Overlay::Whatsapp(desk) =
                                                        &mut root.overlay
                                                        && desk.can_edit_rules()
                                                        && let Some(editor) = &mut desk.editor
                                                        && let Some(rule) =
                                                            &mut editor.entries[editor.selected]
                                                        && let Some(slot) =
                                                            rule.variables.get_mut(index)
                                                    {
                                                        *slot = Some(variable);
                                                        cx.notify();
                                                    }
                                                }),
                                            )
                                        },
                                    ),
                                ))
                        }),
                )
            })
            .when_some(template.zip(selected), |body, (template, selected)| {
                let values = selected
                    .variables
                    .iter()
                    .map(|variable| {
                        variable.map(|variable| i18n::whatsapp_sample(variable, self.locale))
                    })
                    .collect::<Vec<_>>();
                body.child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(self.t(Key::WhatsappPreview)),
                )
                .child(div().text_sm().child(template.sample(&values)))
            })
            .when(
                can_edit && editor.dirty() && editor.proposed().is_some(),
                |body| {
                    body.child(self.button(
                        "whatsapp-save-rules",
                        self.t(Key::WhatsappSaveRules),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.save_whatsapp_automations(cx)),
                    ))
                },
            )
    }

    fn whatsapp_template_button(
        &self,
        index: Option<usize>,
        label: SharedString,
        selected: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        self.button(
            ("whatsapp-template", index.map_or(0, |i| i + 1)),
            label,
            if selected { Kind::Primary } else { Kind::Ghost },
            cx.listener(move |root, _, _, cx| {
                if let Overlay::Whatsapp(desk) = &mut root.overlay
                    && desk.can_edit_rules()
                    && let Some(editor) = &mut desk.editor
                {
                    editor.select_template(index);
                    desk.action_message = None;
                    cx.notify();
                }
            }),
        )
    }

    pub(super) fn whatsapp_automation_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        self.button(
            "whatsapp-edit-rules",
            self.t(Key::WhatsappEditRules),
            Kind::Primary,
            cx.listener(|root, _, _, cx| root.open_whatsapp_automations(cx)),
        )
    }
}

impl Desk {
    fn can_edit_rules(&self) -> bool {
        !self.action_pending && !self.automations_stale()
    }

    fn automations_stale(&self) -> bool {
        self.editor.as_ref().is_some_and(|editor| {
            self.snapshot
                .as_ref()
                .and_then(|view| view.connection.as_ref())
                .is_none_or(|connection| {
                    connection.revision.as_deref() != Some(editor.revision.as_str())
                })
                || matches!(
                    self.action_message,
                    Some(Key::WhatsappRulesChanged | Key::WhatsappRulesUnconfirmed)
                )
        })
    }
}
