mod view;

use super::*;
use sob_core::combinations::{
    CREATE, CombinationCatalogue, CombinationDraft, MAX_SERVICES, ManagedCombination,
    PendingCombination, QueuedCombination, UPDATE, online_service,
};

pub(super) struct Desk {
    catalogue: Option<CombinationCatalogue>,
    pending: Vec<QueuedCombination>,
    data_version: Option<i64>,
    editor: Option<Editor>,
    confirm_close: bool,
    notice: Option<Key>,
}

struct Editor {
    id: String,
    generation: String,
    version: Option<u64>,
    original: CombinationDraft,
    opened: CombinationDraft,
    pending_id: Option<String>,
    name: Entity<TextField>,
    description: Vec<Entity<TextField>>,
    search: Entity<TextField>,
    service_ids: Vec<String>,
    active: bool,
    conflict: Option<Recovery>,
}

struct Recovery {
    mutation_id: String,
    needs_review: bool,
    minimum_version: Option<u64>,
    restored: bool,
}

impl Desk {
    fn current(&self, id: &str) -> Option<&ManagedCombination> {
        self.catalogue
            .as_ref()?
            .combinations
            .iter()
            .find(|row| row.id == id)
    }

    fn at_limit(&self) -> bool {
        self.catalogue
            .as_ref()
            .is_some_and(|catalogue| catalogue.at_limit(&self.pending))
    }
}

impl Editor {
    fn draft(&self, cx: &App) -> CombinationDraft {
        let description = self
            .description
            .iter()
            .map(|field| field.read(cx).text())
            .collect::<Vec<_>>()
            .join("\n");
        CombinationDraft {
            name: self.name.read(cx).text().into(),
            description: Some(description),
            service_ids: self.service_ids.clone(),
            active: self.active,
        }
        .normalized()
    }

    fn dirty(&self, cx: &App) -> bool {
        self.draft(cx) != self.opened.clone().normalized()
    }

    fn current<'a>(&self, view: &'a CombinationCatalogue) -> Option<&'a ManagedCombination> {
        view.combinations.iter().find(|row| row.id == self.id)
    }

    fn needs_review(&self, view: Option<&CombinationCatalogue>) -> bool {
        self.conflict.as_ref().is_some_and(|row| row.needs_review)
            || view.is_none_or(|view| {
                self.generation != view.generation
                    || self.current(view).map(|row| row.version) != self.version
            })
    }

    fn can_review(&self, view: &CombinationCatalogue) -> bool {
        let current = self.current(view);
        let changed_history = self.generation != view.generation;
        (current.is_some() == self.version.is_some()
            || changed_history
            || self.conflict.as_ref().is_some_and(|row| row.restored))
            && (changed_history
                || self
                    .conflict
                    .as_ref()
                    .and_then(|row| row.minimum_version)
                    .is_none_or(|version| current.is_some_and(|row| row.version > version)))
    }

    fn populate(&mut self, draft: CombinationDraft, cx: &mut Context<Root>) {
        self.name
            .update(cx, |field, cx| field.set_text(&draft.name, cx));
        self.description = description_fields(draft.description.as_deref(), cx);
        self.service_ids = draft.service_ids;
        self.active = draft.active;
    }
}

fn text_field(label: &'static str, value: &str, cx: &mut Context<Root>) -> Entity<TextField> {
    let field = cx.new(|cx| {
        let mut field = TextField::new(label, false, cx);
        field.set_text(value, cx);
        field
    });
    cx.observe(&field, |_, _, cx| cx.notify()).detach();
    field
}

fn description_fields(text: Option<&str>, cx: &mut Context<Root>) -> Vec<Entity<TextField>> {
    text.unwrap_or_default()
        .split('\n')
        .map(|line| description_line(line, cx))
        .collect()
}

fn description_line(value: &str, cx: &mut Context<Root>) -> Entity<TextField> {
    let field = cx.new(|cx| {
        let mut field = TextField::new("", false, cx).with_line_paste(1000);
        field.set_text(value, cx);
        field
    });
    cx.subscribe(&field, |root, field, event, cx| {
        let Overlay::Combinations(desk) = &mut root.overlay else {
            return;
        };
        let Some(editor) = &mut desk.editor else {
            return;
        };
        let Some(index) = editor.description.iter().position(|line| *line == field) else {
            return;
        };
        match event {
            FieldEvent::PasteLines(lines) if editor.description.len() + lines.len() <= 1001 => {
                editor.description.splice(
                    index + 1..index + 1,
                    lines.iter().map(|line| description_line(line, cx)),
                );
            }
            FieldEvent::PasteLines(_) | FieldEvent::PasteTooLong => {
                desk.notice = Some(Key::CombinationInvalid);
            }
            FieldEvent::Changed => {}
            FieldEvent::Submit => return,
        }
        cx.notify();
    })
    .detach();
    field
}

fn new_draft() -> CombinationDraft {
    CombinationDraft {
        active: true,
        ..CombinationDraft::default()
    }
}

impl Root {
    pub(super) fn open_combinations(&mut self, conflict_id: Option<&str>, cx: &mut Context<Self>) {
        if !self.can_create_catalogue_item() {
            return;
        }
        let catalogue = self.svc.store.managed_combinations().ok().flatten();
        let pending = self.svc.store.pending_combinations().unwrap_or_default();
        let mut desk = Desk {
            catalogue,
            pending,
            data_version: self.data_version,
            editor: None,
            confirm_close: false,
            notice: None,
        };
        if let Some(id) = conflict_id {
            let Some(saved) = self.svc.store.conflict(id).ok().flatten() else {
                return;
            };
            if !matches!(saved.kind.as_str(), CREATE | UPDATE) {
                return;
            }
            let restored = saved.requires_restored_review();
            let Ok(edit) = serde_json::from_value::<PendingCombination>(saved.payload) else {
                return;
            };
            if desk.pending.iter().any(|row| row.edit.id == edit.id) {
                return;
            }
            desk.editor = Some(
                self.combination_editor(
                    &desk,
                    edit.id,
                    edit.proposed,
                    edit.reviewed.zip(edit.version),
                    Some(Recovery {
                        mutation_id: id.into(),
                        needs_review: true,
                        minimum_version: edit
                            .version
                            .filter(|_| saved.reason == "conflict" && !restored),
                        restored,
                    }),
                    cx,
                ),
            );
        }
        self.overlay = Overlay::Combinations(Box::new(desk));
        cx.notify();
    }

    fn combination_editor(
        &self,
        desk: &Desk,
        id: String,
        draft: CombinationDraft,
        baseline: Option<(CombinationDraft, u64)>,
        conflict: Option<Recovery>,
        cx: &mut Context<Self>,
    ) -> Editor {
        Editor {
            generation: desk
                .catalogue
                .as_ref()
                .map(|view| view.generation.clone())
                .unwrap_or_default(),
            version: baseline.as_ref().map(|(_, version)| *version),
            original: baseline.map(|(draft, _)| draft).unwrap_or_else(new_draft),
            opened: draft.clone(),
            pending_id: None,
            id,
            name: text_field(self.t(Key::CombinationName), &draft.name, cx),
            description: description_fields(draft.description.as_deref(), cx),
            search: text_field(self.t(Key::CombinationFind), "", cx),
            service_ids: draft.service_ids,
            active: draft.active,
            conflict,
        }
    }

    fn choose_combination(&mut self, id: Option<&str>, cx: &mut Context<Self>) {
        if !self.can_create_catalogue_item() {
            return;
        }
        let Overlay::Combinations(desk) = &self.overlay else {
            return;
        };
        if desk.catalogue.is_none() || (id.is_none() && desk.at_limit()) {
            return;
        }
        let (id, draft, baseline, pending_id) = match id {
            Some(id) => {
                let current = desk.current(id);
                let baseline = current.map(|row| (row.draft.clone(), row.version));
                let pending = desk.pending.iter().find(|pending| pending.edit.id == id);
                if let Some(pending) = pending {
                    if pending.submitted || pending.edit.version != current.map(|row| row.version) {
                        return;
                    }
                    (
                        id.into(),
                        pending.edit.proposed.clone(),
                        baseline,
                        Some(pending.mutation_id.clone()),
                    )
                } else {
                    let Some(row) = current else { return };
                    (id.into(), row.draft.clone(), baseline, None)
                }
            }
            None => (uuid::Uuid::now_v7().to_string(), new_draft(), None, None),
        };
        let mut editor = self.combination_editor(desk, id, draft, baseline, None, cx);
        editor.pending_id = pending_id;
        if let Overlay::Combinations(desk) = &mut self.overlay {
            desk.editor = Some(editor);
            desk.notice = None;
            cx.notify();
        }
    }

    pub(super) fn preserve_open_combinations(&mut self, generation: Option<&str>) -> bool {
        let Overlay::Combinations(desk) = &mut self.overlay else {
            return false;
        };
        desk.catalogue = None;
        desk.data_version = None;
        if let Some(editor) = &mut desk.editor
            && generation != Some(editor.generation.as_str())
            && let Some(recovery) = &mut editor.conflict
        {
            recovery.minimum_version = None;
            recovery.needs_review = true;
            recovery.restored = true;
        }
        true
    }

    pub(super) fn refresh_combinations(&mut self, cx: &mut Context<Self>) {
        let allowed = self.can_create_catalogue_item();
        let Overlay::Combinations(desk) = &mut self.overlay else {
            return;
        };
        if desk.data_version == self.data_version {
            return;
        }
        let (Ok(catalogue), Ok(pending)) = (
            self.svc.store.managed_combinations(),
            self.svc.store.pending_combinations(),
        ) else {
            return;
        };
        desk.data_version = self.data_version;
        desk.catalogue = if allowed { catalogue } else { None };
        desk.pending = pending;
        if let Some(editor) = &mut desk.editor
            && let Some(pending_id) = &editor.pending_id
            && desk.pending.iter().all(|row| row.edit.id != editor.id)
        {
            if let Ok(Some(conflict)) = self.svc.store.conflict(pending_id) {
                let restored = conflict.requires_restored_review();
                editor.conflict = Some(Recovery {
                    mutation_id: pending_id.clone(),
                    needs_review: true,
                    minimum_version: editor
                        .version
                        .filter(|_| conflict.reason == "conflict" && !restored),
                    restored,
                });
            } else if desk
                .catalogue
                .as_ref()
                .and_then(|view| editor.current(view))
                .is_some()
            {
                editor.original = editor.opened.clone();
            }
            editor.pending_id = None;
        }
        if let Some(view) = &desk.catalogue
            && let Some(editor) = &mut desk.editor
            && editor.conflict.is_none()
            && editor.pending_id.is_none()
            && !editor.dirty(cx)
            && editor.needs_review(Some(view))
            && editor.can_review(view)
        {
            if let Some(row) = editor.current(view) {
                editor.original = row.draft.clone();
                editor.opened = row.draft.clone();
                editor.version = Some(row.version);
                editor.populate(row.draft.clone(), cx);
            } else if editor.version.is_some() {
                desk.editor = None;
                desk.notice = Some(Key::CombinationMissing);
                cx.notify();
                return;
            }
            editor.generation.clone_from(&view.generation);
        }
        cx.notify();
    }

    fn review_combination(&mut self, keep: bool, cx: &mut Context<Self>) {
        self.edit_combination(cx, |desk, cx| {
            let (Some(editor), Some(view)) = (&mut desk.editor, &desk.catalogue) else {
                return;
            };
            if !editor.can_review(view) {
                return;
            }
            let current = editor.current(view);
            let draft = editor.draft(cx);
            let reviewed = current.map_or(draft.clone(), |row| {
                draft.rebase(&editor.original, &row.draft, keep)
            });
            editor.original = current
                .map(|row| row.draft.clone())
                .unwrap_or_else(new_draft);
            editor.version = current.map(|row| row.version);
            editor.generation.clone_from(&view.generation);
            editor.populate(reviewed, cx);
            if let Some(recovery) = &mut editor.conflict {
                recovery.needs_review = false;
            }
            desk.notice = None;
        });
    }

    fn save_combination(&mut self, cx: &mut Context<Self>) {
        if !self.can_create_catalogue_item() {
            return;
        }
        let Overlay::Combinations(desk) = &mut self.overlay else {
            return;
        };
        let Some(editor) = &desk.editor else { return };
        if editor.needs_review(desk.catalogue.as_ref()) || desk.confirm_close {
            return;
        }
        let replaces = editor.conflict.as_ref().map(|row| row.mutation_id.as_str());
        use sob_core::error::CoreError;
        match self.svc.store.queue_combination(
            &editor.generation,
            &editor.id,
            editor.version,
            editor.draft(cx),
            editor.pending_id.as_deref(),
            replaces,
        ) {
            Ok(queued) => {
                desk.pending = self.svc.store.pending_combinations().unwrap_or_default();
                desk.editor = None;
                desk.notice = Some(if queued {
                    Key::CatalogPending
                } else {
                    Key::CombinationSaved
                });
                if self.status.connectivity == Connectivity::Offline {
                    self.reload(cx);
                } else {
                    self.edited(cx);
                }
            }
            Err(CoreError::CatalogueVersionChanged | CoreError::CalendarGenerationChanged) => {
                desk.catalogue = self.svc.store.managed_combinations().ok().flatten();
                desk.notice = Some(Key::CombinationChanged);
            }
            Err(CoreError::IncompatibleServices) => {
                desk.notice = Some(Key::ErrIncompatibleServices)
            }
            Err(CoreError::CatalogueEditPending) => desk.notice = Some(Key::CatalogPending),
            Err(_) => desk.notice = Some(Key::CombinationInvalid),
        }
        cx.notify();
    }

    fn edit_combination(
        &mut self,
        cx: &mut Context<Self>,
        edit: impl FnOnce(&mut Desk, &mut Context<Self>),
    ) {
        if self.can_create_catalogue_item()
            && let Overlay::Combinations(desk) = &mut self.overlay
            && !desk.confirm_close
        {
            edit(desk, cx);
            cx.notify();
        }
    }

    pub(super) fn close_combinations(&mut self, cx: &mut Context<Self>) {
        let Overlay::Combinations(desk) = &mut self.overlay else {
            return;
        };
        if desk.confirm_close {
            desk.confirm_close = false;
        } else if desk.editor.as_ref().is_some_and(|editor| editor.dirty(cx)) {
            desk.confirm_close = true;
        } else if desk.editor.is_some() {
            desk.editor = None;
        } else {
            self.open_web_management(cx);
        }
        cx.notify();
    }

    fn move_combination_service(&mut self, from: usize, to: usize, cx: &mut Context<Self>) {
        self.edit_combination(cx, |desk, _| {
            if let Some(editor) = &mut desk.editor
                && from.max(to) < editor.service_ids.len()
            {
                editor.service_ids.swap(from, to);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn a_native_combination_keeps_the_reviewed_order_in_the_outbox(cx: &mut TestAppContext) {
        let (_directory, window) = super::super::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                let generation = root.svc.store.verified_reviewed_generation().unwrap();
                let first = "0198f5a0-7b1c-7000-8000-000000000211";
                let second = "0198f5a0-7b1c-7000-8000-000000000212";
                let mut changes: Vec<_> = [first, second].into_iter().zip(1000..).map(|(id, seq)| RawChange {
                    seq,
                    entity: "service".into(),
                    id: id.into(),
                    op: "upsert".into(),
                    data: Some(serde_json::json!({
                        "id":id, "name":"Sample", "durationMinutes":30, "bufferMinutes":0,
                        "priceCents":1000, "currency":"EUR", "active":true, "updatedAt":"2026-03-01T10:00:00Z"
                    })),
                }).collect();
                let staff = root.svc.store.staff().unwrap().remove(0).id;
                changes.extend([first, second].into_iter().zip(1002..).map(|(service_id, seq)| {
                    let id = uuid::Uuid::now_v7().to_string();
                    RawChange {
                        seq, entity: "service_staff".into(), id: id.clone(), op: "upsert".into(),
                        data: Some(serde_json::json!({"id":id, "serviceId":service_id, "staffId":staff})),
                    }
                }));
                root.svc.store.apply_page(&changes, 1003).unwrap();
                root.svc.store.set_meta(
                    "service_combinations",
                    &serde_json::json!({"generation": generation, "combinations": []}).to_string(),
                ).unwrap();
                root.status.connectivity = Connectivity::Offline;
                root.open_combinations(None, cx);
                root.choose_combination(None, cx);
                root.edit_combination(cx, |desk, cx| {
                    let editor = desk.editor.as_mut().unwrap();
                    editor.name.update(cx, |name, cx| name.set_text("New combination", cx));
                    editor.description = description_fields(Some("First line\n\nThird line"), cx);
                    editor.service_ids = vec![first.into(), second.into()];
                });
                root.move_combination_service(0, 1, cx);
                root.close_combinations(cx);
                assert!(matches!(&root.overlay, Overlay::Combinations(desk) if desk.confirm_close));
                root.close_combinations(cx);
                root.save_combination(cx);
                let entries = root.svc.store.pending_combinations().unwrap();
                assert_eq!(entries.len(), 1);
                assert_eq!(entries[0].edit.proposed.service_ids, [second, first]);
                assert_eq!(entries[0].edit.proposed.description.as_deref(), Some("First line\n\nThird line"));
                root.choose_combination(Some(&entries[0].edit.id), cx);
                root.move_combination_service(1, 0, cx);
                root.save_combination(cx);
                let revised = root.svc.store.pending_combinations().unwrap();
                assert_eq!(revised.len(), 1);
                assert_ne!(revised[0].mutation_id, entries[0].mutation_id);
                assert_eq!(revised[0].edit.proposed.service_ids, [first, second]);
                assert!(root.svc.store.managed_combinations().unwrap().unwrap().combinations.is_empty());
            })
            .unwrap();
    }
}
