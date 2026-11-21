use super::*;
use sob_core::http::HttpTransport;
use sob_core::warehouses::{RecordedWarehouseTransfer, SAVE, TRANSFER};

enum Proposal {
    Location(WarehouseEdit),
    Transfer(WarehouseTransfer),
}

struct Review {
    list: WarehouseList,
    balances: Vec<WarehouseStock>,
    recorded: Option<RecordedWarehouseTransfer>,
}

impl Proposal {
    fn load(&self, transport: &HttpTransport) -> Result<Review, TransportError> {
        let list = transport.inventory_warehouses()?;
        let (recorded, balances) = match self {
            Self::Location(_) => (None, Vec::new()),
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
                (recorded, balances)
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
    pub(in crate::root) fn open_warehouse_conflict(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.svc.status().connectivity == Connectivity::Online)
        else {
            return;
        };
        let Some(conflict) = self.svc.store.conflict(id).ok().flatten() else {
            return;
        };
        if !self.svc.store.can_queue_product_edits() {
            return;
        }
        let proposal = match conflict.kind.as_str() {
            SAVE => serde_json::from_value(conflict.payload)
                .ok()
                .map(Proposal::Location),
            TRANSFER => serde_json::from_value(conflict.payload)
                .ok()
                .map(Proposal::Transfer),
            _ => None,
        };
        let Some(proposal) = proposal else { return };
        let id = id.to_owned();
        let staff = self
            .svc
            .store
            .staff_directory_revision()
            .unwrap_or_default();
        let session = self.svc.session.clone();
        self.prepare_inventory(cx);
        self.prepare_warehouse_panel(cx);
        let token = Arc::new(());
        if let Some(panel) = self.warehouse_panel() {
            panel.request = Some(token.clone());
            panel.observed_staff = staff;
            panel.replaces = Some(id.clone());
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
                    panel.replaces = None;
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
                    && root.svc.store.can_queue_product_edits()
                    && let Ok(review) = result
                    && root
                        .svc
                        .store
                        .cache_warehouse_review(&review.list, &review.balances)
                        .is_ok()
                {
                    root.apply_warehouse_review(id, proposal, review, cx);
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
        id: String,
        proposal: Proposal,
        review: Review,
        cx: &mut Context<Self>,
    ) {
        let generation = review.list.generation.clone();
        if let Some(recorded) = review.recorded {
            let result =
                self.svc
                    .store
                    .finish_warehouse_transfer_review(&generation, &id, &recorded);
            self.reload(cx);
            if let Some(panel) = self.warehouse_panel() {
                panel.notice = Some(if result.is_ok() {
                    Key::InventoryWarehouseRecorded
                } else {
                    Key::InventoryWarehouseChanged
                });
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
        panel.replaces = Some(id);
        panel.notice = Some(Key::InventoryWarehouseReviewPrompt);
    }
}
