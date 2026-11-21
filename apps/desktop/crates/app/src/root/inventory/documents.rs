use super::*;
use sob_core::http::HttpTransport;
use sob_core::inventory::Pagination;
use sob_core::inventory_documents::{
    Delivery, DeliveryLine, DeliveryReview, DeliveryReviewRequest, DocumentProposal, MAX_LINES,
    Receipt, ReceiptPage, ReviewedDocument, Supplier, SupplierFields, SupplierPage,
};
use uuid::Uuid;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Tab {
    Suppliers,
    Receipts,
}

impl Tab {
    fn title(self) -> Key {
        match self {
            Self::Suppliers => Key::InventorySuppliers,
            Self::Receipts => Key::InventoryReceipts,
        }
    }
}

enum View {
    Suppliers(SupplierPage),
    Receipts(ReceiptPage),
}

impl View {
    fn page(&self) -> &Pagination {
        match self {
            Self::Suppliers(page) => &page.pagination,
            Self::Receipts(page) => &page.pagination,
        }
    }
}

#[derive(Clone)]
enum Request {
    Suppliers {
        search: String,
        active: Option<bool>,
        page: u32,
        picker: bool,
    },
    Receipts(u32),
    Supplier(Uuid),
    Receipt(Uuid),
    Products(ProductQuery, u32),
    Product(Uuid),
    ReviewDelivery(DeliveryReviewRequest),
}

enum Response {
    Suppliers(SupplierPage, bool),
    Receipts(ReviewedDocument<ReceiptPage>),
    Supplier(ReviewedDocument<Option<Supplier>>),
    Receipt(Option<ReviewedDocument<Receipt>>),
    Products(ProductPage),
    Product(Box<Product>),
    Delivery(DeliveryReview),
}

impl Request {
    fn run(self, api: &HttpTransport) -> Result<Response, TransportError> {
        match self {
            Self::Suppliers {
                search,
                active,
                page,
                picker,
            } => api
                .inventory_suppliers(&search, active, page)
                .map(|rows| Response::Suppliers(rows, picker)),
            Self::Receipts(page) => api.inventory_receipts(page).map(Response::Receipts),
            Self::Supplier(id) => api.review_supplier(id).map(Response::Supplier),
            Self::Receipt(id) => api.inventory_receipt(id).map(Response::Receipt),
            Self::Products(query, page) => {
                api.inventory_products(&query, page).map(Response::Products)
            }
            Self::Product(id) => api
                .inventory_product(id)
                .map(Box::new)
                .map(Response::Product),
            Self::ReviewDelivery(draft) => api.review_delivery(&draft).map(Response::Delivery),
        }
    }
}

pub(super) struct Panel {
    tab: Tab,
    search: Entity<TextField>,
    supplier_filter: Option<bool>,
    page: u32,
    view: Option<View>,
    detail: Option<Receipt>,
    editor: Option<Editor>,
    request: Option<Arc<()>>,
    notice: Option<Key>,
    confirm_discard: bool,
    revision: i64,
    staff_revision: i64,
    writable: bool,
    retry: Option<Instant>,
    backoff: Backoff,
}

enum Editor {
    Supplier(SupplierForm),
    Receipt(ReceiptForm),
}

struct SupplierForm {
    original: Supplier,
    name: Entity<TextField>,
    email: Entity<TextField>,
    phone: Entity<TextField>,
    tax_id: Entity<TextField>,
    notes: Entity<TextField>,
    active: bool,
    generation: Option<String>,
    conflict: Option<String>,
    reviewed: Option<Supplier>,
    confirm_archive: bool,
}

impl SupplierForm {
    fn current(&self, cx: &App) -> SupplierFields {
        SupplierFields {
            name: self.name.read(cx).text().into(),
            email: optional(&self.email, cx),
            phone: optional(&self.phone, cx),
            tax_id: optional(&self.tax_id, cx),
            notes: optional(&self.notes, cx),
            active: self.active,
        }
    }

    fn dirty(&self, cx: &App) -> bool {
        self.conflict.is_some() || self.current(cx) != self.original.fields
    }
}

struct ReceiptForm {
    id: Uuid,
    generation: Option<String>,
    date: Entity<TextField>,
    default_date: String,
    invoice: Entity<TextField>,
    notes: Entity<TextField>,
    supplier_id: Option<Uuid>,
    supplier_search: Entity<TextField>,
    supplier_page: Option<SupplierPage>,
    product_search: Entity<TextField>,
    product_page: Option<ProductPage>,
    lines: Vec<LineEdit>,
    conflict: Option<(String, Delivery)>,
    needs_confirmation: bool,
}

impl ReceiptForm {
    fn dirty(&self, cx: &App) -> bool {
        self.conflict.is_some()
            || !self.lines.is_empty()
            || self.supplier_id.is_some()
            || self.date.read(cx).text() != self.default_date
            || optional(&self.invoice, cx).is_some()
            || optional(&self.notes, cx).is_some()
    }
}

struct LineEdit {
    id: Uuid,
    current: Option<Product>,
    quantity: Entity<TextField>,
}

fn optional(field: &Entity<TextField>, cx: &App) -> Option<String> {
    let value = field.read(cx).text();
    (!value.trim().is_empty()).then(|| value.into())
}

impl Panel {
    pub(super) fn dismiss(&mut self, cx: &App) -> bool {
        if self.confirm_discard {
            self.confirm_discard = false;
            return false;
        }
        let dirty = match &mut self.editor {
            Some(Editor::Supplier(form)) if form.confirm_archive => {
                form.confirm_archive = false;
                return false;
            }
            Some(Editor::Supplier(form)) => form.dirty(cx),
            Some(Editor::Receipt(form)) => form.dirty(cx),
            None => false,
        };
        if dirty {
            self.confirm_discard = true;
            return false;
        }
        self.request = None;
        self.notice = None;
        if self.editor.take().is_some() || self.detail.take().is_some() {
            return false;
        }
        true
    }

    fn list_request(&self, cx: &App) -> Request {
        match self.tab {
            Tab::Suppliers => Request::Suppliers {
                search: self.search.read(cx).text().trim().into(),
                active: self.supplier_filter,
                page: self.page,
                picker: false,
            },
            Tab::Receipts => Request::Receipts(self.page),
        }
    }
}

impl Root {
    pub(in crate::root) fn dismiss_inventory_document_panel(
        &mut self,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(panel) = self.document_panel() else {
            return false;
        };
        let leaving_detail = panel.detail.is_some() || panel.editor.is_some();
        let close = panel.dismiss(cx);
        let page = panel.page;
        let show_list = leaving_detail && panel.detail.is_none() && panel.editor.is_none();
        if close {
            if let Overlay::Inventory(desk) = &mut self.overlay {
                desk.documents = None;
                desk.observed_revision = -1;
            }
        } else if show_list {
            self.load_document_list(page, cx);
        }
        cx.notify();
        true
    }

    fn close_inventory_document_editor(&mut self, cx: &mut Context<Self>) {
        if let Some(panel) = self.document_panel() {
            panel.editor = None;
            panel.request = None;
            panel.confirm_discard = false;
            let page = panel.page;
            self.load_document_list(page, cx);
        }
        cx.notify();
    }

    fn document_panel(&mut self) -> Option<&mut Panel> {
        match &mut self.overlay {
            Overlay::Inventory(desk) => desk.documents.as_deref_mut(),
            _ => None,
        }
    }

    pub(super) fn open_inventory_documents(&mut self, tab: Tab, cx: &mut Context<Self>) {
        if self.prepare_inventory_documents(tab, cx) {
            self.load_document_list(1, cx);
        }
    }

    fn prepare_inventory_documents(&mut self, tab: Tab, cx: &mut Context<Self>) -> bool {
        let writable = self.svc.store.can_queue_product_edits();
        let Overlay::Inventory(desk) = &mut self.overlay else {
            return false;
        };
        if tab == Tab::Suppliers
            && !self.svc.store.can_queue_product_edits()
            && self.svc.status().connectivity != Connectivity::Online
        {
            return false;
        }
        desk.request = None;
        desk.retry = None;
        desk.error = None;
        desk.documents = Some(Box::new(Panel {
            tab,
            search: cx.new(|cx| TextField::new("", false, cx)),
            supplier_filter: None,
            page: 1,
            view: None,
            detail: None,
            editor: None,
            request: None,
            notice: None,
            confirm_discard: false,
            revision: -1,
            staff_revision: -1,
            writable,
            retry: None,
            backoff: Backoff::default(),
        }));
        true
    }

    pub(super) fn load_document_list(&mut self, page: u32, cx: &mut Context<Self>) {
        let online = self.svc.status().connectivity == Connectivity::Online;
        let Some(panel) = self.document_panel() else {
            return;
        };
        if panel.request.is_some() {
            return;
        }
        panel.page = page;
        let request = panel.list_request(cx);
        if online {
            self.request_document(request, cx);
        } else if matches!(request, Request::Receipts(_)) {
            let restored = self.svc.store.cached_receipt_page(page).ok().flatten();
            if let Some(panel) = self.document_panel() {
                panel.view = restored.map(View::Receipts);
            }
            cx.notify();
        } else {
            cx.notify();
        }
    }

    pub(in crate::root) fn preserve_open_inventory_documents(&mut self) -> bool {
        let Some(panel) = self.document_panel() else {
            return false;
        };
        panel.view = None;
        panel.detail = None;
        panel.request = None;
        panel.revision = -1;
        panel.retry = None;
        match &mut panel.editor {
            Some(Editor::Supplier(form)) => {
                form.generation = None;
                form.reviewed = None;
            }
            Some(Editor::Receipt(form)) => {
                form.generation = None;
                form.needs_confirmation = true;
                form.supplier_page = None;
                form.product_page = None;
                for line in &mut form.lines {
                    line.current = None;
                }
            }
            None => {}
        }
        panel.notice = Some(Key::InventoryDocumentChanged);
        true
    }

    pub(super) fn refresh_inventory_documents(
        &mut self,
        reconnecting: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        let revision = self
            .svc
            .store
            .live_view_revision(LIVE_TOPIC)
            .unwrap_or_default();
        let staff = self
            .svc
            .store
            .staff_directory_revision()
            .unwrap_or_default();
        let online = self.svc.status().connectivity == Connectivity::Online;
        let writable = self.svc.store.can_queue_product_edits();
        let Some(panel) = self.document_panel() else {
            return false;
        };
        if (panel.staff_revision >= 0 && panel.staff_revision != staff)
            || panel.writable != writable
        {
            panel.writable = writable;
            panel.view = None;
            panel.detail = None;
            panel.revision = -1;
            if let Some(Editor::Receipt(form)) = &mut panel.editor {
                form.supplier_page = None;
                form.product_page = None;
            }
        }
        if online
            && panel.request.is_none()
            && panel.editor.is_none()
            && (reconnecting
                || panel.retry.map_or(
                    revision != panel.revision || staff != panel.staff_revision,
                    |retry| Instant::now() >= retry,
                ))
        {
            let request = panel.detail.as_ref().map_or_else(
                || panel.list_request(cx),
                |receipt| Request::Receipt(receipt.header.id),
            );
            self.request_document(request, cx);
        }
        true
    }

    fn request_document(&mut self, request: Request, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.svc.status().connectivity == Connectivity::Online)
        else {
            return;
        };
        let revision = self
            .svc
            .store
            .live_view_revision(LIVE_TOPIC)
            .unwrap_or_default();
        let staff = self
            .svc
            .store
            .staff_directory_revision()
            .unwrap_or_default();
        let session = self.svc.session.clone();
        let Some(panel) = self.document_panel() else {
            return;
        };
        if panel.request.is_some() {
            return;
        }
        let token = Arc::new(());
        panel.request = Some(token.clone());
        panel.notice = None;
        panel.retry = None;
        cx.notify();
        cx.spawn(async move |handle, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { request.run(&transport) })
                .await;
            let _ = handle.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session) {
                    return;
                }
                let current_staff = root
                    .svc
                    .store
                    .staff_directory_revision()
                    .unwrap_or_default();
                if !root.document_panel().is_some_and(|panel| {
                    panel
                        .request
                        .as_ref()
                        .is_some_and(|pending| Arc::ptr_eq(pending, &token))
                }) {
                    return;
                }
                if matches!(
                    &result,
                    Err(TransportError::Forbidden(_) | TransportError::Unauthorized)
                ) {
                    let _ = root.svc.store.withdraw_inventory_access();
                }
                let Some(panel) = root.document_panel() else {
                    return;
                };
                panel.request = None;
                panel.revision = revision;
                panel.staff_revision = staff;
                if current_staff != staff {
                    panel.view = None;
                    panel.detail = None;
                    panel.revision = -1;
                    cx.notify();
                    return;
                }
                match result {
                    Ok(response) => {
                        panel.backoff = Backoff::default();
                        root.apply_document_response(response, cx);
                    }
                    Err(error) => {
                        panel.notice = Some(
                            if matches!(
                                error,
                                TransportError::Forbidden(_) | TransportError::Unauthorized
                            ) {
                                panel.view = None;
                                panel.detail = None;
                                Key::InventoryRestricted
                            } else {
                                if matches!(
                                    error,
                                    TransportError::Offline(_)
                                        | TransportError::Server(_)
                                        | TransportError::RateLimited(_)
                                ) {
                                    let minimum = match error {
                                        TransportError::RateLimited(value) => value,
                                        _ => None,
                                    };
                                    panel.retry = Instant::now().checked_add(Backoff::at_least(
                                        panel.backoff.next_delay().max(Duration::from_millis(500)),
                                        minimum,
                                    ));
                                }
                                Key::InventoryDocumentFailed
                            },
                        );
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }

    fn apply_document_response(&mut self, response: Response, cx: &mut Context<Self>) {
        let generation = self.svc.store.verified_reviewed_generation().ok();
        let valid = |received: &str| generation.as_deref() == Some(received);
        match response {
            Response::Suppliers(rows, picker) if valid(&rows.generation) => {
                let _ = self.svc.store.cache_supplier_page(&rows);
                if let Some(panel) = self.document_panel() {
                    if picker {
                        if let Some(Editor::Receipt(form)) = &mut panel.editor {
                            form.supplier_page = Some(rows);
                        }
                    } else {
                        panel.view = Some(View::Suppliers(rows));
                    }
                }
            }
            Response::Receipts(page) if valid(&page.generation) => {
                let _ = self
                    .svc
                    .store
                    .cache_receipt_page(&page.value, &page.generation);
                if let Some(panel) = self.document_panel() {
                    panel.view = Some(View::Receipts(page.value));
                }
            }
            Response::Receipt(Some(receipt)) if valid(&receipt.generation) => {
                let _ = self
                    .svc
                    .store
                    .cache_receipt(&receipt.value, &receipt.generation);
                if let Some(panel) = self.document_panel() {
                    panel.detail = Some(receipt.value);
                }
            }
            Response::Products(rows) => {
                if let Some(panel) = self.document_panel()
                    && let Some(Editor::Receipt(form)) = &mut panel.editor
                {
                    form.product_page = Some(rows);
                }
            }
            Response::Product(product)
                if product.inventory_generation.as_deref() == generation.as_deref()
                    && product.can_manage
                    && product.active =>
            {
                let _ = self.svc.store.remember_reviewed_product(&product);
                self.add_document_product(*product, cx);
            }
            Response::Supplier(supplier) => {
                self.load_supplier_review(supplier, generation.as_deref(), cx);
            }
            Response::Delivery(review) => {
                self.load_delivery_review(review, generation.as_deref(), cx)
            }
            _ => {
                if let Some(panel) = self.document_panel() {
                    panel.notice = Some(Key::InventoryDocumentChanged);
                }
            }
        }
        cx.notify();
    }

    fn add_document_product(&mut self, product: Product, cx: &mut Context<Self>) {
        let Some(panel) = self.document_panel() else {
            return;
        };
        let Some(Editor::Receipt(form)) = &mut panel.editor else {
            return;
        };
        if form.lines.len() >= MAX_LINES || form.lines.iter().any(|line| line.id == product.id) {
            return;
        }
        form.lines.push(LineEdit {
            id: product.id,
            current: Some(product),
            quantity: cx.new(|cx| text_input("1", "", cx)),
        });
        cx.notify();
    }

    fn open_document_receipt(&mut self, id: Uuid, cx: &mut Context<Self>) {
        let cached = self.svc.store.cached_receipt(id).ok().flatten();
        if let Some(panel) = self.document_panel() {
            panel.detail = cached;
        }
        self.request_document(Request::Receipt(id), cx);
        cx.notify();
    }

    pub(super) fn open_linked_inventory_receipt(&mut self, id: Uuid, cx: &mut Context<Self>) {
        if self.prepare_inventory_documents(Tab::Receipts, cx) {
            self.open_document_receipt(id, cx);
        }
    }

    fn edit_inventory_supplier(
        &mut self,
        supplier: Supplier,
        conflict: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if !self.svc.store.can_queue_product_edits() {
            return;
        }
        let generation = conflict
            .is_none()
            .then(|| self.svc.store.verified_reviewed_generation().ok())
            .flatten();
        let Some(panel) = self.document_panel() else {
            return;
        };
        let fields = &supplier.fields;
        panel.editor = Some(Editor::Supplier(SupplierForm {
            name: cx.new(|cx| text_input(&fields.name, "", cx)),
            email: cx.new(|cx| text_input(fields.email.as_deref().unwrap_or(""), "", cx)),
            phone: cx.new(|cx| text_input(fields.phone.as_deref().unwrap_or(""), "", cx)),
            tax_id: cx.new(|cx| text_input(fields.tax_id.as_deref().unwrap_or(""), "", cx)),
            notes: cx.new(|cx| text_input(fields.notes.as_deref().unwrap_or(""), "", cx)),
            active: fields.active,
            generation,
            conflict,
            original: supplier,
            reviewed: None,
            confirm_archive: false,
        }));
        panel.request = None;
        panel.notice = None;
        cx.notify();
    }

    fn edit_inventory_receipt(
        &mut self,
        conflict: Option<(String, Delivery)>,
        cx: &mut Context<Self>,
    ) {
        if !self.svc.store.can_queue_product_edits() {
            return;
        }
        let generation = conflict
            .is_none()
            .then(|| self.svc.store.verified_reviewed_generation().ok())
            .flatten();
        let today = Utc::now().with_timezone(&self.tz).date_naive().to_string();
        let draft = conflict.as_ref().map(|(_, draft)| draft);
        let Some(panel) = self.document_panel() else {
            return;
        };
        panel.editor = Some(Editor::Receipt(ReceiptForm {
            id: draft.map_or_else(Uuid::now_v7, |draft| draft.id),
            generation,
            date: cx.new(|cx| text_input(draft.map_or(&today, |draft| &draft.received_on), "", cx)),
            default_date: today,
            invoice: cx.new(|cx| {
                text_input(
                    draft
                        .and_then(|draft| draft.invoice_reference.as_deref())
                        .unwrap_or(""),
                    "",
                    cx,
                )
            }),
            notes: cx.new(|cx| {
                text_input(
                    draft.and_then(|draft| draft.notes.as_deref()).unwrap_or(""),
                    "",
                    cx,
                )
            }),
            supplier_id: draft.and_then(|draft| draft.supplier_id),
            supplier_search: cx.new(|cx| TextField::new("", false, cx)),
            supplier_page: None,
            product_search: cx.new(|cx| TextField::new("", false, cx)),
            product_page: None,
            lines: draft.map_or_else(Vec::new, |draft| {
                draft
                    .lines
                    .iter()
                    .map(|line| LineEdit {
                        id: line.product_id,
                        current: None,
                        quantity: cx.new(|cx| text_input(&line.quantity.to_string(), "", cx)),
                    })
                    .collect()
            }),
            conflict,
            needs_confirmation: false,
        }));
        panel.request = None;
        panel.notice = None;
        cx.notify();
    }

    pub(in crate::root) fn open_inventory_document_conflict(
        &mut self,
        mutation: &str,
        cx: &mut Context<Self>,
    ) {
        let Ok(Some(draft)) = self.svc.store.inventory_document_conflict(mutation) else {
            return;
        };
        self.prepare_inventory(cx);
        match draft {
            DocumentProposal::Supplier(supplier) => {
                self.prepare_inventory_documents(Tab::Suppliers, cx);
                self.edit_inventory_supplier(supplier, Some(mutation.into()), cx);
            }
            DocumentProposal::Receipt(draft) => {
                self.prepare_inventory_documents(Tab::Receipts, cx);
                self.edit_inventory_receipt(Some((mutation.into(), draft)), cx);
            }
        }
    }

    fn load_supplier_review(
        &mut self,
        reviewed: ReviewedDocument<Option<Supplier>>,
        generation: Option<&str>,
        cx: &mut Context<Self>,
    ) {
        let valid = Some(reviewed.generation.as_str()) == generation
            && reviewed.value.as_ref().is_none_or(|supplier| {
                self.svc
                    .store
                    .cache_reviewed_supplier(supplier, &reviewed.generation)
                    .is_ok()
            });
        if let Some(panel) = self.document_panel()
            && let Some(Editor::Supplier(form)) = &mut panel.editor
        {
            if !valid {
                panel.notice = Some(Key::InventoryDocumentChanged);
            } else {
                form.reviewed = Some(reviewed.value.unwrap_or_else(|| Supplier {
                    id: form.original.id,
                    version: 0,
                    fields: SupplierFields {
                        active: true,
                        ..Default::default()
                    },
                }));
            }
            cx.notify();
        }
    }

    fn load_delivery_review(
        &mut self,
        review: DeliveryReview,
        generation: Option<&str>,
        cx: &mut Context<Self>,
    ) {
        match review {
            DeliveryReview::Recorded(receipt)
                if Some(receipt.generation.as_str()) == generation =>
            {
                let mutation = self.document_panel().and_then(|panel| match &panel.editor {
                    Some(Editor::Receipt(form)) => form.conflict.as_ref().map(|(id, _)| id.clone()),
                    _ => None,
                });
                if let Some(mutation) = mutation
                    && self
                        .svc
                        .store
                        .finish_inventory_receipt_review(
                            &mutation,
                            &receipt.value,
                            &receipt.generation,
                        )
                        .is_ok()
                {
                    let _ = self
                        .svc
                        .store
                        .cache_receipt(&receipt.value, &receipt.generation);
                    if let Some(panel) = self.document_panel() {
                        panel.editor = None;
                        panel.detail = Some(receipt.value);
                        panel.notice = Some(Key::InventoryReceiptAlreadyRecorded);
                    }
                    self.reload(cx);
                }
            }
            DeliveryReview::Current { products, supplier } => {
                let ids = self.document_panel().and_then(|panel| match &panel.editor {
                    Some(Editor::Receipt(form)) => {
                        Some(form.lines.iter().map(|line| line.id).collect::<Vec<_>>())
                    }
                    _ => None,
                });
                let valid = generation.zip(ids).is_some_and(|(generation, ids)| {
                    self.svc
                        .store
                        .cache_delivery_review(generation, &ids, &products, supplier.as_ref())
                        .is_ok()
                });
                if let Some(panel) = self.document_panel()
                    && let Some(Editor::Receipt(form)) = &mut panel.editor
                {
                    if valid {
                        for (line, product) in form.lines.iter_mut().zip(products) {
                            line.current = product;
                        }
                        form.generation = generation.map(str::to_owned);
                        form.needs_confirmation = true;
                    } else {
                        panel.notice = Some(Key::InventoryDocumentChanged);
                    }
                }
            }
            _ => {
                if let Some(panel) = self.document_panel() {
                    panel.notice = Some(Key::InventoryDocumentChanged);
                }
            }
        }
        cx.notify();
    }

    fn save_inventory_document(&mut self, archive_confirmed: bool, cx: &mut Context<Self>) {
        let Some(actor) = self
            .svc
            .current_session()
            .map(|session| session.user_id.clone())
        else {
            return;
        };
        if !self.svc.store.can_queue_product_edits() {
            return;
        }
        let Some(panel) = self.document_panel() else {
            return;
        };
        if panel.request.is_some() {
            return;
        }
        let Some(editor) = &mut panel.editor else {
            return;
        };
        let (proposal, generation, replaces) = match editor {
            Editor::Supplier(form) => {
                let Some(generation) = form.generation.clone() else {
                    return;
                };
                if form.original.fields.active && !form.active && !archive_confirmed {
                    form.confirm_archive = true;
                    cx.notify();
                    return;
                }
                form.confirm_archive = false;
                let row = Supplier {
                    id: form.original.id,
                    version: form.original.version,
                    fields: form.current(cx),
                };
                (
                    DocumentProposal::Supplier(row),
                    generation,
                    form.conflict.clone(),
                )
            }
            Editor::Receipt(form) => {
                let Some(generation) = form.generation.clone().filter(|_| !form.needs_confirmation)
                else {
                    return;
                };
                let lines = form
                    .lines
                    .iter()
                    .map(|line| {
                        let product = line
                            .current
                            .as_ref()
                            .ok_or_else(|| CoreError::Invalid("Missing review".into()))?;
                        DeliveryLine::reviewed(product, line.quantity.read(cx).text(), &generation)
                    })
                    .collect::<Result<Vec<_>, _>>();
                let Ok(lines) = lines else {
                    panel.notice = Some(Key::InventoryDocumentInvalid);
                    cx.notify();
                    return;
                };
                let row = Delivery {
                    id: form.id,
                    received_on: form.date.read(cx).text().into(),
                    supplier_id: form.supplier_id,
                    invoice_reference: optional(&form.invoice, cx),
                    notes: optional(&form.notes, cx),
                    actor_user_id: actor,
                    lines,
                };
                (
                    DocumentProposal::Receipt(row),
                    generation,
                    form.conflict.as_ref().map(|(id, _)| id.clone()),
                )
            }
        };
        match self
            .svc
            .store
            .queue_inventory_document(&generation, proposal, replaces.as_deref())
        {
            Ok(()) => {
                if let Some(panel) = self.document_panel() {
                    panel.editor = None;
                    panel.notice = Some(Key::InventoryDocumentQueued);
                }
                if self.svc.status().connectivity == Connectivity::Online {
                    self.edited(cx);
                } else {
                    self.reload(cx);
                }
            }
            Err(error) => {
                if let Some(panel) = self.document_panel() {
                    if matches!(
                        error,
                        CoreError::CatalogueVersionChanged | CoreError::CalendarGenerationChanged
                    ) {
                        match &mut panel.editor {
                            Some(Editor::Supplier(form)) => {
                                form.generation = None;
                                form.reviewed = None;
                            }
                            Some(Editor::Receipt(form)) => {
                                form.generation = None;
                                form.needs_confirmation = true;
                            }
                            None => {}
                        }
                    }
                    panel.notice = Some(match error {
                        CoreError::CatalogueVersionChanged
                        | CoreError::CalendarGenerationChanged
                        | CoreError::CatalogueEditPending => Key::InventoryDocumentChanged,
                        _ => Key::InventoryDocumentInvalid,
                    });
                }
            }
        }
        cx.notify();
    }
}

impl Root {
    fn search_document_picker(&mut self, supplier: bool, page: u32, cx: &mut Context<Self>) {
        let Some(panel) = self.document_panel() else {
            return;
        };
        let Some(Editor::Receipt(form)) = &mut panel.editor else {
            return;
        };
        let request = if supplier {
            let search = form.supplier_search.read(cx).text().trim().to_owned();
            if search.encode_utf16().count() > 100 {
                return;
            }
            Request::Suppliers {
                search,
                active: Some(true),
                page,
                picker: true,
            }
        } else {
            let Some(query) = ProductQuery::new(form.product_search.read(cx).text(), false) else {
                return;
            };
            Request::Products(query, page)
        };
        self.request_document(request, cx);
    }

    fn review_document_draft(&mut self, cx: &mut Context<Self>) {
        let Some(panel) = self.document_panel() else {
            return;
        };
        let request = match &panel.editor {
            Some(Editor::Supplier(form)) => Request::Supplier(form.original.id),
            Some(Editor::Receipt(form)) => Request::ReviewDelivery(DeliveryReviewRequest {
                id: form.id,
                supplier_id: form.supplier_id,
                product_ids: form.lines.iter().map(|line| line.id).collect(),
            }),
            None => return,
        };
        self.request_document(request, cx);
    }

    fn adopt_document_review(&mut self, cx: &mut Context<Self>) {
        let Ok(generation) = self.svc.store.verified_reviewed_generation() else {
            return;
        };
        let Some(panel) = self.document_panel() else {
            return;
        };
        match &mut panel.editor {
            Some(Editor::Supplier(form)) if form.reviewed.is_some() => {
                let reviewed = form.reviewed.take().unwrap();
                form.original = reviewed;
                form.generation = Some(generation);
            }
            Some(Editor::Receipt(form)) if form.generation.as_ref() == Some(&generation) => {
                form.needs_confirmation = false;
            }
            _ => return,
        }
        panel.notice = None;
        cx.notify();
    }
}

mod view;

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn offline_inventory_edits_require_an_explicit_save_and_preserve_the_pending_supplier(
        cx: &mut TestAppContext,
    ) {
        let (_dir, window) = crate::root::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                let generation = root.svc.store.verified_reviewed_generation().unwrap();
                root.svc
                    .store
                    .set_meta("inventory_write_access", &generation)
                    .unwrap();
                root.open_inventory(cx);
                root.open_inventory_documents(Tab::Suppliers, cx);
                root.edit_inventory_supplier(Supplier::new(), None, cx);
                let Some(Editor::Supplier(form)) = root
                    .document_panel()
                    .and_then(|panel| panel.editor.as_mut())
                else {
                    panic!("supplier editor did not open");
                };
                let id = form.original.id;
                form.name
                    .update(cx, |field, cx| field.set_text("Local supplier", cx));
                root.dismiss_overlay(cx);
                assert!(root.document_panel().unwrap().confirm_discard);
                assert!(
                    root.svc
                        .store
                        .pending_inventory_documents()
                        .unwrap()
                        .is_empty()
                );
                root.dismiss_overlay(cx);
                root.save_inventory_document(false, cx);
                assert!(root.document_panel().unwrap().editor.is_none());
                let rows = root.svc.store.pending_inventory_documents().unwrap();
                assert_eq!(rows.len(), 1);
                assert_eq!(rows[0].id(), id);
            })
            .unwrap();
    }
}
