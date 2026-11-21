use super::*;
use sob_core::http::{
    CatalogForm, CatalogPrice, CatalogService, CatalogWriteError, ReviewedCatalog, ServiceDetails,
    ServiceField,
};
use sob_core::sync::TransportError;

mod creation;

const FIELDS: [Key; ServiceField::COUNT] = [
    Key::CatalogName,
    Key::CatalogDescription,
    Key::ReportCategory,
    Key::CatalogColor,
    Key::CatalogOrder,
    Key::CatalogDuration,
    Key::CatalogBuffer,
    Key::CatalogExposureStart,
    Key::CatalogExposure,
    Key::CatalogInterval,
    Key::CatalogInstructions,
    Key::CatalogAmount,
    Key::CatalogCurrency,
];

fn multiline(field: ServiceField) -> Option<usize> {
    match field {
        ServiceField::Description | ServiceField::Instructions => Some(2_000),
        _ => None,
    }
}

struct CatalogLine {
    input: Entity<TextField>,
    _handler: Option<Subscription>,
}

fn catalog_line(
    field: ServiceField,
    label: &'static str,
    value: &str,
    cx: &mut Context<Root>,
) -> CatalogLine {
    let input = cx.new(|cx| {
        let input = TextField::new(label, false, cx);
        let mut input = match multiline(field) {
            Some(limit) => input.with_line_paste(limit),
            None => input,
        };
        input.set_text(value, cx);
        input
    });
    cx.observe(&input, |_, _, cx| cx.notify()).detach();
    let handler = multiline(field).map(|_| {
        cx.subscribe(&input, move |root, origin, event, cx| {
            let Overlay::ServiceCatalog(desk) = &mut root.overlay else {
                return;
            };
            let Some(editor) = &mut desk.editor else {
                return;
            };
            if desk.saving || desk.confirm_close {
                return;
            }
            let lines = &mut editor.fields[field.index()];
            let Some(index) = lines.iter().position(|line| line.input == origin) else {
                return;
            };
            match event {
                FieldEvent::PasteLines(tail) => {
                    lines.splice(
                        index + 1..index + 1,
                        tail.iter().map(|text| catalog_line(field, "", text, cx)),
                    );
                }
                FieldEvent::PasteTooLong => desk.notice = Some(Key::CatalogInvalid),
                _ => {}
            }
            cx.notify();
        })
    });
    CatalogLine {
        input,
        _handler: handler,
    }
}

fn catalogue_lines(
    field: ServiceField,
    label: &'static str,
    text: &str,
    cx: &mut Context<Root>,
) -> Vec<CatalogLine> {
    if multiline(field).is_some() {
        text.split('\n')
            .map(|line| catalog_line(field, label, line, cx))
            .collect()
    } else {
        vec![catalog_line(field, label, text, cx)]
    }
}

struct Editor {
    base: CatalogService,
    baseline: CatalogForm,
    generation: String,
    fields: [Vec<CatalogLine>; ServiceField::COUNT],
    price_type: CatalogPrice,
    visible: bool,
    active: bool,
    creation: Option<creation::Draft>,
}

impl Editor {
    fn new(
        base: CatalogService,
        generation: String,
        labels: [&'static str; ServiceField::COUNT],
        cx: &mut Context<Root>,
    ) -> Self {
        let baseline = CatalogForm::from(&base.details);
        let fields = ServiceField::ALL.map(|field| {
            let index = field.index();
            catalogue_lines(field, labels[index], &baseline.fields[index], cx)
        });
        Self {
            generation,
            price_type: baseline.price_type,
            visible: baseline.online_booking,
            active: baseline.active,
            base,
            baseline,
            fields,
            creation: None,
        }
    }

    fn form(&self, cx: &App) -> CatalogForm {
        CatalogForm {
            fields: self.fields.each_ref().map(|lines| {
                lines
                    .iter()
                    .map(|line| line.input.read(cx).text())
                    .collect::<Vec<_>>()
                    .join("\n")
            }),
            price_type: self.price_type,
            online_booking: self.visible,
            active: self.active,
        }
    }

    fn dirty(&self, cx: &App) -> bool {
        self.form(cx) != self.baseline
    }

    fn review(&mut self, generation: String, current: CatalogService, cx: &mut Context<Root>) {
        let draft = self.form(cx);
        let edited = draft.fields.clone();
        self.baseline = CatalogForm::from(&current.details);
        let reviewed = draft.review(
            &CatalogForm::from(&self.base.details),
            CatalogForm::from(&current.details),
        );
        for field in ServiceField::ALL {
            let index = field.index();
            if edited[index] != reviewed.fields[index] {
                self.fields[index] = catalogue_lines(field, "", &reviewed.fields[index], cx);
            }
        }
        self.price_type = reviewed.price_type;
        self.visible = reviewed.online_booking;
        self.active = reviewed.active;
        self.generation = generation;
        self.base = current;
    }
}

pub(super) struct Desk {
    identity: Arc<()>,
    list: Option<ReviewedCatalog>,
    search: Entity<TextField>,
    editor: Option<Editor>,
    busy: bool,
    saving: bool,
    observed: Option<(i64, i64)>,
    retry_at: Option<Instant>,
    requires_load: bool,
    confirm_close: bool,
    notice: Option<Key>,
    pending_creations: Vec<sob_core::http::ServiceCreation>,
    pending_version: Option<i64>,
}

impl Desk {
    fn latest(&self) -> Option<(&str, &CatalogService)> {
        let list = self.list.as_ref()?;
        let id = &self.editor.as_ref()?.base.id;
        Some((
            &list.generation,
            list.services.iter().find(|service| &service.id == id)?,
        ))
    }

    fn changed(&self, editor: &Editor) -> bool {
        if editor.creation.is_some() {
            return false;
        }
        self.latest()
            .is_none_or(|(generation, row)| editor.generation != generation || editor.base != *row)
    }
}

impl Root {
    pub(super) fn open_service_catalog(&mut self, cx: &mut Context<Self>) {
        let search = cx.new(|cx| TextField::new(self.t(Key::AssignmentSearch), false, cx));
        cx.observe(&search, |_, _, cx| cx.notify()).detach();
        self.overlay = Overlay::ServiceCatalog(Box::new(Desk {
            identity: Arc::new(()),
            list: None,
            editor: None,
            search,
            busy: false,
            saving: false,
            observed: None,
            retry_at: None,
            requires_load: true,
            confirm_close: false,
            notice: None,
            pending_creations: self
                .svc
                .store
                .pending_service_creations()
                .unwrap_or_default(),
            pending_version: self.data_version,
        }));
        self.request_service_catalog(None, cx);
        cx.notify();
    }

    pub(super) fn preserve_open_catalogue(&mut self) -> bool {
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return false;
        };
        desk.list = None;
        desk.observed = None;
        desk.retry_at = None;
        desk.identity = Arc::new(());
        desk.busy = false;
        desk.saving = false;
        desk.requires_load = true;
        true
    }

    fn catalog_review_revision(&self) -> Option<(i64, i64)> {
        Some((
            self.svc.store.catalog_revision().ok()?,
            self.svc.store.staff_directory_revision().ok()?,
        ))
    }

    pub(super) fn refresh_open_service_catalog(
        &mut self,
        reconnected: bool,
        cx: &mut Context<Self>,
    ) {
        if !matches!(self.overlay, Overlay::ServiceCatalog(_)) {
            return;
        }
        let revision = self.catalog_review_revision();
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return;
        };
        if desk.pending_version != self.data_version
            && let Ok(creates) = self.svc.store.pending_service_creations()
        {
            desk.pending_creations = creates;
            desk.pending_version = self.data_version;
            cx.notify();
        }
        if reconnected {
            desk.observed = None;
        }
        let refresh = desk
            .retry_at
            .map_or_else(|| desk.observed != revision, |when| Instant::now() >= when);
        if !desk.busy && !desk.confirm_close && refresh {
            self.request_service_catalog(None, cx);
        }
    }

    fn request_service_catalog(
        &mut self,
        proposal: Option<ServiceDetails>,
        cx: &mut Context<Self>,
    ) {
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let revision = self.catalog_review_revision();
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy || desk.retry_at.is_some_and(|when| Instant::now() < when) {
            return;
        }
        let save = proposal
            .zip(desk.editor.as_ref())
            .map(|(proposal, editor)| (editor.generation.clone(), editor.base.clone(), proposal));
        desk.busy = true;
        desk.saving = save.is_some();
        desk.observed = revision;
        desk.retry_at = None;
        if desk.saving {
            desk.notice = None;
        }
        let identity = desk.identity.clone();
        let session = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match save {
                        Some((generation, base, desired)) => transport
                            .save_reviewed_service(&generation, &base, &desired)
                            .map(Box::new)
                            .map(CatalogReply::Saved),
                        None => transport
                            .reviewed_catalog()
                            .map(CatalogReply::Listed)
                            .map_err(CatalogWriteError::from),
                    }
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                let Overlay::ServiceCatalog(desk) = &mut root.overlay else {
                    return;
                };
                if !Arc::ptr_eq(&desk.identity, &identity)
                    || !Arc::ptr_eq(&root.svc.session, &session)
                {
                    return;
                }
                desk.busy = false;
                desk.saving = false;
                desk.requires_load = matches!(result, Err(CatalogWriteError::Transport(_)));
                match result {
                    Ok(CatalogReply::Listed(list)) => {
                        let _ = root.svc.store.remember_catalogue_access(&list.generation);
                        desk.list = Some(list);
                        if !matches!(desk.notice, Some(Key::CatalogSaved)) {
                            desk.notice = None;
                        }
                        if let (Some(editor), Some((generation, row))) =
                            (&desk.editor, desk.latest())
                            && !editor.dirty(cx)
                            && desk.changed(editor)
                        {
                            let (generation, row) = (generation.to_owned(), row.clone());
                            if let Some(editor) = &mut desk.editor {
                                editor.review(generation, row, cx);
                            }
                        }
                    }
                    Ok(CatalogReply::Saved(saved)) => {
                        if let Some(list) = &mut desk.list
                            && let Some(row) =
                                list.services.iter_mut().find(|row| row.id == saved.id)
                        {
                            *row = *saved;
                        }
                        desk.editor = None;
                        desk.notice = Some(Key::CatalogSaved);
                        root.svc.wake(Wake::Local);
                    }
                    Err(CatalogWriteError::Invalid) => desk.notice = Some(Key::CatalogInvalid),
                    Err(CatalogWriteError::Transport(
                        TransportError::Forbidden(_) | TransportError::Unauthorized,
                    )) => {
                        let _ = root.svc.store.forget_catalogue_access();
                        desk.list = None;
                        if desk
                            .editor
                            .as_ref()
                            .is_some_and(|editor| editor.creation.is_none())
                        {
                            desk.editor = None;
                        }
                        desk.notice = Some(Key::CatalogAccessLost);
                    }
                    Err(CatalogWriteError::Transport(error)) => {
                        let delay = match error {
                            TransportError::Offline(_) | TransportError::Server(_) => {
                                Some(Duration::from_secs(3))
                            }
                            TransportError::RateLimited(delay) => Some(
                                delay
                                    .unwrap_or(Duration::from_secs(30))
                                    .max(Duration::from_secs(1)),
                            ),
                            _ => None,
                        };
                        desk.retry_at = delay.and_then(|wait| Instant::now().checked_add(wait));
                        desk.notice = Some(Key::CatalogFailed);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn select_catalog_service(&mut self, id: &str, cx: &mut Context<Self>) {
        let labels = FIELDS.map(|key| self.t(key));
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy {
            return;
        }
        let Some(list) = &desk.list else { return };
        let Some(base) = list.services.iter().find(|s| s.id == id).cloned() else {
            return;
        };
        desk.editor = Some(Editor::new(base, list.generation.clone(), labels, cx));
        desk.notice = None;
        cx.notify();
    }

    fn save_catalog_service(&mut self, cx: &mut Context<Self>) {
        if matches!(&self.overlay, Overlay::ServiceCatalog(desk) if desk.editor.as_ref().is_some_and(|editor| editor.creation.is_some()))
        {
            self.queue_catalog_creation(cx);
            return;
        }
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return;
        };
        let Some(editor) = &desk.editor else { return };
        if desk.busy || desk.requires_load || desk.confirm_close || desk.changed(editor) {
            return;
        }
        if let Some(input) = editor.form(cx).details(&editor.base.details) {
            self.request_service_catalog(Some(input), cx);
        } else {
            desk.notice = Some(Key::CatalogInvalid);
            cx.notify();
        }
    }

    pub(super) fn close_service_catalog(&mut self, cx: &mut Context<Self>) {
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy {
            return;
        }
        if desk.editor.as_ref().is_some_and(|editor| {
            editor.dirty(cx)
                || editor
                    .creation
                    .as_ref()
                    .is_some_and(|draft| draft.dirty(cx))
        }) {
            desk.confirm_close = !desk.confirm_close;
        } else if desk.editor.is_some() {
            desk.editor = None;
        } else {
            self.open_web_management(cx);
        }
        cx.notify();
    }

    pub(super) fn render_service_catalog(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_center()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(self.t(Key::CatalogTitle)),
                    )
                    .child(self.button(
                        "catalog-back",
                        self.t(Key::Back),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.close_service_catalog(cx)),
                    )),
            )
            .when(!online, |body| body.child(self.t(Key::CatalogOffline)))
            .when(desk.busy, |body| {
                body.child(self.t(Key::CloudWorkspacesLoading))
            })
            .when_some(desk.notice, |body, key| {
                body.child(div().text_sm().child(self.t(key)))
            })
            .when(desk.confirm_close, |body| {
                body.child(self.t(Key::SalonConfirmDiscard))
                    .child(self.button(
                        "catalog-discard",
                        self.t(Key::SalonDiscard),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| {
                            if let Overlay::ServiceCatalog(desk) = &mut root.overlay {
                                desk.confirm_close = false;
                                desk.editor = None;
                            }
                            cx.notify();
                        }),
                    ))
            })
            .when(!desk.confirm_close, |body| {
                body.when(online && !desk.busy, |body| {
                    body.child(self.button(
                        "catalog-refresh",
                        self.t(Key::CatalogReload),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.request_service_catalog(None, cx)),
                    ))
                })
                .when_some(desk.editor.as_ref(), |body, editor| {
                    body.child(self.render_catalog_editor(desk, editor, online, cx))
                })
                .when(desk.editor.is_none(), |body| {
                    body.child(self.render_catalog_list(desk, cx))
                })
            });
        self.modal_with_height(
            body,
            (viewport.width - px(32.)).max(px(280.)).min(px(630.)),
            (viewport.height - px(32.)).max(px(260.)).min(px(740.)),
            Some(cx),
        )
    }

    fn render_catalog_list(&self, desk: &Desk, cx: &mut Context<Self>) -> impl IntoElement {
        let search = desk.search.read(cx).text().trim().to_lowercase();
        let rows = desk
            .list
            .iter()
            .flat_map(|list| list.services.iter())
            .filter(|row| {
                row.details.name.to_lowercase().contains(&search)
                    || row
                        .details
                        .category
                        .as_ref()
                        .is_some_and(|s| s.to_lowercase().contains(&search))
            });
        div()
            .min_h_0()
            .flex()
            .flex_col()
            .gap_2()
            .when(self.can_create_catalogue_item() && !desk.saving, |view| {
                view.child(self.button(
                    "catalog-new",
                    self.t(Key::CatalogNew),
                    Kind::Primary,
                    cx.listener(|root, _, _, cx| root.open_catalog_creation(None, cx)),
                ))
            })
            .child(desk.search.clone())
            .child(
                div()
                    .id("catalog-list")
                    .min_h_0()
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .children(
                        desk.pending_creations
                            .iter()
                            .filter(|row| row.service.details.name.to_lowercase().contains(&search))
                            .map(|row| {
                                div().text_sm().child(format!(
                                    "{} · {}",
                                    row.service.details.name,
                                    self.t(Key::CatalogPending)
                                ))
                            }),
                    )
                    .children(rows.map(|row| {
                        let id = row.id.clone();
                        let label = if row.details.active {
                            row.details.name.clone()
                        } else {
                            format!(
                                "{} · {}",
                                row.details.name,
                                self.t(Key::StaffPortraitInactive)
                            )
                        };
                        self.button(
                            SharedString::from(format!("catalog-{id}")),
                            label,
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| root.select_catalog_service(&id, cx)),
                        )
                    })),
            )
    }

    fn edit_catalogue_line(&mut self, field: ServiceField, add: bool, cx: &mut Context<Self>) {
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return;
        };
        let Some(editor) = &mut desk.editor else {
            return;
        };
        if desk.saving || desk.confirm_close || multiline(field).is_none() {
            return;
        }
        let lines = &mut editor.fields[field.index()];
        if add {
            lines.push(catalog_line(field, "", "", cx));
        } else if lines.len() > 1 {
            lines.pop();
        }
        cx.notify();
    }

    fn render_catalog_editor(
        &self,
        desk: &Desk,
        editor: &Editor,
        online: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let changed = desk.changed(editor);
        let latest = desk
            .latest()
            .filter(|_| changed)
            .map(|(_, row)| &row.details);
        let current = latest.map(CatalogForm::from);
        let original = &editor.baseline.fields;
        div()
            .min_h_0()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .id("editor-catalog-fields")
                    .min_h_0()
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .when(changed, |body| {
                        body.child(div().text_sm().child(self.t(Key::CatalogChanged)))
                    })
                    .when_some(editor.creation.as_ref(), |body, draft| {
                        body.child(self.render_creation_options(draft, cx))
                    })
                    .children(ServiceField::ALL.map(|field| {
                        let index = field.index();
                        let lines = &editor.fields[index];
                        let hint = current
                            .as_ref()
                            .map(|values| &values.fields[index])
                            .filter(|value| **value != original[index]);
                        let input =
                            div()
                                .flex()
                                .flex_col()
                                .gap_1()
                                .child(div().text_sm().child(self.t(FIELDS[index])))
                                .when_some(hint, |body, value| {
                                    body.child(div().text_sm().text_color(theme::muted()).child(
                                        format!("{} {}", self.t(Key::CatalogCurrent), value),
                                    ))
                                });
                        if desk.saving
                            || field == ServiceField::Price && !editor.price_type.requires_amount()
                        {
                            input.child(
                                div().text_sm().child(
                                    lines
                                        .iter()
                                        .map(|line| line.input.read(cx).text())
                                        .collect::<Vec<_>>()
                                        .join("\n"),
                                ),
                            )
                        } else {
                            input
                                .children(lines.iter().map(|line| line.input.clone()))
                                .when(multiline(field).is_some(), |body| {
                                    body.child(
                                        div()
                                            .flex()
                                            .gap_2()
                                            .flex_wrap()
                                            .child(self.button(
                                                ("catalog-add-line", index),
                                                self.t(Key::ReviewAddLine),
                                                Kind::Ghost,
                                                cx.listener(move |root, _, _, cx| {
                                                    root.edit_catalogue_line(field, true, cx)
                                                }),
                                            ))
                                            .when(lines.len() > 1, |body| {
                                                body.child(self.button(
                                                    ("catalog-remove-line", index),
                                                    self.t(Key::ReviewRemoveLine),
                                                    Kind::Ghost,
                                                    cx.listener(move |root, _, _, cx| {
                                                        root.edit_catalogue_line(field, false, cx)
                                                    }),
                                                ))
                                            }),
                                    )
                                })
                        }
                    }))
                    .when_some(
                        latest.filter(|value| value.price_type != editor.base.details.price_type),
                        |body, value| {
                            body.child(format!(
                                "{} {}",
                                self.t(Key::CatalogCurrent),
                                self.t(price_label(value.price_type))
                            ))
                        },
                    )
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_2()
                            .children(CatalogPrice::ALL.map(|price| {
                                self.button(
                                    ("catalog-price", price as usize),
                                    self.t(price_label(price)),
                                    if price == editor.price_type {
                                        Kind::Primary
                                    } else {
                                        Kind::Ghost
                                    },
                                    cx.listener(move |root, _, _, cx| {
                                        if let Overlay::ServiceCatalog(desk) = &mut root.overlay
                                            && !desk.busy
                                            && let Some(editor) = &mut desk.editor
                                        {
                                            editor.price_type = price;
                                        }
                                        cx.notify();
                                    }),
                                )
                            })),
                    )
                    .when_some(
                        latest.filter(|value| {
                            value.online_booking != editor.base.details.online_booking
                                || value.active != editor.base.details.active
                        }),
                        |body, value| {
                            body.child(format!(
                                "{} {} · {}",
                                self.t(Key::CatalogCurrent),
                                self.t(visibility_label(value.online_booking)),
                                self.t(activity_label(value.active))
                            ))
                        },
                    )
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_2()
                            .child(self.button(
                                "catalog-online",
                                self.t(visibility_label(editor.visible)),
                                Kind::Ghost,
                                cx.listener(|root, _, _, cx| {
                                    if let Overlay::ServiceCatalog(desk) = &mut root.overlay
                                        && !desk.busy
                                        && let Some(editor) = &mut desk.editor
                                    {
                                        editor.visible = !editor.visible;
                                    }
                                    cx.notify();
                                }),
                            ))
                            .when(editor.creation.is_none(), |view| {
                                view.child(self.button(
                                    "catalog-active",
                                    self.t(activity_label(editor.active)),
                                    Kind::Ghost,
                                    cx.listener(|root, _, _, cx| {
                                        if let Overlay::ServiceCatalog(desk) = &mut root.overlay
                                            && !desk.busy
                                            && let Some(editor) = &mut desk.editor
                                        {
                                            editor.active = !editor.active;
                                        }
                                        cx.notify();
                                    }),
                                ))
                            }),
                    ),
            )
            .when(editor.creation.is_some(), |body| {
                body.child(self.render_creation_action(desk, editor, cx))
            })
            .when(
                editor.creation.is_none() && online && !desk.busy && !desk.requires_load,
                |body| {
                    if changed && latest.is_some() {
                        body.child(self.button(
                            "catalog-review",
                            self.t(Key::CatalogReview),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| {
                                let Overlay::ServiceCatalog(desk) = &mut root.overlay else {
                                    return;
                                };
                                let Some((generation, row)) = desk.latest() else {
                                    return;
                                };
                                let (generation, row) = (generation.to_owned(), row.clone());
                                if let Some(editor) = &mut desk.editor {
                                    editor.review(generation, row, cx);
                                }
                                cx.notify();
                            }),
                        ))
                    } else {
                        body.when(!changed && editor.dirty(cx), |body| {
                            body.child(self.button(
                                "catalog-save",
                                self.t(Key::SaveServiceAnnotations),
                                Kind::Primary,
                                cx.listener(|root, _, _, cx| root.save_catalog_service(cx)),
                            ))
                        })
                    }
                },
            )
    }
}

enum CatalogReply {
    Listed(ReviewedCatalog),
    Saved(Box<CatalogService>),
}

fn price_label(price: CatalogPrice) -> Key {
    match price {
        CatalogPrice::Fixed => Key::CatalogFixed,
        CatalogPrice::From => Key::CatalogFrom,
        CatalogPrice::Variable => Key::CatalogVariable,
        CatalogPrice::Hidden => Key::CatalogHidden,
        CatalogPrice::Free => Key::CatalogFree,
    }
}

fn visibility_label(visible: bool) -> Key {
    if visible {
        Key::CatalogPublic
    } else {
        Key::CatalogPrivate
    }
}

fn activity_label(active: bool) -> Key {
    if active {
        Key::CatalogActive
    } else {
        Key::StaffPortraitInactive
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn catalogue_review_keeps_the_price_and_adopts_untouched_cloud_fields(
        cx: &mut TestAppContext,
    ) {
        let (_directory, window) = super::super::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                let original: CatalogService = serde_json::from_value(serde_json::json!({
                    "id": "service-1", "version": 3, "name": "Treatment", "description": "",
                    "clientInstructions": "First line\nSecond line",
                    "processing": { "startsAfterMinutes": 10, "minutes": 10 },
                    "durationMinutes": 30, "bufferMinutes": 5, "priceCents": 2000,
                    "sortOrder": 1, "currency": "EUR", "onlineBooking": true, "active": true,
                }))
                .unwrap();
                let mut editor = Editor::new(
                    original.clone(),
                    "original".into(),
                    FIELDS.map(|key| root.t(key)),
                    cx,
                );
                assert!(!editor.dirty(cx));
                assert_eq!(
                    editor
                        .form(cx)
                        .details(&editor.base.details)
                        .unwrap()
                        .description
                        .as_deref(),
                    Some("")
                );
                editor.fields[ServiceField::Price.index()][0]
                    .input
                    .update(cx, |field, cx| field.set_text("27,50", cx));
                editor.fields[ServiceField::ProcessingLength.index()][0]
                    .input
                    .update(cx, |field, cx| field.set_text("8", cx));
                let mut newer = original;
                newer.version += 1;
                newer.details.name = "Treatment from Cloud".into();
                newer.details.price_type = CatalogPrice::Variable;
                newer.details.price_cents = 0;
                newer.details.processing = None;
                editor.review("restored".into(), newer, cx);
                let draft = editor.form(cx).details(&editor.base.details).unwrap();
                assert_eq!(editor.generation, "restored");
                assert_eq!(editor.base.version, 4);
                assert_eq!(draft.name, "Treatment from Cloud");
                assert_eq!(draft.price_type, CatalogPrice::Fixed);
                assert_eq!(draft.price_cents, 2750);
                assert_eq!(
                    draft.client_instructions.as_deref(),
                    Some("First line\nSecond line")
                );
                assert_eq!(
                    draft.processing,
                    Some(ProcessingTime {
                        starts_after_minutes: 10,
                        minutes: 8
                    })
                );
                assert!(editor.dirty(cx));
            })
            .unwrap();
    }
}
