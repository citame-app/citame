use super::*;
use sob_core::http::HttpTransport;
use sob_core::warehouses::{ADJUST, RecordedAdjustment, SAVE, TRANSFER};

pub(super) enum Proposal {
    Location(WarehouseEdit),
    Adjustment(WarehouseAdjustment),
    Transfer(WarehouseTransfer),
}

enum RecordedChange {
    Transfer(RecordedWarehouseTransfer),
    Adjustment(RecordedAdjustment),
}

struct Review {
    list: WarehouseList,
    balances: Vec<WarehouseStock>,
    recorded: Option<RecordedChange>,
}

impl Proposal {
    pub(super) fn from_draft(draft: &Draft, cx: &App) -> Option<Self> {
        match draft {
            Draft::Adjustment(form) => form.proposal(cx).map(Self::Adjustment),
            Draft::Location { warehouse, name } => {
                let mut edit = warehouse.clone();
                edit.name = name.read(cx).text().to_owned();
                Some(Self::Location(edit))
            }
            Draft::Transfer {
                id,
                source,
                destination,
                reason,
                lines,
            } => {
                let lines = lines
                    .iter()
                    .map(|line| {
                        Some(TransferLine {
                            product_id: line.balance.product_id,
                            version: line.balance.version,
                            quantity: line.quantity.read(cx).text().trim().parse().ok()?,
                        })
                    })
                    .collect::<Option<Vec<_>>>()?;
                Some(Self::Transfer(WarehouseTransfer {
                    id: *id,
                    source_id: *source,
                    destination_id: (*destination)?,
                    reason: reason.read(cx).text().to_owned(),
                    lines,
                }))
            }
        }
    }

    fn load(&self, transport: &HttpTransport) -> Result<Review, TransportError> {
        let list = transport.inventory_warehouses()?;
        let (recorded, balances) = match self {
            Self::Location(_) => (None, Vec::new()),
            Self::Adjustment(adjustment) => {
                let recorded = transport.inventory_recorded_adjustment(adjustment.id)?;
                let balances = if recorded.is_some() {
                    Vec::new()
                } else {
                    vec![
                        transport
                            .warehouse_product(adjustment.warehouse_id.0, adjustment.product_id)?,
                    ]
                };
                (recorded.map(RecordedChange::Adjustment), balances)
            }
            Self::Transfer(transfer) => {
                let recorded = transport.inventory_recorded_transfer(transfer.id)?;
                let balances = if recorded.is_some() {
                    Vec::new()
                } else {
                    transfer
                        .lines
                        .iter()
                        .map(|line| {
                            transport.warehouse_product(transfer.source_id, line.product_id)
                        })
                        .collect::<Result<_, _>>()?
                };
                (recorded.map(RecordedChange::Transfer), balances)
            }
        };
        Ok(Review {
            list,
            balances,
            recorded,
        })
    }
}

impl Root {
    pub(in crate::root::inventory) fn open_warehouse_transfer(
        &mut self,
        id: Uuid,
        cx: &mut Context<Self>,
    ) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            return;
        };
        let session = self.svc.session.clone();
        let staff = self
            .svc
            .store
            .staff_directory_revision()
            .unwrap_or_default();
        self.prepare_warehouse_panel(cx);
        let token = Arc::new(());
        let Some(panel) = self.warehouse_panel() else {
            return;
        };
        panel.transfer_record = Some((id, None));
        panel.observed_staff = staff;
        panel.request = Some(token.clone());
        cx.notify();
        cx.spawn(async move |handle, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { transport.inventory_recorded_transfer(id) })
                .await;
            let _ = handle.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session)
                    || !root.warehouse_panel().is_some_and(|panel| {
                        panel
                            .request
                            .as_ref()
                            .is_some_and(|request| Arc::ptr_eq(request, &token))
                    })
                {
                    return;
                }
                if matches!(
                    result,
                    Err(TransportError::Forbidden(_) | TransportError::Unauthorized)
                ) {
                    let _ = root.svc.store.withdraw_inventory_access();
                }
                let record = result.ok().flatten().filter(|_| {
                    root.svc.store.can_read_cached_orders()
                        && root
                            .svc
                            .store
                            .staff_directory_revision()
                            .unwrap_or_default()
                            == staff
                });
                if let Some(panel) = root.warehouse_panel() {
                    panel.request = None;
                    if record.is_none() {
                        panel.notice = Some(Key::InventoryWarehouseUnavailable);
                    }
                    panel.transfer_record = Some((id, record));
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub(in crate::root) fn open_warehouse_conflict(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.status.connectivity != Connectivity::Online {
            return;
        }
        let Some(conflict) = self.svc.store.conflict(id).ok().flatten() else {
            return;
        };
        if !self.svc.store.can_read_cached_orders() {
            return;
        }
        let proposal = match conflict.kind.as_str() {
            ADJUST => serde_json::from_value(conflict.payload)
                .ok()
                .map(Proposal::Adjustment),
            SAVE => serde_json::from_value(conflict.payload)
                .ok()
                .map(Proposal::Location),
            TRANSFER => serde_json::from_value(conflict.payload)
                .ok()
                .map(Proposal::Transfer),
            _ => None,
        };
        let Some(proposal) = proposal else { return };
        self.prepare_inventory(cx);
        self.prepare_warehouse_panel(cx);
        self.review_warehouse_proposal(Some(id.to_owned()), proposal, cx);
    }

    pub(super) fn review_warehouse_draft(&mut self, cx: &mut Context<Self>) {
        let Some(panel) = self.warehouse_panel() else {
            return;
        };
        let Some(proposal) = panel
            .draft
            .as_ref()
            .and_then(|draft| Proposal::from_draft(draft, cx))
        else {
            panel.notice = Some(Key::InventoryWarehouseInvalid);
            cx.notify();
            return;
        };
        let replaces = panel.replaces.clone();
        self.review_warehouse_proposal(replaces, proposal, cx);
    }

    fn review_warehouse_proposal(
        &mut self,
        replaces: Option<String>,
        proposal: Proposal,
        cx: &mut Context<Self>,
    ) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.svc.status().connectivity == Connectivity::Online)
        else {
            return;
        };
        let staff = self
            .svc
            .store
            .staff_directory_revision()
            .unwrap_or_default();
        let session = self.svc.session.clone();
        let token = Arc::new(());
        if let Some(panel) = self.warehouse_panel() {
            panel.request = Some(token.clone());
            panel.observed_staff = staff;
        }
        cx.notify();
        cx.spawn(async move |handle, cx| {
            let (proposal, result) = cx
                .background_executor()
                .spawn(async move {
                    let result = proposal.load(&transport);
                    (proposal, result)
                })
                .await;
            let _ = handle.update(cx, |root, cx| {
                if !Arc::ptr_eq(&root.svc.session, &session)
                    || !root.warehouse_panel().is_some_and(|panel| {
                        panel
                            .request
                            .as_ref()
                            .is_some_and(|request| Arc::ptr_eq(request, &token))
                    })
                {
                    return;
                }
                if let Some(panel) = root.warehouse_panel() {
                    panel.request = None;
                }
                if matches!(
                    result,
                    Err(TransportError::Forbidden(_) | TransportError::Unauthorized)
                ) {
                    let _ = root.svc.store.withdraw_inventory_access();
                }
                if root
                    .svc
                    .store
                    .staff_directory_revision()
                    .unwrap_or_default()
                    == staff
                    && root.svc.store.can_read_cached_orders()
                    && let Ok(review) = result
                    && root
                        .svc
                        .store
                        .cache_warehouse_review(&review.list, &review.balances)
                        .is_ok()
                {
                    root.apply_warehouse_review(replaces, proposal, review, cx);
                } else if let Some(panel) = root.warehouse_panel() {
                    panel.notice = Some(Key::InventoryWarehouseUnavailable);
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn apply_warehouse_review(
        &mut self,
        replaces: Option<String>,
        proposal: Proposal,
        review: Review,
        cx: &mut Context<Self>,
    ) {
        let generation = review.list.generation.clone();
        if let Some(recorded) = review.recorded {
            let (confirmed, notice) = match (recorded, proposal) {
                (RecordedChange::Transfer(recorded), Proposal::Transfer(transfer)) => {
                    let confirmed = match replaces.as_deref() {
                        Some(id) => self
                            .svc
                            .store
                            .finish_warehouse_transfer_review(&generation, id, &recorded)
                            .is_ok(),
                        None => recorded.matches(&transfer),
                    };
                    (confirmed, Key::InventoryWarehouseRecorded)
                }
                (RecordedChange::Adjustment(recorded), Proposal::Adjustment(adjustment)) => {
                    let confirmed = match replaces.as_deref() {
                        Some(id) => self
                            .svc
                            .store
                            .finish_warehouse_adjustment_review(&generation, id, &recorded)
                            .is_ok(),
                        None => adjustment.matches(&recorded),
                    };
                    (confirmed, Key::InventoryWarehouseAdjustRecorded)
                }
                _ => (false, Key::InventoryWarehouseChanged),
            };
            self.reload(cx);
            if let Some(panel) = self.warehouse_panel() {
                panel.notice = Some(if confirmed {
                    notice
                } else {
                    Key::InventoryWarehouseChanged
                });
                if confirmed {
                    panel.draft = None;
                    panel.replaces = None;
                    panel.generation = None;
                }
            }
            return;
        }
        if !self.svc.store.can_queue_product_edits() {
            if let Some(panel) = self.warehouse_panel() {
                panel.notice = Some(Key::InventoryRestricted);
            }
            return;
        }
        let name_label = self.t(Key::InventoryWarehouseName);
        let reason_label = self.t(Key::InventoryWarehouseReason);
        let quantity_label = self.t(Key::InventoryStockQuantity);
        let Some(panel) = self.warehouse_panel() else {
            return;
        };
        let draft = match proposal {
            Proposal::Adjustment(adjustment) => {
                let Some(balance) = review
                    .balances
                    .iter()
                    .flat_map(|page| &page.products)
                    .find(|balance| balance.product_id == adjustment.product_id)
                else {
                    panel.notice = Some(Key::InventoryWarehouseChanged);
                    return;
                };
                panel.query.location = adjustment.warehouse_id.0;
                Draft::Adjustment(AdjustmentEditor::reviewed(adjustment, balance.clone(), cx))
            }
            Proposal::Location(mut edit) => {
                edit.version = review
                    .list
                    .warehouses
                    .iter()
                    .find(|row| row.id == Some(edit.id))
                    .map_or(0, |row| row.version);
                let name = cx.new(|cx| TextField::new(name_label, false, cx));
                name.update(cx, |input, cx| input.set_text(&edit.name, cx));
                Draft::Location {
                    warehouse: edit,
                    name,
                }
            }
            Proposal::Transfer(transfer) => {
                let reason = cx.new(|cx| TextField::new(reason_label, false, cx));
                reason.update(cx, |input, cx| input.set_text(&transfer.reason, cx));
                let mut lines = Vec::with_capacity(transfer.lines.len());
                for line in transfer.lines {
                    let Some(balance) = review
                        .balances
                        .iter()
                        .flat_map(|page| &page.products)
                        .find(|row| row.product_id == line.product_id)
                    else {
                        panel.notice = Some(Key::InventoryWarehouseChanged);
                        return;
                    };
                    let quantity = cx.new(|cx| TextField::new(quantity_label, false, cx));
                    quantity.update(cx, |input, cx| {
                        input.set_text(&line.quantity.to_string(), cx)
                    });
                    lines.push(PickedLine {
                        balance: balance.clone(),
                        quantity,
                    });
                }
                panel.query.location = transfer.source_id;
                Draft::Transfer {
                    id: transfer.id,
                    source: transfer.source_id,
                    destination: Some(transfer.destination_id),
                    reason,
                    lines,
                }
            }
        };
        panel.locations = Some(review.list);
        panel.draft = Some(draft);
        panel.generation = Some(generation);
        panel.replaces = replaces;
        panel.notice = Some(Key::InventoryWarehouseReviewPrompt);
    }
}
