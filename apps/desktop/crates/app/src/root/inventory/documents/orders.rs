use super::*;

impl ReceiptForm {
    pub(super) fn link(&self) -> Option<PurchaseOrderLink> {
        self.purchase_order
            .as_ref()
            .map(|order| PurchaseOrderLink {
                id: order.header.id,
                version: order.header.version,
            })
            .or_else(|| {
                self.conflict
                    .as_ref()
                    .and_then(|(_, draft)| draft.purchase_order)
            })
    }

    pub(super) fn order_proposal(
        &self,
        mut proposal: PurchaseOrderProposal,
        cx: &App,
    ) -> Option<PurchaseOrderProposal> {
        let lines = self
            .lines
            .iter()
            .map(|line| {
                Some(RequestedProduct {
                    product_id: line.id,
                    quantity: line.quantity.read(cx).text().trim().parse().ok()?,
                })
            })
            .collect::<Option<Vec<_>>>()?;
        proposal.action = PurchaseOrderAction::Save(PurchaseOrderFields {
            supplier_id: self.supplier_id?,
            supplier_reference: optional(&self.invoice, cx),
            expected_on: optional(&self.date, cx),
            notes: optional(&self.notes, cx),
            lines,
        });
        Some(proposal)
    }
}

impl Root {
    pub(super) fn open_order(&mut self, id: Uuid, cx: &mut Context<Self>) {
        if self.svc.status().connectivity == Connectivity::Online {
            self.request_document(Request::Order(id), cx);
        } else if let Ok(Some(order)) = self.svc.store.cached_purchase_order(id)
            && let Some(panel) = self.document_panel()
        {
            panel.order = Some(order);
            panel.notice = None;
            cx.notify();
        }
    }

    fn fill_order_draft(
        &mut self,
        draft: PurchaseOrderProposal,
        replacing: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let PurchaseOrderAction::Save(fields) = &draft.action else {
            return;
        };
        let products = self.svc.store.reviewed_products().unwrap_or_default();
        self.edit_inventory_receipt(None, cx);
        if let Some(panel) = self.document_panel()
            && let Some(Editor::Receipt(form)) = &mut panel.editor
        {
            form.date =
                cx.new(|cx| text_input(fields.expected_on.as_deref().unwrap_or(""), "", cx));
            form.default_date.clear();
            form.invoice =
                cx.new(|cx| text_input(fields.supplier_reference.as_deref().unwrap_or(""), "", cx));
            form.notes = cx.new(|cx| text_input(fields.notes.as_deref().unwrap_or(""), "", cx));
            form.supplier_id = (!fields.supplier_id.is_nil()).then_some(fields.supplier_id);
            form.lines = fields
                .lines
                .iter()
                .map(|line| LineEdit {
                    id: line.product_id,
                    current: products
                        .iter()
                        .find(|product| product.id == line.product_id)
                        .cloned(),
                    quantity: cx.new(|cx| text_input(&line.quantity.to_string(), "", cx)),
                })
                .collect();
            form.draft_order = Some(draft);
            form.draft_conflict = replacing;
        }
    }

    pub(super) fn edit_order(&mut self, order: Option<PurchaseOrder>, cx: &mut Context<Self>) {
        let (id, version, fields) = if let Some(order) = order {
            (
                order.header.id,
                order.header.version,
                PurchaseOrderFields {
                    supplier_id: order.header.supplier_id,
                    supplier_reference: order.header.supplier_reference,
                    expected_on: order.header.expected_on,
                    notes: order.header.notes,
                    lines: order
                        .lines
                        .into_iter()
                        .map(|line| RequestedProduct {
                            product_id: line.product_id,
                            quantity: line.quantity,
                        })
                        .collect(),
                },
            )
        } else {
            (
                Uuid::now_v7(),
                0,
                PurchaseOrderFields {
                    supplier_id: Uuid::nil(),
                    supplier_reference: None,
                    expected_on: None,
                    notes: None,
                    lines: Vec::new(),
                },
            )
        };
        self.fill_order_draft(
            PurchaseOrderProposal {
                id,
                version,
                action: PurchaseOrderAction::Save(fields),
            },
            None,
            cx,
        );
    }

    pub(super) fn apply_order_review(
        &mut self,
        id: Uuid,
        order: Option<PurchaseOrder>,
        generation: &str,
        cx: &mut Context<Self>,
    ) {
        let Some(panel) = self.document_panel() else {
            return;
        };
        panel.order = order;
        panel.notice = None;
        let version = panel.order.as_ref().map_or(0, |order| order.header.version);
        if let Some(Editor::Receipt(form)) = &mut panel.editor
            && let Some(draft) = &mut form.draft_order
            && draft.id == id
        {
            if panel
                .order
                .as_ref()
                .is_none_or(|order| order.header.status == PurchaseOrderStatus::Draft)
            {
                form.needs_confirmation |= draft.version != version || form.generation.is_none();
                draft.version = version;
                form.generation = Some(generation.into());
            } else {
                panel.notice = Some(Key::InventoryDocumentChanged);
            }
            return;
        }
        if let Some((mutation, draft)) = &panel.order_conflict
            && draft.id == id
            && matches!(draft.action, PurchaseOrderAction::Save(_))
            && panel
                .order
                .as_ref()
                .is_none_or(|order| order.header.status == PurchaseOrderStatus::Draft)
        {
            let mut draft = draft.clone();
            draft.version = version;
            let replacing = mutation.clone();
            self.fill_order_draft(draft, Some(replacing), cx);
            if let Some(panel) = self.document_panel()
                && let Some(Editor::Receipt(form)) = &mut panel.editor
            {
                form.needs_confirmation = true;
            }
        }
    }

    pub(super) fn start_order_delivery(&mut self, order: PurchaseOrder, cx: &mut Context<Self>) {
        let products = self.svc.store.reviewed_products().unwrap_or_default();
        self.edit_inventory_receipt(None, cx);
        if let Some(panel) = self.document_panel()
            && let Some(Editor::Receipt(form)) = &mut panel.editor
        {
            form.supplier_id = Some(order.header.supplier_id);
            form.lines = order
                .lines
                .iter()
                .filter(|line| line.remaining() > 0)
                .map(|line| LineEdit {
                    id: line.product_id,
                    current: products
                        .iter()
                        .find(|product| product.id == line.product_id)
                        .cloned(),
                    quantity: cx.new(|cx| text_input("0", "", cx)),
                })
                .collect();
            form.purchase_order = Some(order);
        }
        let should_review = self
            .document_panel()
            .is_some_and(|panel| match &panel.editor {
                Some(Editor::Receipt(form)) => form.lines.iter().any(|line| line.current.is_none()),
                _ => false,
            });
        if should_review || self.svc.status().connectivity == Connectivity::Online {
            if let Some(panel) = self.document_panel()
                && let Some(Editor::Receipt(form)) = &mut panel.editor
            {
                form.generation = None;
            }
            self.review_document_draft(cx);
        }
    }

    pub(super) fn queue_order_proposal(
        &mut self,
        proposal: PurchaseOrderProposal,
        generation: &str,
        replaces: Option<&str>,
        cx: &mut Context<Self>,
    ) {
        match self.svc.store.queue_inventory_document(
            generation,
            DocumentProposal::PurchaseOrder(proposal),
            replaces,
        ) {
            Ok(()) => {
                if let Some(panel) = self.document_panel() {
                    panel.editor = None;
                    panel.order_conflict = None;
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
                    panel.notice = Some(match error {
                        CoreError::CalendarGenerationChanged
                        | CoreError::CatalogueVersionChanged
                        | CoreError::CatalogueEditPending => Key::InventoryDocumentChanged,
                        _ => Key::InventoryDocumentInvalid,
                    });
                    if matches!(
                        error,
                        CoreError::CalendarGenerationChanged | CoreError::CatalogueVersionChanged
                    ) && let Some(Editor::Receipt(form)) = &mut panel.editor
                    {
                        form.generation = None;
                    }
                }
            }
        }
        cx.notify();
    }

    pub(super) fn confirm_order_transition(&mut self, cx: &mut Context<Self>) {
        let Ok(generation) = self.svc.store.verified_reviewed_generation() else {
            return;
        };
        let Some(panel) = self.document_panel() else {
            return;
        };
        let Some((reviewed, action)) = panel.order_transition.take() else {
            return;
        };
        let Some(order) = &panel.order else {
            return;
        };
        if order.header.id != reviewed.id || order.header.version != reviewed.version {
            panel.notice = Some(Key::InventoryDocumentChanged);
            cx.notify();
            return;
        }
        let PurchaseOrderLink { id, version } = reviewed;
        let replaces = panel
            .order_conflict
            .as_ref()
            .filter(|(_, previous)| {
                previous.id == id
                    && std::mem::discriminant(&previous.action) == std::mem::discriminant(&action)
            })
            .map(|(mutation, _)| mutation.clone());
        self.queue_order_proposal(
            PurchaseOrderProposal {
                id,
                version,
                action,
            },
            &generation,
            replaces.as_deref(),
            cx,
        );
    }
}

pub(super) fn order_status_key(status: PurchaseOrderStatus) -> Key {
    match status {
        PurchaseOrderStatus::Draft => Key::InventoryOrderDraft,
        PurchaseOrderStatus::Ordered => Key::InventoryOrderPlaced,
        PurchaseOrderStatus::PartiallyReceived => Key::InventoryOrderPartial,
        PurchaseOrderStatus::Received => Key::InventoryOrderReceived,
        PurchaseOrderStatus::Cancelled => Key::InventoryOrderCancelled,
    }
}
