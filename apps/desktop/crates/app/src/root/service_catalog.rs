use super::*;
use sob_core::http::{
    CatalogForm, CatalogPrice, CatalogService, ReviewedCatalog, ServiceDetails, ServiceField,
};
use sob_core::store::{PendingServiceEdit, SERVICE_EDIT_KIND, ServiceAssignment};
use sob_core::sync::TransportError;
use std::collections::{BTreeMap, BTreeSet};

mod creation;
mod options_edit;
use options_edit::OptionsEditor;
use sob_core::model::ServiceOption;

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
            if desk.denied || desk.confirm_close {
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
    assigned: BTreeSet<String>,
    options: Option<OptionsEditor>,
    creation: Option<creation::Draft>,
    recovery: Option<Recovery>,
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
        let options = base.catalog.clone().map(|row| OptionsEditor::new(row, cx));
        Self {
            generation,
            price_type: baseline.price_type,
            visible: baseline.online_booking,
            active: baseline.active,
            assigned: base.staff_ids.clone(),
            options,
            base,
            baseline,
            fields,
            creation: None,
            recovery: None,
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
            || self.assigned != self.base.staff_ids
            || self.options_value(cx) != self.base.catalog
    }

    fn options_value(&self, cx: &App) -> Option<ServiceOption> {
        self.options.as_ref().map(|options| options.value(cx))
    }

    fn review(&mut self, generation: String, current: CatalogService, cx: &mut Context<Root>) {
        self.apply_review(generation, current, true, cx);
    }

    fn apply_review(
        &mut self,
        generation: String,
        current: CatalogService,
        keep_draft_groups: bool,
        cx: &mut Context<Root>,
    ) {
        let draft = self.form(cx);
        let edited = draft.fields.clone();
        self.baseline = CatalogForm::from(&current.details);
        let reviewed = draft.review(
            &CatalogForm::from(&self.base.details),
            CatalogForm::from(&current.details),
            keep_draft_groups,
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
        self.assigned =
            ServiceAssignment::reapply(&self.base.staff_ids, &self.assigned, &current.staff_ids);
        let options = match &self.options {
            Some(options) => options.value(cx).review_change(
                self.base.catalog.as_ref(),
                current.catalog.clone(),
                keep_draft_groups,
            ),
            None => current.catalog.clone(),
        };
        if options != self.options_value(cx) {
            self.options = options.map(|options| OptionsEditor::new(options, cx));
        }
        self.generation = generation;
        self.base = current;
    }
}

struct Recovery {
    mutation_id: String,
    reviewed: bool,
    restored: bool,
    rejected_version: Option<u64>,
    rejected_team: Option<BTreeSet<String>>,
}

pub(super) struct Desk {
    identity: Arc<()>,
    list: Option<ReviewedCatalog>,
    replica: Option<ReviewedCatalog>,
    search: Entity<TextField>,
    editor: Option<Editor>,
    busy: bool,
    observed: Option<(i64, i64)>,
    retry_at: Option<Instant>,
    denied: bool,
    confirm_close: bool,
    notice: Option<Key>,
    pending_creations: Vec<sob_core::http::ServiceCreation>,
    pending_edits: Vec<PendingServiceEdit>,
    pending_preview: Option<String>,
    pending_version: Option<i64>,
}

impl Desk {
    fn display_services(&self) -> Vec<(&CatalogService, bool)> {
        let mut rows = BTreeMap::new();
        if let Some(cloud) = &self.list {
            rows.extend(
                cloud
                    .services
                    .iter()
                    .map(|row| (row.id.as_str(), (row, false))),
            );
        }
        if let Some(replica) = &self.replica
            && self
                .list
                .as_ref()
                .is_none_or(|cloud| cloud.generation == replica.generation)
        {
            for local in &replica.services {
                let remote = rows.get(local.id.as_str()).map(|(row, _)| *row);
                if remote
                    .is_none_or(|row| !row.supersedes_review(local.version, Some(&local.staff_ids)))
                {
                    rows.insert(local.id.as_str(), (local, true));
                }
            }
        }
        let mut rows: Vec<_> = rows.into_values().collect();
        rows.sort_by_cached_key(|(row, _)| (row.details.name.to_lowercase(), row.id.as_str()));
        rows
    }

    fn pending_edit(&self, id: &str) -> bool {
        self.pending_edits.iter().any(|row| row.id == id)
    }

    fn previewed_edit(&self) -> Option<&PendingServiceEdit> {
        let id = self.pending_preview.as_ref()?;
        self.pending_edits.iter().find(|row| &row.id == id)
    }

    fn latest(&self) -> Option<(&str, &CatalogService)> {
        let list = self.replica.as_ref()?;
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
        if self.cloud_ahead(&editor.base.id) {
            return true;
        }
        if editor
            .recovery
            .as_ref()
            .is_some_and(|draft| !draft.reviewed)
        {
            return true;
        }
        self.latest()
            .is_none_or(|(generation, row)| editor.generation != generation || editor.base != *row)
    }

    fn cloud_ahead(&self, id: &str) -> bool {
        let (Some(local), Some(cloud)) = (&self.replica, &self.list) else {
            return false;
        };
        if local.generation != cloud.generation {
            return true;
        }
        let local = local.services.iter().find(|row| row.id == id);
        let cloud = cloud.services.iter().find(|row| row.id == id);
        matches!((local, cloud), (Some(local), Some(cloud)) if cloud.supersedes_review(local.version, Some(&local.staff_ids)))
    }

    fn available_review(&self, editor: &Editor) -> Option<(&str, &CatalogService)> {
        let (generation, current) = self.latest()?;
        if self.cloud_ahead(&current.id)
            || editor.recovery.as_ref().is_some_and(|draft| {
                !draft.restored
                    && draft.rejected_version.is_some_and(|version| {
                        !current.supersedes_review(version, draft.rejected_team.as_ref())
                    })
            })
        {
            return None;
        }
        let restored = editor.generation != generation
            || editor
                .recovery
                .as_ref()
                .is_some_and(|draft| draft.restored && !draft.reviewed);
        if restored
            && !self.list.as_ref().is_some_and(|list| {
                list.generation == generation
                    && list.services.iter().any(|row| {
                        row.id == current.id
                            && row.version == current.version
                            && row.staff_ids == current.staff_ids
                    })
            })
        {
            return None;
        }
        Some((generation, current))
    }
}

impl Root {
    pub(super) fn open_service_catalog(&mut self, cx: &mut Context<Self>) {
        let search = cx.new(|cx| TextField::new(self.t(Key::AssignmentSearch), false, cx));
        cx.observe(&search, |_, _, cx| cx.notify()).detach();
        self.overlay = Overlay::ServiceCatalog(Box::new(Desk {
            identity: Arc::new(()),
            list: None,
            replica: self
                .can_create_catalogue_item()
                .then(|| self.svc.store.reviewed_catalogue().ok())
                .flatten(),
            editor: None,
            search,
            busy: false,
            observed: None,
            retry_at: None,
            denied: false,
            confirm_close: false,
            notice: None,
            pending_creations: self
                .svc
                .store
                .pending_service_creations()
                .unwrap_or_default(),
            pending_edits: self.svc.store.pending_service_edits().unwrap_or_default(),
            pending_preview: None,
            pending_version: self.data_version,
        }));
        self.request_service_catalog(cx);
        cx.notify();
    }

    pub(super) fn preserve_open_catalogue(&mut self) -> bool {
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return false;
        };
        desk.list = None;
        desk.replica = None;
        desk.observed = None;
        desk.retry_at = None;
        desk.identity = Arc::new(());
        desk.busy = false;
        if let Some(recovery) = desk
            .editor
            .as_mut()
            .and_then(|editor| editor.recovery.as_mut())
        {
            recovery.reviewed = false;
            recovery.restored = true;
        }
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
        let authorized = self.can_create_catalogue_item();
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return;
        };
        if desk.pending_version != self.data_version {
            desk.pending_creations = self
                .svc
                .store
                .pending_service_creations()
                .unwrap_or_default();
            desk.pending_edits = self.svc.store.pending_service_edits().unwrap_or_default();
            if desk.previewed_edit().is_none() {
                desk.pending_preview = None;
            }
            desk.replica = (!desk.denied && authorized)
                .then(|| self.svc.store.reviewed_catalogue().ok())
                .flatten();
            desk.pending_version = self.data_version;
            Self::refresh_clean_editor(desk, cx);
            cx.notify();
        }
        if reconnected {
            desk.observed = None;
        }
        let refresh = desk
            .retry_at
            .map_or_else(|| desk.observed != revision, |when| Instant::now() >= when);
        if !desk.busy && !desk.confirm_close && refresh {
            self.request_service_catalog(cx);
        }
    }

    fn refresh_clean_editor(desk: &mut Desk, cx: &mut Context<Self>) {
        let Some(editor) = &desk.editor else { return };
        if editor.creation.is_some()
            || editor.recovery.is_some()
            || editor.dirty(cx)
            || !desk.changed(editor)
        {
            return;
        }
        if let Some((generation, row)) = desk.latest() {
            let (generation, row) = (generation.to_owned(), row.clone());
            if let Some(editor) = &mut desk.editor {
                editor.review(generation, row, cx);
            }
        }
    }

    fn request_service_catalog(&mut self, cx: &mut Context<Self>) {
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
        desk.busy = true;
        desk.observed = revision;
        desk.retry_at = None;
        let identity = desk.identity.clone();
        let session = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.reviewed_catalog() })
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
                match result {
                    Ok(list) => {
                        let _ = root.svc.store.remember_catalogue_access(&list.generation);
                        desk.replica = root.svc.store.reviewed_catalogue().ok();
                        desk.list = Some(list);
                        desk.denied = false;
                        Self::refresh_clean_editor(desk, cx);
                    }
                    Err(TransportError::Forbidden(_) | TransportError::Unauthorized) => {
                        let _ = root.svc.store.forget_catalogue_access();
                        desk.list = None;
                        desk.replica = None;
                        desk.denied = true;
                        desk.notice = Some(Key::CatalogAccessLost);
                    }
                    Err(error) => {
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
                        if desk.list.is_none() && desk.replica.is_none() {
                            desk.notice = Some(Key::CatalogFailed);
                        }
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
        if desk.denied || desk.pending_edit(id) {
            return;
        }
        let Some(list) = &desk.replica else { return };
        if desk.cloud_ahead(id) {
            return;
        }
        let Some(base) = list.services.iter().find(|s| s.id == id).cloned() else {
            return;
        };
        desk.editor = Some(Editor::new(base, list.generation.clone(), labels, cx));
        desk.notice = None;
        cx.notify();
    }

    pub(super) fn open_catalog_edit_conflict(&mut self, mutation_id: &str, cx: &mut Context<Self>) {
        if !self.can_create_catalogue_item() {
            return;
        }
        let Ok(Some(conflict)) = self.svc.store.conflict(mutation_id) else {
            return;
        };
        if conflict.kind != SERVICE_EDIT_KIND {
            return;
        }
        let restored = conflict.requires_restored_review();
        let is_version_conflict = conflict.reason == "conflict";
        let Ok(edit) = serde_json::from_value::<PendingServiceEdit>(conflict.payload) else {
            return;
        };
        let Ok(proposed) = edit.proposal() else {
            return;
        };
        let Ok(proposed_options) = edit.options_proposal() else {
            return;
        };
        let labels = FIELDS.map(|key| self.t(key));
        self.open_service_catalog(cx);
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return;
        };
        let generation = desk
            .replica
            .as_ref()
            .or(desk.list.as_ref())
            .map(|list| list.generation.clone())
            .unwrap_or_default();
        let mut editor = Editor::new(
            CatalogService {
                id: edit.id,
                version: edit.version,
                details: edit.reviewed,
                catalog: edit.reviewed_catalog,
                staff_ids: edit
                    .assignment
                    .as_ref()
                    .map(|team| team.reviewed_staff_ids.clone())
                    .unwrap_or_default(),
            },
            generation,
            labels,
            cx,
        );
        let form = CatalogForm::from(&proposed);
        for field in ServiceField::ALL {
            let index = field.index();
            if form.fields[index] != editor.baseline.fields[index] {
                editor.fields[index] =
                    catalogue_lines(field, labels[index], &form.fields[index], cx);
            }
        }
        editor.price_type = form.price_type;
        editor.visible = form.online_booking;
        editor.active = form.active;
        let rejected_team = edit
            .assignment
            .as_ref()
            .map(|team| team.reviewed_staff_ids.clone());
        if let Some(team) = edit.assignment {
            editor.assigned = team.staff_ids;
        }
        if let Some(proposed) = proposed_options {
            editor.options = Some(OptionsEditor::new(proposed, cx));
        }
        editor.recovery = Some(Recovery {
            mutation_id: mutation_id.into(),
            reviewed: false,
            restored,
            rejected_version: is_version_conflict.then_some(edit.version),
            rejected_team,
        });
        desk.editor = Some(editor);
        cx.notify();
    }

    fn review_catalog_edit(&mut self, keep_draft_groups: bool, cx: &mut Context<Self>) {
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return;
        };
        let Some(editor) = desk.editor.as_ref() else {
            return;
        };
        let Some((generation, row)) = desk.available_review(editor) else {
            return;
        };
        let (generation, row) = (generation.to_owned(), row.clone());
        if let Some(editor) = &mut desk.editor {
            editor.apply_review(generation, row, keep_draft_groups, cx);
            if let Some(recovery) = &mut editor.recovery {
                recovery.reviewed = true;
            }
        }
        cx.notify();
    }

    fn save_catalog_service(&mut self, cx: &mut Context<Self>) {
        if matches!(&self.overlay, Overlay::ServiceCatalog(desk) if desk.editor.as_ref().is_some_and(|editor| editor.creation.is_some()))
        {
            self.queue_catalog_creation(cx);
            return;
        }
        let authorized = self.can_create_catalogue_item();
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return;
        };
        let Some(editor) = &desk.editor else {
            return;
        };
        if !authorized
            || desk.denied
            || desk.confirm_close
            || desk.changed(editor)
            || desk.pending_edit(&editor.base.id)
        {
            return;
        }
        let Some(input) = editor.form(cx).details(&editor.base.details) else {
            desk.notice = Some(Key::CatalogInvalid);
            cx.notify();
            return;
        };
        let replaces = editor
            .recovery
            .as_ref()
            .map(|recovery| recovery.mutation_id.as_str());
        match self.svc.store.queue_service_edit(
            &editor.generation,
            &editor.base,
            &input,
            &editor.assigned,
            editor.options_value(cx).as_ref(),
            replaces,
        ) {
            Ok(queued) => {
                desk.editor = None;
                desk.pending_edits = self.svc.store.pending_service_edits().unwrap_or_default();
                desk.notice = Some(if queued {
                    Key::CatalogQueued
                } else {
                    Key::CatalogSaved
                });
                self.edited(cx);
            }
            Err(CoreError::CatalogueVersionChanged | CoreError::CalendarGenerationChanged) => {
                desk.replica = self.svc.store.reviewed_catalogue().ok();
                desk.notice = Some(Key::CatalogChanged);
                cx.notify();
            }
            Err(CoreError::CatalogueEditPending) => {
                desk.notice = Some(Key::CatalogRevisionPending);
                cx.notify();
            }
            Err(_) => {
                desk.notice = Some(Key::CatalogInvalid);
                cx.notify();
            }
        }
    }

    pub(super) fn close_service_catalog(&mut self, cx: &mut Context<Self>) {
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return;
        };
        if desk.pending_preview.take().is_some() {
            cx.notify();
            return;
        }
        if desk.editor.as_ref().is_some_and(|editor| {
            editor.dirty(cx)
                || editor.recovery.is_some()
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
        let preview = desk
            .previewed_edit()
            .filter(|_| !desk.denied && self.can_create_catalogue_item());
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
                body.when(online && !desk.denied, |body| {
                    body.child(self.button(
                        "catalog-refresh",
                        self.t(Key::CatalogReload),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.request_service_catalog(cx)),
                    ))
                })
                .when_some(desk.editor.as_ref(), |body, editor| {
                    body.child(self.render_catalog_editor(desk, editor, cx))
                })
                .when_some(preview, |body, edit| {
                    body.child(self.render_pending_catalogue_edit(edit))
                })
                .when(desk.editor.is_none() && preview.is_none(), |body| {
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
        let services = desk.display_services();
        let empty = services.is_empty();
        let syncing_revisions = services.iter().any(|(_, editable)| !editable);
        let rows = services.into_iter().filter(|(row, _)| {
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
            .when(empty && !desk.busy && !desk.denied, |view| {
                view.child(div().text_sm().child(self.t(Key::CatalogNeedsSync)))
            })
            .when(syncing_revisions, |view| {
                view.child(div().text_sm().child(self.t(Key::CatalogRevisionsPending)))
            })
            .when(self.can_create_catalogue_item() && !desk.denied, |view| {
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
                    .children(rows.map(|(row, editable)| {
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
                        if desk.pending_edit(&id) {
                            let label = format!("{label} · {}", self.t(Key::CatalogPending));
                            if desk.denied || !self.can_create_catalogue_item() {
                                return div().text_sm().child(label).into_any_element();
                            }
                            return self
                                .button(
                                    SharedString::from(format!("catalog-pending-{id}")),
                                    label,
                                    Kind::Ghost,
                                    cx.listener(move |root, _, _, cx| {
                                        if root.can_create_catalogue_item()
                                            && let Overlay::ServiceCatalog(desk) = &mut root.overlay
                                            && !desk.denied
                                            && desk.pending_edit(&id)
                                        {
                                            desk.pending_preview = Some(id.clone());
                                        }
                                        cx.notify();
                                    }),
                                )
                                .into_any_element();
                        }
                        if !editable {
                            return div()
                                .text_sm()
                                .child(format!("{label} · {}", self.t(Key::CatalogRevisionPending)))
                                .into_any_element();
                        }
                        self.button(
                            SharedString::from(format!("catalog-{id}")),
                            label,
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| root.select_catalog_service(&id, cx)),
                        )
                        .into_any_element()
                    })),
            )
    }

    fn render_pending_catalogue_edit(&self, edit: &PendingServiceEdit) -> impl IntoElement {
        let proposed = edit.proposal().ok();
        let before = CatalogForm::from(&edit.reviewed);
        let option = edit.options_proposal().ok().flatten();
        div()
            .id("pending-catalogue-edit")
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div().font_weight(FontWeight::SEMIBOLD).child(
                    proposed
                        .as_ref()
                        .map_or(&edit.reviewed.name, |draft| &draft.name)
                        .clone(),
                ),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.t(Key::CatalogPending)),
            )
            .when_some(proposed.as_ref(), |body, draft| {
                let form = CatalogForm::from(draft);
                body.children(ServiceField::ALL.iter().filter_map(|field| {
                    let index = field.index();
                    let value = &form.fields[index];
                    (value != &before.fields[index])
                        .then(|| self.pending_catalogue_field(FIELDS[index], value.clone()))
                }))
                .when(draft.price_type != edit.reviewed.price_type, |body| {
                    body.child(self.t(price_label(draft.price_type)))
                })
                .when(
                    draft.online_booking != edit.reviewed.online_booking,
                    |body| body.child(self.t(visibility_label(draft.online_booking))),
                )
                .when(draft.active != edit.reviewed.active, |body| {
                    body.child(self.t(activity_label(draft.active)))
                })
            })
            .when_some(edit.assignment.as_ref(), |body, team| {
                body.child(
                    self.pending_catalogue_field(
                        Key::Staff,
                        team.staff_ids
                            .iter()
                            .map(|id| self.staff_name(id))
                            .collect::<Vec<_>>()
                            .join(", "),
                    ),
                )
            })
            .when_some(option, |body, option| {
                let key = match option {
                    ServiceOption::Variant { .. } => Key::CatalogOptionLabel,
                    ServiceOption::Addon { .. } => Key::CatalogEligible,
                };
                body.child(self.pending_catalogue_field(key, self.catalogue_options_value(&option)))
            })
    }

    fn pending_catalogue_field(&self, key: Key, value: String) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(
                div()
                    .text_sm()
                    .text_color(theme::muted())
                    .child(self.t(key)),
            )
            .child(if value.is_empty() {
                "—".into()
            } else {
                value
            })
    }

    fn edit_catalogue_line(&mut self, field: ServiceField, add: bool, cx: &mut Context<Self>) {
        let Overlay::ServiceCatalog(desk) = &mut self.overlay else {
            return;
        };
        let Some(editor) = &mut desk.editor else {
            return;
        };
        if desk.denied || desk.confirm_close || multiline(field).is_none() {
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
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let changed = desk.changed(editor);
        let current_service = desk.latest().filter(|_| changed).map(|(_, row)| row);
        let latest = current_service.map(|row| &row.details);
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
                    .when(editor.creation.is_none(), |body| {
                        body.child(self.render_catalog_team(desk, editor, current_service, cx))
                            .when_some(editor.options.as_ref(), |body, options| {
                                body.child(self.render_existing_options(
                                    editor,
                                    options,
                                    current_service,
                                    !desk.denied && self.can_create_catalogue_item(),
                                    cx,
                                ))
                            })
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
                        if desk.denied
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
                                            && !desk.denied
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
                                        && !desk.denied
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
                                            && !desk.denied
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
                editor.creation.is_none() && !desk.denied && self.can_create_catalogue_item(),
                |body| {
                    if changed {
                        return match desk.available_review(editor) {
                            Some((_, row)) => {
                                let latest = CatalogForm::from(&row.details);
                                let overlap = editor
                                    .form(cx)
                                    .has_overlapping_edits(&editor.baseline, &latest)
                                    || editor.options.as_ref().is_some_and(|options| {
                                        options.value(cx).label_overlaps(
                                            editor.base.catalog.as_ref(),
                                            row.catalog.as_ref(),
                                        )
                                    });
                                let label = if overlap {
                                    Key::CatalogKeepDraftGroups
                                } else {
                                    Key::CatalogReview
                                };
                                body.child(
                                    div()
                                        .flex()
                                        .flex_wrap()
                                        .gap_2()
                                        .child(self.button(
                                            "catalog-review",
                                            self.t(label),
                                            Kind::Ghost,
                                            cx.listener(|root, _, _, cx| {
                                                root.review_catalog_edit(true, cx)
                                            }),
                                        ))
                                        .when(overlap, |row| {
                                            row.child(self.button(
                                                "catalog-review-current-groups",
                                                self.t(Key::CatalogKeepCloudGroups),
                                                Kind::Ghost,
                                                cx.listener(|root, _, _, cx| {
                                                    root.review_catalog_edit(false, cx)
                                                }),
                                            ))
                                        }),
                                )
                            }
                            None => {
                                body.child(div().text_sm().child(self.t(Key::CatalogNeedsSync)))
                            }
                        };
                    }
                    body.when(
                        (editor.dirty(cx) || editor.recovery.is_some())
                            && !desk.pending_edit(&editor.base.id),
                        |body| {
                            body.child(self.button(
                                "catalog-save",
                                self.t(Key::SaveServiceAnnotations),
                                Kind::Primary,
                                cx.listener(|root, _, _, cx| root.save_catalog_service(cx)),
                            ))
                        },
                    )
                },
            )
    }

    fn render_catalog_team(
        &self,
        desk: &Desk,
        editor: &Editor,
        current: Option<&CatalogService>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut members: BTreeSet<_> = editor
            .assigned
            .union(&editor.base.staff_ids)
            .cloned()
            .collect();
        members.extend(
            self.report_staff_options
                .iter()
                .filter(|row| row.active)
                .map(|row| row.id.clone()),
        );
        let selectable = !desk.denied && self.can_create_catalogue_item();
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(div().text_sm().child(self.t(Key::Staff)))
            .when_some(
                current.filter(|row| row.staff_ids != editor.base.staff_ids),
                |body, row| {
                    let names = row
                        .staff_ids
                        .iter()
                        .map(|id| self.staff_name(id))
                        .collect::<Vec<_>>()
                        .join(", ");
                    let assigned = if names.is_empty() {
                        self.t(Key::AssignmentNoStaff)
                    } else {
                        &names
                    };
                    body.child(
                        div()
                            .text_sm()
                            .text_color(theme::muted())
                            .child(format!("{} {assigned}", self.t(Key::CatalogCurrent))),
                    )
                },
            )
            .when(members.is_empty(), |body| {
                body.child(div().text_sm().child(self.t(Key::AssignmentNoStaff)))
            })
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .children(members.into_iter().map(|id| {
                        let assigned = editor.assigned.contains(&id);
                        let active = self
                            .report_staff_options
                            .iter()
                            .any(|row| row.id == id && row.active);
                        let before = editor.base.staff_ids.contains(&id);
                        let label = format!(
                            "{} · {}",
                            self.staff_name(&id),
                            self.t(super::service_assignments::membership_label(
                                before, assigned
                            ))
                        );
                        if !selectable || !(active || assigned || before) {
                            return div().p_2().text_sm().child(label).into_any_element();
                        }
                        self.button(
                            SharedString::from(format!("configure-service-staff-{id}")),
                            label,
                            if assigned { Kind::Primary } else { Kind::Ghost },
                            cx.listener(move |root, _, _, cx| {
                                if let Overlay::ServiceCatalog(desk) = &mut root.overlay
                                    && !desk.denied
                                    && let Some(editor) = &mut desk.editor
                                    && !editor.assigned.remove(&id)
                                {
                                    editor.assigned.insert(id.clone());
                                }
                                cx.notify();
                            }),
                        )
                        .into_any_element()
                    })),
            )
    }
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
    async fn the_native_editor_queues_one_offline_change_for_price_and_team(
        cx: &mut TestAppContext,
    ) {
        let (_directory, window) = super::super::tests::open(cx);
        window.update(cx, |root, _, cx| {
            let id = "0198f5a0-7b1c-7000-8000-000000000201";
            let professional = "0198f5a0-7b1c-7000-8000-000000000202";
            root.svc.store.apply_page(&[RawChange {
                seq: 1000, entity: "service".into(), id: id.into(), op: "upsert".into(),
                data: Some(serde_json::json!({
                    "id": id, "version": 3, "name": "Reviewed offline treatment", "durationMinutes": 30,
                    "bufferMinutes": 0, "priceCents": 2000, "sortOrder": 1, "currency": "EUR",
                    "onlineBooking": true, "active": true, "updatedAt": "2026-03-01T10:00:00Z",
                })),
            }, RawChange {
                seq: 1001, entity: "staff".into(), id: professional.into(), op: "upsert".into(),
                data: Some(serde_json::json!({
                    "id": professional, "displayName": "Professional", "active": true,
                    "updatedAt": "2026-03-01T10:00:00Z",
                })),
            }], 1001).unwrap();
            root.status.connectivity = Connectivity::Offline;
            root.open_service_catalog(cx);
            root.select_catalog_service(id, cx);
            let Overlay::ServiceCatalog(desk) = &mut root.overlay else { panic!("Catalogue is closed") };
            desk.editor.as_mut().unwrap().fields[ServiceField::Price.index()][0].input.update(
                cx, |field, cx| field.set_text("27,50", cx)
            );
            desk.editor.as_mut().unwrap().assigned.insert(professional.into());
            root.save_catalog_service(cx);
            let pending = root.svc.store.pending_service_edits().unwrap();
            assert_eq!(pending.len(), 1);
            assert_eq!(pending[0].proposal().unwrap().price_cents, 2750);
            assert_eq!(pending[0].version, 3);
            assert_eq!(pending[0].assignment.as_ref().unwrap().staff_ids, [professional.into()].into());
            let confirmed = root.svc.store.reviewed_catalogue().unwrap();
            assert_eq!(confirmed.services[0].details.price_cents, 2000);
            assert!(confirmed.services[0].staff_ids.is_empty());
        }).unwrap();
    }

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
                let current = CatalogForm::from(&newer.details);
                let original_form = CatalogForm::from(&editor.base.details);
                let local_form = editor.form(cx);
                assert!(local_form.has_overlapping_edits(&original_form, &current));
                let cloud = local_form
                    .review(&original_form, current, false)
                    .details(&newer.details)
                    .unwrap();
                assert_eq!(cloud.price_type, CatalogPrice::Variable);
                assert_eq!(cloud.processing, None);
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
