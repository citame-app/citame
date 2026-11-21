use super::*;
use crate::inventory::Product;
use crate::inventory_documents::{
    DocumentProposal, RECEIVE_STOCK, Receipt, ReceiptPage, SUPPLIER_SAVE, Supplier, SupplierPage,
};
use crate::purchase_orders::{
    PURCHASE_ORDER_WRITE, PurchaseOrder, PurchaseOrderAction, PurchaseOrderHeader,
    PurchaseOrderPage, PurchaseOrderStatus,
};
use serde::{Serialize, de::DeserializeOwned};
use uuid::Uuid;

impl Store {
    pub fn withdraw_inventory_access(&mut self) -> Result<()> {
        self.write_transaction(|store| {
            Self::apply_inventory_access_at(&store.conn, false)?;
            Self::apply_inventory_read_access_at(&store.conn, false)
        })
    }

    pub fn cache_delivery_review(
        &mut self,
        generation: &str,
        line_ids: &[Uuid],
        products: &[Option<Product>],
        supplier: Option<&crate::inventory_documents::ReviewedDocument<Supplier>>,
    ) -> Result<()> {
        if self.verified_reviewed_generation()? != generation
            || !self.can_queue_product_edits()
            || products.len() != line_ids.len()
            || line_ids.iter().zip(products).any(|(id, product)| {
                product.as_ref().is_some_and(|product| {
                    product.id != *id || product.inventory_generation.as_deref() != Some(generation)
                })
            })
            || supplier.is_some_and(|row| row.generation != generation)
        {
            return Err(CoreError::CalendarGenerationChanged);
        }
        for product in products.iter().flatten() {
            self.remember_reviewed_product(product)?;
        }
        if let Some(supplier) = supplier {
            self.cache_reviewed_supplier(&supplier.value, generation)?;
        }
        Ok(())
    }

    pub fn cache_supplier_page(&mut self, page: &SupplierPage) -> Result<()> {
        self.write_transaction(|store| {
            Self::ensure_generation(&store.conn, Some(&page.generation))?;
            if !store.can_queue_product_edits() {
                return Ok(());
            }
            for supplier in &page.suppliers {
                store.cache_supplier_row(supplier)?;
            }
            Ok(())
        })
    }

    pub fn cache_reviewed_supplier(&mut self, supplier: &Supplier, generation: &str) -> Result<()> {
        self.write_transaction(|store| {
            Self::ensure_generation(&store.conn, Some(generation))?;
            if store.can_queue_product_edits() {
                store.cache_supplier_row(supplier)?;
            }
            Ok(())
        })
    }

    fn cache_supplier_row(&self, supplier: &Supplier) -> Result<()> {
        let key = format!("supplier:{}", supplier.id);
        if self
            .read_inventory_document::<Supplier>(&key)?
            .is_none_or(|current| current.version <= supplier.version)
        {
            Self::set_meta_at(
                &self.conn,
                &format!("inventory_document:{key}"),
                &serde_json::to_string(supplier)?,
            )?;
        }
        Ok(())
    }

    pub fn cached_suppliers(&self) -> Result<Vec<Supplier>> {
        if !self.can_queue_product_edits() {
            return Ok(Vec::new());
        }
        let mut query = self
            .conn
            .prepare("SELECT value FROM meta WHERE key GLOB 'inventory_document:supplier:*'")?;
        let rows = query.query_map([], |row| row.get::<_, String>(0))?;
        let mut suppliers = rows
            .map(|row| Ok(serde_json::from_str::<Supplier>(&row?)?))
            .collect::<Result<Vec<_>>>()?;
        suppliers.sort_by(|left, right| {
            left.fields
                .name
                .cmp(&right.fields.name)
                .then(left.id.cmp(&right.id))
        });
        Ok(suppliers)
    }

    pub fn cache_receipt_page(&mut self, page: &ReceiptPage, generation: &str) -> Result<()> {
        self.cache_inventory_document(&format!("page:{}", page.pagination.page), page, generation)
    }

    pub fn cached_receipt_page(&self, page: u32) -> Result<Option<ReceiptPage>> {
        self.read_inventory_document(&format!("page:{page}"))
    }

    pub fn cache_receipt(&mut self, receipt: &Receipt, generation: &str) -> Result<()> {
        let mut private = receipt.clone();
        for line in &mut private.lines {
            line.unit_cost_cents = None;
        }
        self.cache_inventory_document(
            &format!("receipt:{}", receipt.header.id),
            &private,
            generation,
        )
    }

    pub fn cached_receipt(&self, id: Uuid) -> Result<Option<Receipt>> {
        self.read_inventory_document(&format!("receipt:{id}"))
    }

    fn cache_inventory_document<T: Serialize>(
        &mut self,
        key: &str,
        value: &T,
        generation: &str,
    ) -> Result<()> {
        self.write_transaction(|store| {
            Self::ensure_generation(&store.conn, Some(generation))?;
            if store.can_queue_product_edits() {
                Self::set_meta_at(
                    &store.conn,
                    &format!("inventory_document:{key}"),
                    &serde_json::to_string(value)?,
                )?;
            }
            Ok(())
        })
    }

    fn read_inventory_document<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        if !self.can_queue_product_edits() {
            return Ok(None);
        }
        self.get_meta(&format!("inventory_document:{key}"))?
            .map(|value| Ok(serde_json::from_str(&value)?))
            .transpose()
    }

    pub(super) fn apply_inventory_read_access_at(conn: &Connection, granted: bool) -> Result<()> {
        if granted {
            Self::set_meta_at(conn, "inventory_read_access", &Self::generation_at(conn)?)?;
        } else {
            conn.execute("DELETE FROM meta WHERE key = 'inventory_read_access' OR key GLOB 'purchase_order:*'", [])?;
        }
        Ok(())
    }

    pub fn can_read_cached_orders(&self) -> bool {
        self.verified_reviewed_generation()
            .ok()
            .is_some_and(|generation| {
                self.get_meta("inventory_read_access")
                    .ok()
                    .flatten()
                    .as_ref()
                    == Some(&generation)
            })
            || self.can_queue_product_edits()
    }

    pub fn cache_purchase_order_page(&mut self, page: &PurchaseOrderPage) -> Result<()> {
        self.write_transaction(|store| {
            Self::ensure_generation(&store.conn, Some(&page.generation))?;
            if store.can_read_cached_orders() {
                for order in &page.orders {
                    store.cache_purchase_order_header(order)?;
                }
            }
            Ok(())
        })
    }

    fn cache_purchase_order_header(&self, header: &PurchaseOrderHeader) -> Result<()> {
        let key = format!("purchase_order:header:{}", header.id);
        let current = self
            .get_meta(&key)?
            .map(|value| serde_json::from_str::<PurchaseOrderHeader>(&value))
            .transpose()?;
        if current.is_none_or(|current| current.version <= header.version) {
            Self::set_meta_at(&self.conn, &key, &serde_json::to_string(header)?)?;
        }
        Ok(())
    }

    pub fn cached_purchase_orders(
        &self,
        search: &str,
        status: Option<PurchaseOrderStatus>,
        page: u32,
    ) -> Result<Option<PurchaseOrderPage>> {
        if !self.can_read_cached_orders() {
            return Ok(None);
        }
        let term = search.trim().to_lowercase();
        let number = term.trim_start_matches('#').parse::<u32>().ok();
        let mut statement = self
            .conn
            .prepare("SELECT value FROM meta WHERE key GLOB 'purchase_order:header:*'")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut orders = Vec::new();
        for row in rows {
            let header: PurchaseOrderHeader = serde_json::from_str(&row?)?;
            if status.is_none_or(|status| header.status == status)
                && (header.supplier_name.to_lowercase().contains(&term)
                    || header
                        .supplier_reference
                        .as_ref()
                        .is_some_and(|value| value.to_lowercase().contains(&term))
                    || Some(header.number) == number)
            {
                orders.push(header);
            }
        }
        orders.sort_by_key(|order| std::cmp::Reverse(order.number));
        let total = orders.len() as u64;
        let page_size = 20;
        let page = page.max(1);
        Ok(Some(PurchaseOrderPage {
            orders: orders
                .into_iter()
                .skip(page.saturating_sub(1).saturating_mul(page_size) as usize)
                .take(page_size as usize)
                .collect(),
            pagination: crate::inventory::Pagination {
                page,
                page_size,
                total,
            },
            generation: self.verified_reviewed_generation()?,
        }))
    }

    pub fn cache_purchase_order(&mut self, order: &PurchaseOrder, generation: &str) -> Result<()> {
        self.write_transaction(|store| {
            Self::ensure_generation(&store.conn, Some(generation))?;
            if store.can_read_cached_orders() {
                store.cache_purchase_order_header(&order.header)?;
                let key = format!("purchase_order:detail:{}", order.header.id);
                if store
                    .cached_purchase_order(order.header.id)?
                    .is_none_or(|current| current.header.version <= order.header.version)
                {
                    Self::set_meta_at(&store.conn, &key, &serde_json::to_string(order)?)?;
                }
            }
            Ok(())
        })
    }

    pub fn cached_purchase_order(&self, id: Uuid) -> Result<Option<PurchaseOrder>> {
        if !self.can_read_cached_orders() {
            return Ok(None);
        }
        self.get_meta(&format!("purchase_order:detail:{id}"))?
            .map(|value| Ok(serde_json::from_str(&value)?))
            .transpose()
    }

    pub fn pending_inventory_documents(&self) -> Result<Vec<DocumentProposal>> {
        if !self.can_queue_product_edits() {
            return Ok(Vec::new());
        }
        let mut query = self
            .conn
            .prepare("SELECT kind, payload FROM outbox WHERE kind IN (?1, ?2, ?3) ORDER BY seq")?;
        let rows = query.query_map(
            params![SUPPLIER_SAVE, RECEIVE_STOCK, PURCHASE_ORDER_WRITE],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?;
        rows.map(|row| {
            let (kind, payload) = row?;
            DocumentProposal::from_payload(&kind, serde_json::from_str(&payload)?)
        })
        .collect()
    }

    pub fn inventory_document_conflict(
        &self,
        mutation_id: &str,
    ) -> Result<Option<DocumentProposal>> {
        if !self.can_queue_product_edits() {
            return Ok(None);
        }
        self.conflict(mutation_id)?
            .filter(|row| {
                matches!(
                    row.kind.as_str(),
                    SUPPLIER_SAVE | RECEIVE_STOCK | PURCHASE_ORDER_WRITE
                )
            })
            .map(|row| DocumentProposal::from_payload(&row.kind, row.payload))
            .transpose()
    }

    pub fn has_pending_purchase_order(&self, id: Uuid) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM outbox WHERE (kind = ?1 AND entity_id = ?3) OR (kind = ?2 AND json_extract(payload, '$.purchaseOrder.id') = ?3))",
            params![PURCHASE_ORDER_WRITE, RECEIVE_STOCK, id.to_string()],
            |row| row.get(0),
        )?)
    }

    pub fn queue_inventory_document(
        &mut self,
        generation: &str,
        proposal: DocumentProposal,
        replaces: Option<&str>,
    ) -> Result<()> {
        let kind = proposal.kind();
        let id = proposal.id().to_string();
        let payload = proposal.clone().payload()?;
        let order_id = match &proposal {
            DocumentProposal::PurchaseOrder(order) => Some(order.id),
            DocumentProposal::Receipt(receipt) => receipt.purchase_order.map(|order| order.id),
            DocumentProposal::Supplier(_) => None,
        };
        self.write_transaction(|store| {
            if store.verified_reviewed_generation()? != generation
                || !store.can_queue_product_edits()
            {
                return Err(CoreError::CalendarGenerationChanged);
            }
            if let Some(order_id) = order_id
                && store.has_pending_purchase_order(order_id)?
            {
                return Err(CoreError::CatalogueEditPending);
            }
            if store.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM outbox WHERE kind = ?1 AND entity_id = ?2)",
                params![kind, id],
                |row| row.get::<_, bool>(0),
            )? {
                return Err(CoreError::CatalogueEditPending);
            }
            if let Some(previous) = replaces {
                store
                    .conflict(previous)?
                    .filter(|row| row.kind == kind && row.entity_id == id)
                    .filter(|row| {
                        kind != PURCHASE_ORDER_WRITE
                            || row.payload.get("action") == payload.get("action")
                    })
                    .ok_or_else(|| CoreError::NotFound("inventory document proposal".into()))?;
            }
            match proposal {
                DocumentProposal::Supplier(supplier) => {
                    let current: Option<Supplier> =
                        store.read_inventory_document(&format!("supplier:{id}"))?;
                    if supplier.version != current.as_ref().map_or(0, |supplier| supplier.version) {
                        return Err(CoreError::CatalogueVersionChanged);
                    }
                }
                DocumentProposal::PurchaseOrder(proposal) => {
                    let current = store.cached_purchase_order(proposal.id)?;
                    if proposal.version != current.as_ref().map_or(0, |order| order.header.version)
                    {
                        return Err(CoreError::CatalogueVersionChanged);
                    }
                    let status = current.as_ref().map(|order| order.header.status);
                    match proposal.action {
                        PurchaseOrderAction::Save(fields) => {
                            let products = store.reviewed_products()?;
                            let supplier = store.read_inventory_document::<Supplier>(&format!(
                                "supplier:{}",
                                fields.supplier_id
                            ))?;
                            let supplier_ok = supplier.as_ref().map_or_else(
                                || {
                                    current.as_ref().is_some_and(|order| {
                                        order.header.supplier_id == fields.supplier_id
                                    })
                                },
                                |supplier| supplier.fields.active,
                            );
                            let products_ok = fields.lines.iter().all(|line| {
                                products
                                    .iter()
                                    .find(|product| product.id == line.product_id)
                                    .map_or_else(
                                        || {
                                            current.as_ref().is_some_and(|order| {
                                                order
                                                    .lines
                                                    .iter()
                                                    .any(|item| item.product_id == line.product_id)
                                            })
                                        },
                                        |product| {
                                            product.active
                                                && product.can_manage
                                                && product.inventory_generation.as_deref()
                                                    == Some(generation)
                                        },
                                    )
                            });
                            if status.is_some_and(|status| status != PurchaseOrderStatus::Draft)
                                || !supplier_ok
                                || !products_ok
                            {
                                return Err(CoreError::CatalogueVersionChanged);
                            }
                        }
                        PurchaseOrderAction::Order
                            if status == Some(PurchaseOrderStatus::Draft) => {}
                        PurchaseOrderAction::Cancel
                            if status.is_some_and(PurchaseOrderStatus::allows_cancel) => {}
                        _ => return Err(CoreError::CatalogueVersionChanged),
                    }
                }
                DocumentProposal::Receipt(receipt) => {
                    let timezone = store
                        .salon_settings()?
                        .map(|row| row.timezone.parse::<chrono_tz::Tz>())
                        .and_then(std::result::Result::ok)
                        .ok_or_else(|| {
                            CoreError::Invalid("Inventory timezone needs review".into())
                        })?;
                    if receipt.received_on.trim()
                        > chrono::Utc::now()
                            .with_timezone(&timezone)
                            .date_naive()
                            .to_string()
                            .as_str()
                    {
                        return Err(CoreError::Invalid(
                            "The delivery date cannot be in the future".into(),
                        ));
                    }
                    let products = store.reviewed_products()?;
                    let valid = receipt.lines.iter().all(|line| {
                        products.iter().any(|product| {
                            line.matches_review(
                                product,
                                generation,
                                receipt.purchase_order.is_some(),
                            )
                        })
                    });
                    if !valid {
                        return Err(CoreError::CatalogueVersionChanged);
                    }
                    if let Some(link) = receipt.purchase_order {
                        let current = store.cached_purchase_order(link.id)?;
                        if !current.is_some_and(|order| {
                            order.header.version == link.version
                                && Some(order.header.supplier_id) == receipt.supplier_id
                                && order.header.status.allows_delivery()
                                && receipt.lines.iter().all(|line| {
                                    order.lines.iter().any(|ordered| {
                                        ordered.product_id == line.product_id
                                            && ordered.remaining() >= line.quantity
                                    })
                                })
                        }) {
                            return Err(CoreError::CatalogueVersionChanged);
                        }
                    } else if let Some(supplier) = receipt.supplier_id
                        && !store
                            .read_inventory_document::<Supplier>(&format!("supplier:{supplier}"))?
                            .is_some_and(|row| row.fields.active)
                    {
                        return Err(CoreError::CatalogueVersionChanged);
                    }
                }
            }
            store.enqueue(kind, &id, payload)?;
            if let Some(previous) = replaces {
                store.resolve_conflict(previous, "resubmitted")?;
            }
            Ok(())
        })
    }

    pub fn finish_inventory_receipt_review(
        &mut self,
        mutation_id: &str,
        receipt: &Receipt,
        generation: &str,
    ) -> Result<()> {
        self.write_transaction(|store| {
            Self::ensure_generation(&store.conn, Some(generation))?;
            match store.inventory_document_conflict(mutation_id)? {
                Some(DocumentProposal::Receipt(draft)) if draft.id == receipt.header.id => {
                    store.resolve_conflict(mutation_id, "recorded")
                }
                _ => Err(CoreError::NotFound("stock receipt proposal".into())),
            }
        })
    }
}
