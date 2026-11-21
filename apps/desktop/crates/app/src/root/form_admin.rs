use super::intake_live::LiveRefresh;
use super::*;
use sob_core::intake::{
    AdminForm, AdminFormSummary, Choice, FORM_LIVE_TOPIC, FormDefinition, FormKind, FormWrite,
    FormWriteError, Question, QuestionKind,
};
use sob_core::sync::TransportError;
use std::{cell::Cell, rc::Rc};

mod view;

type Input = Entity<TextField>;

pub(super) struct Desk {
    forms: Vec<AdminFormSummary>,
    editor: Option<Editor>,
    request: Option<Arc<()>>,
    background_refresh: bool,
    live_read_failed: bool,
    live: LiveRefresh,
    retry: Option<FormWrite>,
    confirm: Option<Confirm>,
    error: Option<Key>,
    notice: Option<Key>,
    denied: bool,
    loaded: bool,
}

enum FormRead {
    Directory,
    LiveDirectory,
    Detail(String),
}

enum FormData {
    Directory(Vec<AdminFormSummary>),
    Detail(Box<AdminForm>),
}

struct Editor {
    base: Option<AdminForm>,
    key: String,
    title: Input,
    description: Lines,
    fields: Vec<Field>,
    kind: FormKind,
    required: bool,
    team: bool,
    all_services: bool,
    services: Vec<String>,
    search: Input,
}

struct Lines {
    fields: Vec<Input>,
    budget: Rc<Cell<usize>>,
    limit: usize,
}

impl Lines {
    fn new(value: &str, limit: usize, cx: &mut Context<Root>) -> Self {
        let mut lines = Self {
            fields: Vec::new(),
            budget: Rc::new(Cell::new(limit)),
            limit,
        };
        for text in value.split('\n') {
            let field = lines.field(text, cx);
            lines.fields.push(field);
        }
        lines.reset_budget();
        lines
    }

    fn reset_budget(&self) {
        self.budget.set(
            self.limit
                .saturating_add(1)
                .saturating_sub(self.fields.len()),
        );
    }

    fn field(&self, value: &str, cx: &mut Context<Root>) -> Input {
        let field = cx.new(|cx| {
            let mut field = TextField::new("", false, cx)
                .with_bounded_line_paste(self.limit, self.budget.clone());
            field.set_text(value, cx);
            field
        });
        cx.observe(&field, |_, _, cx| cx.notify()).detach();
        cx.subscribe(&field, |root, input, event, cx| {
            if let Overlay::IntakeForms(desk) = &mut root.overlay
                && !desk.blocking_request()
                && desk.retry.is_none()
                && desk.confirm.is_none()
                && let Some(editor) = &mut desk.editor
            {
                match event {
                    FieldEvent::PasteLines(tail) => editor.insert_pasted_lines(&input, tail, cx),
                    FieldEvent::PasteTooLong => desk.error = Some(Key::FormPasteTooLong),
                    _ => return,
                }
                cx.notify();
            }
        })
        .detach();
        field
    }

    fn value(&self, cx: &App) -> String {
        self.fields
            .iter()
            .map(|line| value(line, cx))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

struct Field {
    id: String,
    label: Input,
    help: Lines,
    required: bool,
    options: Vec<(String, Input)>,
    lower: Input,
    upper: Input,
    kind: FieldKind,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FieldKind {
    Text,
    Textarea,
    Date,
    Boolean,
    Consent,
    Number,
    Single,
    Multiple,
}

const KINDS: [FieldKind; 8] = [
    FieldKind::Text,
    FieldKind::Textarea,
    FieldKind::Date,
    FieldKind::Boolean,
    FieldKind::Consent,
    FieldKind::Number,
    FieldKind::Single,
    FieldKind::Multiple,
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Confirm {
    Publish,
    Archive,
    Close,
    Reload,
}

#[derive(Clone)]
enum Edit {
    Required,
    Team,
    Waiver,
    AllServices,
    Service(String),
    AddField,
    RemoveField(usize),
    MoveField(usize, usize),
    Kind(usize, FieldKind),
    FieldRequired(usize),
    AddChoice(usize),
    RemoveChoice(usize, usize),
    MoveChoice(usize, usize, usize),
    AddLine(Option<usize>),
    RemoveLine(Option<usize>, usize),
}

fn id() -> String {
    uuid::Uuid::now_v7().to_string()
}

fn input(value: &str, cx: &mut Context<Root>) -> Input {
    let field = cx.new(|cx| {
        let mut field = TextField::new("", false, cx);
        field.set_text(value, cx);
        field
    });
    cx.observe(&field, |_, _, cx| cx.notify()).detach();
    field
}

fn value<'a>(input: &'a Input, cx: &'a App) -> &'a str {
    input.read(cx).text()
}

impl From<&QuestionKind> for FieldKind {
    fn from(kind: &QuestionKind) -> Self {
        match kind {
            QuestionKind::Text { .. } => Self::Text,
            QuestionKind::Textarea { .. } => Self::Textarea,
            QuestionKind::Date => Self::Date,
            QuestionKind::Boolean => Self::Boolean,
            QuestionKind::Consent => Self::Consent,
            QuestionKind::Number { .. } => Self::Number,
            QuestionKind::SingleChoice { .. } => Self::Single,
            QuestionKind::MultipleChoice { .. } => Self::Multiple,
        }
    }
}

impl FieldKind {
    fn label(self) -> Key {
        match self {
            Self::Text => Key::FormShortText,
            Self::Textarea => Key::FormLongText,
            Self::Date => Key::FormDate,
            Self::Boolean => Key::FormBoolean,
            Self::Consent => Key::FormConsent,
            Self::Number => Key::FormNumber,
            Self::Single => Key::FormSingle,
            Self::Multiple => Key::FormMultiple,
        }
    }

    fn has_choices(self) -> bool {
        matches!(self, Self::Single | Self::Multiple)
    }
}

impl Field {
    fn new(question: Question, cx: &mut Context<Root>) -> Self {
        let mut lower = String::new();
        let mut upper = String::new();
        let mut options = Vec::new();
        let kind = FieldKind::from(&question.kind);
        match question.kind {
            QuestionKind::Text { max_length } | QuestionKind::Textarea { max_length } => {
                lower = max_length.to_string();
            }
            QuestionKind::Number { minimum, maximum } => {
                lower = minimum.map(|n| n.to_string()).unwrap_or_default();
                upper = maximum.map(|n| n.to_string()).unwrap_or_default();
            }
            QuestionKind::SingleChoice { options: choices }
            | QuestionKind::MultipleChoice { options: choices } => {
                options = choices;
            }
            _ => (),
        }
        Self {
            id: question.id,
            label: input(&question.label, cx),
            help: Lines::new(&question.help, 500, cx),
            required: question.required,
            options: options
                .into_iter()
                .map(|choice| (choice.id, input(&choice.label, cx)))
                .collect(),
            lower: input(&lower, cx),
            upper: input(&upper, cx),
            kind,
        }
    }

    fn blank(cx: &mut Context<Root>) -> Self {
        Self::new(
            Question {
                id: id(),
                label: String::new(),
                help: String::new(),
                required: false,
                kind: QuestionKind::Text { max_length: 200 },
            },
            cx,
        )
    }

    fn set_kind(&mut self, kind: FieldKind, cx: &mut Context<Root>) {
        if self.kind == kind {
            return;
        }
        if !(self.kind.has_choices() && kind.has_choices()) {
            self.options.clear();
            if kind.has_choices() {
                self.options.push((id(), input("", cx)));
            }
        }
        self.lower.update(cx, |field, cx| {
            field.set_text(
                match kind {
                    FieldKind::Text => "200",
                    FieldKind::Textarea => "2000",
                    _ => "",
                },
                cx,
            )
        });
        self.upper.update(cx, |field, cx| field.clear(cx));
        self.kind = kind;
    }

    fn definition(&self, cx: &App, trim: bool) -> Result<Question, Key> {
        let clean = |s: &str| {
            if trim {
                s.trim().to_owned()
            } else {
                s.to_owned()
            }
        };
        let label = clean(value(&self.label, cx));
        let help = self.help.value(cx);
        if trim && (!valid_label(&label, 200) || !valid_text(&help, 500)) {
            return Err(Key::FormInvalidQuestion);
        }
        let bound = |field: &Input| {
            let raw = value(field, cx).trim();
            if raw.is_empty() {
                return Ok(None);
            }
            let n: f64 = raw
                .replace(',', ".")
                .parse()
                .map_err(|_| Key::FormInvalidBounds)?;
            n.is_finite()
                .then_some(Some(n))
                .ok_or(Key::FormInvalidBounds)
        };
        let length = || {
            value(&self.lower, cx)
                .trim()
                .parse::<usize>()
                .ok()
                .filter(|length| (1..=4000).contains(length))
                .ok_or(Key::FormInvalidBounds)
        };
        let kind = match self.kind {
            FieldKind::Text => QuestionKind::Text {
                max_length: length()?,
            },
            FieldKind::Textarea => QuestionKind::Textarea {
                max_length: length()?,
            },
            FieldKind::Date => QuestionKind::Date,
            FieldKind::Boolean => QuestionKind::Boolean,
            FieldKind::Consent => QuestionKind::Consent,
            FieldKind::Number => {
                let minimum = bound(&self.lower)?;
                let maximum = bound(&self.upper)?;
                if minimum.zip(maximum).is_some_and(|(min, max)| min > max) {
                    return Err(Key::FormInvalidBounds);
                }
                QuestionKind::Number { minimum, maximum }
            }
            FieldKind::Single | FieldKind::Multiple => {
                let options: Vec<_> = self
                    .options
                    .iter()
                    .map(|(id, field)| Choice {
                        id: id.clone(),
                        label: clean(value(field, cx)),
                    })
                    .collect();
                if trim
                    && (options.is_empty()
                        || options
                            .iter()
                            .any(|choice| !valid_label(&choice.label, 120)))
                {
                    return Err(Key::FormInvalidChoice);
                }
                if self.kind == FieldKind::Single {
                    QuestionKind::SingleChoice { options }
                } else {
                    QuestionKind::MultipleChoice { options }
                }
            }
        };
        Ok(Question {
            id: self.id.clone(),
            label,
            help,
            required: self.required,
            kind,
        })
    }
}

fn valid_label(value: &str, max: usize) -> bool {
    !value.is_empty() && !value.chars().any(char::is_control) && valid_text(value, max)
}

fn valid_text(value: &str, max: usize) -> bool {
    !value.contains('\0') && value.encode_utf16().count() <= max
}

impl Editor {
    fn new(base: Option<AdminForm>, cx: &mut Context<Root>) -> Self {
        let draft = base.as_ref().map(|form| &form.draft);
        let fields = if let Some(draft) = draft {
            draft
                .fields
                .iter()
                .cloned()
                .map(|field| Field::new(field, cx))
                .collect()
        } else {
            vec![Field::blank(cx)]
        };
        Self {
            key: id(),
            title: input(draft.map_or("", |d| &d.title), cx),
            description: Lines::new(draft.map_or("", |d| &d.description), 12000, cx),
            fields,
            kind: draft.map_or(FormKind::Intake, |d| d.kind),
            required: draft.is_some_and(|d| d.required_at_booking),
            team: draft.is_some_and(|d| d.allow_team_responses),
            all_services: draft.is_none_or(|d| d.all_services),
            services: draft.map(|d| d.service_ids.clone()).unwrap_or_default(),
            search: input("", cx),
            base,
        }
    }

    fn definition(&self, cx: &App, validate: bool) -> Result<FormDefinition, Key> {
        let title = value(&self.title, cx);
        let title = if validate { title.trim() } else { title }.to_owned();
        let description = self.description.value(cx);
        if validate && (!valid_label(&title, 120) || !valid_text(&description, 12000)) {
            return Err(Key::FormInvalidTitle);
        }
        if validate && !self.all_services && self.services.is_empty() {
            return Err(Key::FormSelectService);
        }
        let fields = self
            .fields
            .iter()
            .map(|field| field.definition(cx, validate))
            .collect::<Result<Vec<_>, _>>()?;
        if validate
            && self.kind == FormKind::Waiver
            && !fields
                .iter()
                .any(|field| field.required && matches!(field.kind, QuestionKind::Consent))
        {
            return Err(Key::FormWaiverRequiresConsent);
        }
        Ok(FormDefinition {
            kind: self.kind,
            title,
            description,
            fields,
            required_at_booking: self.required,
            allow_team_responses: self.team,
            all_services: self.all_services,
            service_ids: if self.all_services {
                Vec::new()
            } else {
                self.services.clone()
            },
        })
    }

    fn dirty(&self, cx: &App) -> bool {
        let Some(base) = &self.base else {
            return true;
        };
        !self
            .definition(cx, false)
            .is_ok_and(|current| current == base.draft)
    }

    fn edit(&mut self, action: Edit, cx: &mut Context<Root>) {
        match action {
            Edit::Required => self.required = !self.required,
            Edit::Team => self.team = !self.team,
            Edit::Waiver => {
                self.kind = if self.kind == FormKind::Waiver {
                    FormKind::Intake
                } else {
                    FormKind::Waiver
                };
            }
            Edit::AllServices => self.all_services = !self.all_services,
            Edit::Service(id) => {
                if let Some(index) = self.services.iter().position(|entry| *entry == id) {
                    self.services.remove(index);
                } else if self.services.len() < 100 {
                    self.services.push(id);
                }
            }
            Edit::AddField if self.fields.len() < 30 => self.fields.push(Field::blank(cx)),
            Edit::AddField => (),
            Edit::RemoveField(index) => {
                self.fields.remove(index);
            }
            Edit::MoveField(a, b) => self.fields.swap(a, b),
            Edit::Kind(index, kind) => self.fields[index].set_kind(kind, cx),
            Edit::FieldRequired(index) => {
                self.fields[index].required = !self.fields[index].required
            }
            Edit::AddChoice(index) if self.fields[index].options.len() < 30 => {
                self.fields[index].options.push((id(), input("", cx)));
            }
            Edit::AddChoice(_) => (),
            Edit::RemoveChoice(field, choice) => {
                self.fields[field].options.remove(choice);
            }
            Edit::MoveChoice(field, a, b) => self.fields[field].options.swap(a, b),
            Edit::AddLine(field) => {
                let lines = self.lines(field);
                if lines.budget.get() > 0 {
                    let field = lines.field("", cx);
                    lines.fields.push(field);
                    lines.reset_budget();
                }
            }
            Edit::RemoveLine(field, line) => {
                let lines = self.lines(field);
                lines.fields.remove(line);
                lines.reset_budget();
            }
        }
    }

    fn insert_pasted_lines(&mut self, source: &Input, tail: &[String], cx: &mut Context<Root>) {
        let groups = std::iter::once(&mut self.description)
            .chain(self.fields.iter_mut().map(|field| &mut field.help));
        for lines in groups {
            if let Some(index) = lines.fields.iter().position(|line| line == source) {
                let fields: Vec<_> = tail.iter().map(|text| lines.field(text, cx)).collect();
                lines.fields.splice(index + 1..index + 1, fields);
                lines.reset_budget();
                break;
            }
        }
    }

    fn lines(&mut self, field: Option<usize>) -> &mut Lines {
        match field {
            Some(index) => &mut self.fields[index].help,
            None => &mut self.description,
        }
    }
}

fn denied(error: &TransportError) -> bool {
    matches!(
        error,
        TransportError::Unauthorized | TransportError::Forbidden(_)
    )
}

impl Root {
    pub(super) fn open_intake_forms(&mut self, cx: &mut Context<Self>) {
        self.overlay = Overlay::IntakeForms(Box::new(Desk {
            forms: Vec::new(),
            editor: None,
            request: None,
            background_refresh: false,
            live_read_failed: false,
            live: LiveRefresh::default(),
            retry: None,
            confirm: None,
            error: None,
            notice: None,
            denied: false,
            loaded: false,
        }));
        self.load_intake_forms(cx);
    }

    pub(super) fn close_intake_forms(&mut self, cx: &mut Context<Self>) {
        let Overlay::IntakeForms(desk) = &mut self.overlay else {
            return;
        };
        if desk.blocking_request() {
            return;
        }
        desk.cancel_background_refresh();
        if desk.confirm.take().is_some() {
            cx.notify();
            return;
        }
        if desk.retry.is_some() || desk.editor.as_ref().is_some_and(|editor| editor.dirty(cx)) {
            desk.confirm = Some(Confirm::Close);
        } else if desk.editor.take().is_none() {
            self.overlay = Overlay::None;
        }
        cx.notify();
    }

    fn load_intake_forms(&mut self, cx: &mut Context<Self>) {
        self.read_intake_forms(FormRead::Directory, cx);
    }

    pub(super) fn refresh_live_intake_forms(&mut self, reconnected: bool, cx: &mut Context<Self>) {
        if !matches!(self.overlay, Overlay::IntakeForms(_)) {
            return;
        }
        let Ok(revision) = self.svc.store.live_view_revision(FORM_LIVE_TOPIC) else {
            return;
        };
        let Overlay::IntakeForms(desk) = &mut self.overlay else {
            return;
        };
        if reconnected {
            desk.live = LiveRefresh::default();
        }
        if desk.request.is_none() && desk.live.needs_refresh(revision, Instant::now()) {
            self.read_intake_forms(FormRead::LiveDirectory, cx);
        }
    }

    fn read_intake_forms(&mut self, read: FormRead, cx: &mut Context<Self>) {
        let revision = self.svc.store.live_view_revision(FORM_LIVE_TOPIC).ok();
        let Overlay::IntakeForms(desk) = &mut self.overlay else {
            return;
        };
        if desk.blocking_request() {
            return;
        }
        desk.cancel_background_refresh();
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            desk.error = Some(Key::FormOffline);
            cx.notify();
            return;
        };
        let request = Arc::new(());
        desk.request = Some(request.clone());
        let background = matches!(read, FormRead::LiveDirectory) && desk.loaded;
        desk.background_refresh = background;
        let refreshing_directory = matches!(read, FormRead::Directory | FormRead::LiveDirectory);
        if !desk.background_refresh {
            desk.confirm = None;
            desk.error = None;
            desk.notice = None;
        }
        let session = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |view, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match read {
                        FormRead::Directory | FormRead::LiveDirectory => {
                            transport.intake_forms().map(FormData::Directory)
                        }
                        FormRead::Detail(id) => transport
                            .intake_form(&id)
                            .map(Box::new)
                            .map(FormData::Detail),
                    }
                })
                .await;
            let _ = view.update(cx, |root, cx| {
                let Some(desk) = root.active_form_request(&session, &request) else {
                    return;
                };
                if refreshing_directory {
                    match &result {
                        Err(TransportError::RateLimited(after)) => {
                            desk.live.defer(Instant::now(), *after)
                        }
                        Err(TransportError::Offline(_) | TransportError::Server(_)) => {
                            desk.live.defer(Instant::now(), None)
                        }
                        _ => desk.live.acknowledge(revision),
                    }
                }
                match result {
                    Ok(FormData::Directory(forms)) => {
                        desk.loaded = true;
                        desk.live_read_failed = false;
                        desk.forms = forms;
                        desk.denied = false;
                    }
                    Ok(FormData::Detail(form)) => {
                        if let Some(summary) =
                            desk.forms.iter_mut().find(|summary| summary.id == form.id)
                        {
                            *summary = AdminFormSummary::from(form.as_ref());
                        }
                        desk.editor = Some(Editor::new(Some(*form), cx));
                    }
                    Err(error) if background && !denied(&error) => desk.live_read_failed = true,
                    Err(error) => desk.read_error(error),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn save_intake_form(&mut self, cx: &mut Context<Self>) {
        let Overlay::IntakeForms(desk) = &mut self.overlay else {
            return;
        };
        let Some(editor) = &desk.editor else {
            return;
        };
        let definition = match editor.definition(cx, true) {
            Ok(definition) => definition,
            Err(error) => {
                desk.error = Some(error);
                cx.notify();
                return;
            }
        };
        let action = if let Some(base) = &editor.base {
            FormWrite::Save {
                id: base.id.clone(),
                version: base.version,
                definition,
            }
        } else {
            FormWrite::Create {
                key: editor.key.clone(),
                definition,
            }
        };
        self.write_intake_form(action, cx);
    }

    fn confirm_intake_action(&mut self, cx: &mut Context<Self>) {
        let Overlay::IntakeForms(desk) = &mut self.overlay else {
            return;
        };
        if desk.blocking_request() {
            return;
        }
        desk.cancel_background_refresh();
        let Some(confirm) = desk.confirm.take() else {
            return;
        };
        match confirm {
            Confirm::Close => {
                desk.retry = None;
                desk.error = None;
                desk.notice = None;
                desk.editor = None;
                self.load_intake_forms(cx);
            }
            Confirm::Reload => {
                if let Some(base) = desk.editor.as_ref().and_then(|editor| editor.base.as_ref()) {
                    let id = base.id.clone();
                    self.read_intake_forms(FormRead::Detail(id), cx);
                }
            }
            Confirm::Publish | Confirm::Archive => {
                if desk.newer_version() {
                    cx.notify();
                    return;
                }
                let Some(editor) = &desk.editor else {
                    return;
                };
                let Some(base) = &editor.base else {
                    return;
                };
                let action = if confirm == Confirm::Publish {
                    if editor.dirty(cx) || !base.can_publish() {
                        return;
                    }
                    FormWrite::Publish {
                        id: base.id.clone(),
                        version: base.version,
                    }
                } else {
                    FormWrite::Archive {
                        id: base.id.clone(),
                        version: base.version,
                    }
                };
                self.write_intake_form(action, cx);
            }
        }
        cx.notify();
    }

    fn active_form_request(
        &mut self,
        session: &sob_core::auth::SessionHandle,
        request: &Arc<()>,
    ) -> Option<&mut Desk> {
        if !Arc::ptr_eq(session, &self.svc.session) {
            return None;
        }
        let Overlay::IntakeForms(desk) = &mut self.overlay else {
            return None;
        };
        if !desk
            .request
            .as_ref()
            .is_some_and(|pending| Arc::ptr_eq(pending, request))
        {
            return None;
        }
        desk.request = None;
        desk.background_refresh = false;
        Some(desk)
    }

    fn write_intake_form(&mut self, action: FormWrite, cx: &mut Context<Self>) {
        let Overlay::IntakeForms(desk) = &mut self.overlay else {
            return;
        };
        if desk.blocking_request() || desk.denied || (desk.retry.is_none() && desk.newer_version())
        {
            return;
        }
        desk.cancel_background_refresh();
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            desk.error = Some(Key::FormOffline);
            cx.notify();
            return;
        };
        let retry_base = desk
            .retry
            .as_ref()
            .and(desk.editor.as_ref())
            .and_then(|editor| editor.base.clone());
        let request = Arc::new(());
        desk.request = Some(request.clone());
        desk.error = None;
        desk.notice = None;
        let session = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |view, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let result = transport.write_intake_form(&action, retry_base.as_ref());
                    (action, result)
                })
                .await;
            let _ = view.update(cx, |root, cx| {
                let Some(desk) = root.active_form_request(&session, &request) else {
                    return;
                };
                let (action, reply) = result;
                let retrying = desk.retry.take().is_some();
                match reply {
                    Ok(form) => {
                        desk.forms.retain(|item| item.id != form.id);
                        desk.forms.insert(0, AdminFormSummary::from(&form));
                        desk.editor = Some(Editor::new(Some(form), cx));
                        desk.notice = Some(match action {
                            FormWrite::Publish { .. } => Key::FormPublished,
                            FormWrite::Archive { .. } => Key::FormArchived,
                            _ => Key::FormSaved,
                        });
                    }
                    Err(FormWriteError::Conflict) => desk.error = Some(Key::FormConflict),
                    Err(FormWriteError::Capacity) => desk.error = Some(Key::FormCapacity),
                    Err(FormWriteError::Invalid) => desk.error = Some(Key::FormRejected),
                    Err(FormWriteError::Transport(error)) if denied(&error) => {
                        desk.read_error(error)
                    }
                    Err(FormWriteError::Transport(TransportError::RateLimited(_))) => {
                        if retrying {
                            desk.retry = Some(action);
                        }
                        desk.error = Some(Key::FormRateLimited);
                    }
                    Err(FormWriteError::Transport(TransportError::BadRequest(_))) => {
                        desk.error = Some(Key::FormRejected);
                    }
                    Err(FormWriteError::Transport(_)) => {
                        desk.retry = Some(action);
                        desk.error = Some(Key::FormUnconfirmed);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn form_edit(&mut self, action: Edit, cx: &mut Context<Self>) {
        if let Overlay::IntakeForms(desk) = &mut self.overlay
            && !desk.blocking_request()
            && desk.retry.is_none()
            && desk.confirm.is_none()
            && let Some(editor) = &mut desk.editor
        {
            editor.edit(action, cx);
            desk.notice = None;
            cx.notify();
        }
    }
}

impl Desk {
    fn blocking_request(&self) -> bool {
        self.request.is_some() && !self.background_refresh
    }

    fn cancel_background_refresh(&mut self) {
        if std::mem::take(&mut self.background_refresh) {
            self.request = None;
        }
    }

    fn newer_version(&self) -> bool {
        self.editor
            .as_ref()
            .and_then(|editor| editor.base.as_ref())
            .is_some_and(|base| {
                self.forms.iter().any(|summary| {
                    summary.id == base.id
                        && summary
                            .version
                            .is_some_and(|version| version > base.version)
                })
            })
    }

    fn read_error(&mut self, error: TransportError) {
        if denied(&error) {
            self.denied = true;
            self.forms.clear();
            self.editor = None;
            self.retry = None;
            self.error = Some(Key::FormDenied);
        } else {
            self.error = Some(Key::FormLoadError);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn form_review_and_discard_keep_saved_wording_and_fit_the_window(
        cx: &mut TestAppContext,
    ) {
        let (_dir, config) = crate::root::tests::desk();
        let (root, cx) = cx.add_window_view(|window, cx| Root::new(config, window, cx));
        cx.simulate_resize(gpui::size(px(560.), px(470.)));
        cx.run_until_parked();
        root.update(cx, |root, cx| {
            assert!(matches!(root.screen, Screen::Main));
            root.open_intake_forms(cx);
            let Overlay::IntakeForms(desk) = &mut root.overlay else {
                panic!("missing forms")
            };
            desk.request = None;
            desk.error = None;
            desk.loaded = true;
            let mut editor = Editor::new(None, cx);
            editor
                .title
                .update(cx, |field, cx| field.set_text("Synthetic consent", cx));
            editor.edit(Edit::Waiver, cx);
            editor.edit(Edit::Kind(0, FieldKind::Consent), cx);
            assert_eq!(
                editor.definition(cx, true).err(),
                Some(Key::FormInvalidQuestion)
            );
            editor.fields[0]
                .label
                .update(cx, |field, cx| field.set_text("I agree", cx));
            assert_eq!(
                editor.definition(cx, true).err(),
                Some(Key::FormWaiverRequiresConsent)
            );
            editor.edit(Edit::FieldRequired(0), cx);
            editor.edit(Edit::AddField, cx);
            editor.edit(Edit::Kind(1, FieldKind::Multiple), cx);
            editor.fields[1]
                .label
                .update(cx, |field, cx| field.set_text("Preferred services", cx));
            editor.fields[1].options[0]
                .1
                .update(cx, |field, cx| field.set_text("Nails", cx));
            editor.edit(Edit::AddChoice(1), cx);
            editor.fields[1].options[1]
                .1
                .update(cx, |field, cx| field.set_text("Facial", cx));
            let first_choice = editor.fields[1].options[0].0.clone();
            editor.edit(Edit::MoveChoice(1, 0, 1), cx);
            assert_eq!(editor.fields[1].options[1].0, first_choice);
            let consent_id = editor.fields[0].id.clone();
            editor.edit(Edit::MoveField(0, 1), cx);
            assert_eq!(editor.fields[1].id, consent_id);
            let line = editor.description.fields[0].clone();
            line.update(cx, |field, cx| field.set_text("Intro", cx));
            editor.insert_pasted_lines(&line, &["".into(), "second paragraph".into()], cx);
            let draft = editor.definition(cx, true).unwrap();
            assert_eq!(draft.description, "Intro\n\nsecond paragraph");
            assert!(serde_json::to_value(&draft).unwrap()["fields"][0]["options"].is_array());
            let saved = AdminForm {
                id: id(),
                version: 1,
                active: false,
                published: None,
                draft,
            };
            desk.forms.push(AdminFormSummary::from(&saved));
            desk.editor = Some(Editor::new(Some(saved), cx));
            desk.confirm = Some(Confirm::Publish);
            cx.notify();
        });
        cx.run_until_parked();
        let preview = cx.debug_bounds("form-admin-review-scroll").expect("review");
        let footer = cx.debug_bounds("form-back").expect("back");
        assert!(preview.bottom() <= footer.top());
        assert!(footer.bottom() < px(470.) && footer.left() > px(0.));
        cx.simulate_click(footer.center(), Default::default());
        cx.run_until_parked();
        root.update(cx, |root, cx| {
            let Overlay::IntakeForms(desk) = &mut root.overlay else {
                panic!("missing forms")
            };
            assert!(desk.confirm.is_none());
            let editor = desk.editor.as_ref().unwrap();
            assert!(!editor.dirty(cx));
            editor
                .title
                .update(cx, |field, cx| field.set_text("Unsaved title", cx));
            assert!(editor.dirty(cx));
            root.close_intake_forms(cx);
            let Overlay::IntakeForms(desk) = &root.overlay else {
                panic!("missing editor")
            };
            assert!(matches!(desk.confirm, Some(Confirm::Close)));
            assert_eq!(desk.forms[0].title, "Synthetic consent");
        });
    }
}
