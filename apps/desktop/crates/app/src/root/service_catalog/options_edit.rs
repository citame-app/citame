use super::*;
use sob_core::model::ServiceOption;

pub(super) enum OptionsEditor {
    Variant {
        parent_service_id: String,
        label: Entity<TextField>,
    },
    Addon {
        eligible: BTreeSet<String>,
        search: Entity<TextField>,
    },
}

impl OptionsEditor {
    pub(super) fn new(option: ServiceOption, cx: &mut Context<Root>) -> Self {
        let (value, parent) = match option {
            ServiceOption::Variant {
                parent_service_id,
                option_label,
            } => (option_label, parent_service_id),
            ServiceOption::Addon {
                allowed_service_ids,
            } => {
                let search = cx.new(|cx| TextField::new("", false, cx));
                cx.observe(&search, |_, _, cx| cx.notify()).detach();
                return Self::Addon {
                    eligible: allowed_service_ids,
                    search,
                };
            }
        };
        let label = cx.new(|cx| {
            let mut field = TextField::new("", false, cx);
            field.set_text(&value, cx);
            field
        });
        cx.observe(&label, |_, _, cx| cx.notify()).detach();
        Self::Variant {
            parent_service_id: parent,
            label,
        }
    }

    pub(super) fn value(&self, cx: &App) -> ServiceOption {
        match self {
            Self::Variant {
                parent_service_id,
                label,
            } => ServiceOption::Variant {
                parent_service_id: parent_service_id.clone(),
                option_label: label.read(cx).text().trim().into(),
            },
            Self::Addon { eligible, .. } => ServiceOption::Addon {
                allowed_service_ids: eligible.clone(),
            },
        }
    }
}

impl Root {
    fn catalogue_option_name<'a>(&'a self, id: &'a str) -> &'a str {
        self.services
            .iter()
            .find(|row| row.id == id)
            .map_or(id, |row| row.name.as_str())
    }

    pub(super) fn catalogue_options_value(&self, option: &ServiceOption) -> String {
        match option {
            ServiceOption::Variant { option_label, .. } => option_label.clone(),
            ServiceOption::Addon {
                allowed_service_ids,
            } => allowed_service_ids
                .iter()
                .map(|id| self.catalogue_option_name(id))
                .collect::<Vec<_>>()
                .join(", "),
        }
    }

    pub(super) fn render_existing_options(
        &self,
        editor: &Editor,
        options: &OptionsEditor,
        current: Option<&CatalogService>,
        editable: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let current = current
            .and_then(|service| service.catalog.as_ref())
            .filter(|option| Some(*option) != editor.base.catalog.as_ref());
        let current_label = current.map(|option| self.catalogue_options_value(option));
        let section = div()
            .flex()
            .flex_col()
            .gap_2()
            .when_some(current_label, |body, label| {
                body.child(
                    div()
                        .text_sm()
                        .text_color(theme::muted())
                        .child(format!("{} {label}", self.t(Key::CatalogCurrent))),
                )
            });
        match options {
            OptionsEditor::Variant {
                parent_service_id,
                label,
            } => section
                .child(div().text_sm().child(format!(
                    "{} · {}",
                    self.t(Key::CatalogParent),
                    self.catalogue_option_name(parent_service_id)
                )))
                .child(div().text_sm().child(self.t(Key::CatalogOptionLabel)))
                .when(editable, |body| body.child(label.clone()))
                .when(!editable, |body| {
                    body.child(label.read(cx).text().to_owned())
                }),
            OptionsEditor::Addon { eligible, search } => {
                let query = search.read(cx).text().trim().to_lowercase();
                let currency = editor.fields[ServiceField::Currency.index()][0]
                    .input
                    .read(cx)
                    .text()
                    .trim()
                    .to_uppercase();
                let candidates: BTreeSet<_> = self
                    .services
                    .iter()
                    .filter(|row| row.is_addon_target(&currency))
                    .map(|row| row.id.as_str())
                    .collect();
                let mut ids: Vec<_> = candidates
                    .iter()
                    .copied()
                    .chain(
                        eligible
                            .iter()
                            .map(String::as_str)
                            .filter(|id| !candidates.contains(id)),
                    )
                    .collect();
                ids.sort_by_cached_key(|id| (self.catalogue_option_name(id).to_lowercase(), *id));
                section
                    .child(div().text_sm().child(self.t(Key::CatalogEligible)))
                    .when(editable, |body| {
                        body.child(div().text_sm().child(self.t(Key::AssignmentSearch)))
                            .child(search.clone())
                    })
                    .child(
                        div()
                            .id("configure-eligible-services")
                            .max_h(px(150.))
                            .overflow_y_scroll()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .children(
                                ids.into_iter()
                                    .filter(|id| {
                                        eligible.contains(*id)
                                            || (editable
                                                && self
                                                    .catalogue_option_name(id)
                                                    .to_lowercase()
                                                    .contains(&query))
                                    })
                                    .map(|id| {
                                        let chosen = eligible.contains(id);
                                        let name = self.catalogue_option_name(id);
                                        let label = if candidates.contains(id) {
                                            name.to_owned()
                                        } else {
                                            i18n::fill(
                                                self.t(Key::CatalogRemoveUnavailable),
                                                &[("name", name)],
                                            )
                                        };
                                        if !editable {
                                            return div()
                                                .text_sm()
                                                .child(name.to_owned())
                                                .into_any_element();
                                        }
                                        let id = id.to_owned();
                                        self.button(
                                            SharedString::from(format!("configure-addon-{id}")),
                                            label,
                                            if chosen { Kind::Primary } else { Kind::Ghost },
                                            cx.listener(move |root, _, _, cx| {
                                                if let Overlay::ServiceCatalog(desk) =
                                                    &mut root.overlay
                                                    && !desk.denied
                                                    && let Some(OptionsEditor::Addon {
                                                        eligible,
                                                        ..
                                                    }) = desk
                                                        .editor
                                                        .as_mut()
                                                        .and_then(|editor| editor.options.as_mut())
                                                    && !eligible.remove(&id)
                                                {
                                                    eligible.insert(id.clone());
                                                }
                                                cx.notify();
                                            }),
                                        )
                                        .into_any_element()
                                    }),
                            ),
                    )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn reviewing_two_variant_labels_requires_an_explicit_choice(cx: &mut TestAppContext) {
        let (_directory, window) = super::super::super::tests::open(cx);
        window
            .update(cx, |_, _, cx| {
                let variant = |text: &str| ServiceOption::Variant {
                    parent_service_id: "parent".into(),
                    option_label: text.into(),
                };
                let before = variant("Short");
                let proposed = variant("Medium");
                let cloud = variant("Long");
                let editor = OptionsEditor::new(proposed.clone(), cx);
                assert!(editor.value(cx).label_overlaps(Some(&before), Some(&cloud)));
                assert_eq!(
                    editor
                        .value(cx)
                        .review_change(Some(&before), Some(cloud.clone()), false),
                    Some(cloud.clone())
                );
                assert_eq!(
                    editor
                        .value(cx)
                        .review_change(Some(&before), Some(cloud), true),
                    Some(proposed)
                );
            })
            .unwrap();
    }
}
