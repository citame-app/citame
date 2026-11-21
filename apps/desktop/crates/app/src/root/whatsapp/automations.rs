use super::*;
use sob_core::http::whatsapp::{ApprovedTemplate, EVENTS, RuleChange, RulesChange, VARIABLES};

fn sample_value(variable: Variable, locale: Locale) -> &'static str {
    match (variable, locale) {
        (Variable::Client, _) => "Lucía",
        (Variable::Salon, _) => "Citame",
        (Variable::Date, Locale::En) => "18 Nov 2026",
        (Variable::Date, Locale::EsAr) => "18/11/2026",
        (Variable::Time, _) => "16:00",
        (Variable::Staff, _) => "Natalia",
        (Variable::Services, Locale::En) => "Manicure",
        (Variable::Services, Locale::EsAr) => "Manicura",
        (Variable::Preferences, _) => "https://citame.example/notifications",
    }
}

#[derive(Clone)]
struct DraftRule {
    template_id: String,
    variables: Vec<Option<Variable>>,
}

pub(super) struct Editor {
    revision: String,
    baseline: Vec<RuleChange>,
    templates: Vec<ApprovedTemplate>,
    entries: [Option<DraftRule>; 5],
    selected: usize,
}

impl Editor {
    fn new(connection: &Connection, templates: Vec<ApprovedTemplate>) -> Self {
        let baseline = connection.editable_rules();
        let entries = EVENTS.map(|kind| {
            let saved = baseline.iter().find(|rule| rule.kind == kind)?;
            Some(DraftRule {
                template_id: saved.template_id.clone(),
                variables: saved.variables.iter().copied().map(Some).collect(),
            })
        });
        Self {
            revision: connection.revision.clone(),
            baseline,
            templates,
            entries,
            selected: 0,
        }
    }

    fn proposed(&self) -> Option<RulesChange> {
        let mut rules = Vec::new();
        for (kind, selected) in EVENTS.into_iter().zip(&self.entries) {
            let Some(selected) = selected else { continue };
            let variables = selected
                .variables
                .iter()
                .copied()
                .collect::<Option<Vec<_>>>()?;
            rules.push(RuleChange {
                kind,
                template_id: selected.template_id.clone(),
                variables,
            });
        }
        Some(RulesChange {
            revision: self.revision.clone(),
            rules,
        })
    }

    pub(super) fn dirty(&self) -> bool {
        self.proposed()
            .is_none_or(|change| change.rules != self.baseline)
    }

    fn select_template(&mut self, template: Option<usize>) {
        if let (Some(index), Some(saved)) = (template, &self.entries[self.selected])
            && saved.template_id == self.templates[index].id
        {
            return;
        }
        self.entries[self.selected] = template.map(|index| {
            let template = &self.templates[index];
            DraftRule {
                template_id: template.id.clone(),
                variables: vec![None; template.parameters.len()],
            }
        });
    }
}

enum Operation {
    Open(String),
    Save(RulesChange),
}

enum Reply {
    Open(String, Vec<ApprovedTemplate>),
    Saved(bool),
}

impl Root {
    fn open_whatsapp_automations(&mut self, cx: &mut Context<Self>) {
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
        self.request_whatsapp_automations(Operation::Open(connection.revision.clone()), cx);
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
            self.request_whatsapp_automations(Operation::Save(proposed), cx);
        }
    }

    fn request_whatsapp_automations(&mut self, operation: Operation, cx: &mut Context<Self>) {
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let Overlay::Whatsapp(desk) = &mut self.overlay else {
            return;
        };
        if desk.editing_request {
            return;
        }
        desk.editing_request = true;
        desk.editor_message = None;
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
                desk.editing_request = false;
                match result {
                    Ok(Reply::Open(revision, templates)) => {
                        let current = desk
                            .snapshot
                            .as_ref()
                            .and_then(|view| view.connection.as_ref())
                            .filter(|connection| connection.revision == revision);
                        if let Some(connection) = current {
                            desk.editor = Some(Editor::new(connection, templates));
                        } else {
                            desk.editor_message = Some(Key::WhatsappRulesChanged);
                        }
                    }
                    Ok(Reply::Saved(true)) => {
                        desk.editor = None;
                        desk.editor_message = Some(Key::WhatsappRulesSaved);
                        root.load_whatsapp_desk(true, cx);
                    }
                    Ok(Reply::Saved(false)) => {
                        desk.editor_message = Some(Key::WhatsappRulesChanged);
                        root.load_whatsapp_desk(true, cx);
                    }
                    Err(_) => desk.editor_message = Some(Key::WhatsappRulesUnconfirmed),
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
            self.status.connectivity == Connectivity::Online && !stale && !desk.editing_request;
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
                    .map(|variable| variable.map(|variable| sample_value(variable, self.locale)))
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
                    desk.editor_message = None;
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
        !self.editing_request && !self.automations_stale()
    }

    fn automations_stale(&self) -> bool {
        self.editor.as_ref().is_some_and(|editor| {
            self.snapshot
                .as_ref()
                .and_then(|view| view.connection.as_ref())
                .is_none_or(|connection| connection.revision != editor.revision)
                || matches!(
                    self.editor_message,
                    Some(Key::WhatsappRulesChanged | Key::WhatsappRulesUnconfirmed)
                )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rule_requires_every_variable_and_reselecting_preserves_the_mapping() {
        let connection = Connection {
            phone: "+34611000000".into(),
            revision: "f".repeat(64),
            coexistence: true,
            expires_at: None,
            rules: vec![],
        };
        let template = ApprovedTemplate {
            id: "12345".into(),
            name: "confirmation".into(),
            language: "es_ES".into(),
            body: "Tu cita es a las {{ 1 }} con {{2}}.".into(),
            parameters: vec!["1".into(), "2".into()],
        };
        let mut editor = Editor::new(&connection, vec![template]);
        editor.select_template(Some(0));
        assert!(editor.dirty());
        assert!(editor.proposed().is_none());
        editor.entries[0].as_mut().unwrap().variables =
            vec![Some(Variable::Time), Some(Variable::Staff)];
        editor.select_template(Some(0));
        assert_eq!(
            editor.templates[0].sample(&[Some("16:00"), Some("Natalia")]),
            "Tu cita es a las 16:00 con Natalia."
        );
        let draft = editor.proposed().unwrap();
        assert_eq!(draft.revision, connection.revision);
        assert_eq!(
            draft.rules[0].variables,
            vec![Variable::Time, Variable::Staff]
        );
    }
}
