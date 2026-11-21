use super::*;
use crate::inventory_documents::{
    DeliveryReview, DeliveryReviewRequest, Receipt, ReceiptPage, ReviewedDocument, Supplier,
    SupplierPage,
};
use crate::purchase_orders::{PurchaseOrder, PurchaseOrderPage, PurchaseOrderStatus};
use url::form_urlencoded;
use uuid::Uuid;

impl HttpTransport {
    pub fn review_delivery(
        &self,
        draft: &DeliveryReviewRequest,
    ) -> Result<DeliveryReview, TransportError> {
        if let Some(document) = self.inventory_receipt(draft.id)? {
            return Ok(DeliveryReview::Recorded(document));
        }
        let supplier = match draft.supplier_id {
            Some(id) => self.inventory_supplier(id)?,
            None => None,
        };
        let products = draft
            .product_ids
            .iter()
            .map(|id| self.lookup_inventory_product(*id))
            .collect::<Result<_, _>>()?;
        let order = match draft.purchase_order {
            Some(link) => self.inventory_purchase_order(link.id)?.map(Box::new),
            None => None,
        };
        let warehouses = draft
            .warehouse_id
            .map(|_| self.inventory_warehouses())
            .transpose()?;
        Ok(DeliveryReview::Current {
            products,
            supplier,
            order,
            warehouses,
        })
    }

    pub fn review_supplier(
        &self,
        id: Uuid,
    ) -> Result<ReviewedDocument<Option<Supplier>>, TransportError> {
        match self.inventory_supplier(id)? {
            Some(reviewed) => Ok(ReviewedDocument {
                generation: reviewed.generation,
                value: Some(reviewed.value),
            }),
            None => Ok(ReviewedDocument {
                generation: self.inventory_suppliers("", None, 1)?.generation,
                value: None,
            }),
        }
    }
    pub fn inventory_suppliers(
        &self,
        search: &str,
        active: Option<bool>,
        page: u32,
    ) -> Result<SupplierPage, TransportError> {
        let mut query = form_urlencoded::Serializer::new(String::new());
        query
            .append_pair("search", search)
            .append_pair("page", &page.to_string());
        if let Some(active) = active {
            query.append_pair("active", if active { "true" } else { "false" });
        }
        let result: SupplierPage = read_response(
            self.get(
                &self.agent,
                &format!("/admin/inventory/suppliers?{}", query.finish()),
                None,
            )?,
            false,
        )?;
        if result.pagination.page != page {
            return Err(TransportError::Server("Unexpected supplier page".into()));
        }
        Ok(result)
    }

    pub fn inventory_supplier(
        &self,
        id: Uuid,
    ) -> Result<Option<ReviewedDocument<Supplier>>, TransportError> {
        self.read_inventory_document(
            &format!("/admin/inventory/suppliers/{id}"),
            id,
            |row: &Supplier| row.id,
        )
    }

    pub fn inventory_receipts(
        &self,
        page: u32,
    ) -> Result<ReviewedDocument<ReceiptPage>, TransportError> {
        let result: ReviewedDocument<ReceiptPage> = read_response(
            self.get(
                &self.agent,
                &format!("/admin/inventory/receipts?page={page}"),
                None,
            )?,
            false,
        )?;
        if result.value.pagination.page != page {
            return Err(TransportError::Server("Unexpected receipt page".into()));
        }
        Ok(result)
    }

    pub fn inventory_receipt(
        &self,
        id: Uuid,
    ) -> Result<Option<ReviewedDocument<Receipt>>, TransportError> {
        self.read_inventory_document(
            &format!("/admin/inventory/receipts/{id}"),
            id,
            |row: &Receipt| row.header.id,
        )
    }

    pub fn inventory_purchase_orders(
        &self,
        search: &str,
        status: Option<PurchaseOrderStatus>,
        page: u32,
    ) -> Result<PurchaseOrderPage, TransportError> {
        let mut query = form_urlencoded::Serializer::new(String::new());
        query
            .append_pair("search", search)
            .append_pair("page", &page.to_string());
        if let Some(status) = status {
            query.append_pair("status", status.query_value());
        }
        let result: PurchaseOrderPage = read_response(
            self.get(
                &self.agent,
                &format!("/admin/inventory/orders?{}", query.finish()),
                None,
            )?,
            false,
        )?;
        if result.pagination.page != page {
            return Err(TransportError::Server(
                "Unexpected purchase order page".into(),
            ));
        }
        Ok(result)
    }

    pub fn inventory_purchase_order(
        &self,
        id: Uuid,
    ) -> Result<Option<ReviewedDocument<PurchaseOrder>>, TransportError> {
        self.read_inventory_document(
            &format!("/admin/inventory/orders/{id}"),
            id,
            |row: &PurchaseOrder| row.header.id,
        )
    }

    fn read_inventory_document<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        id: Uuid,
        identify: impl FnOnce(&T) -> Uuid,
    ) -> Result<Option<ReviewedDocument<T>>, TransportError> {
        let response = self.get(&self.agent, path, None)?;
        if response.status().as_u16() == 404 {
            return Ok(None);
        }
        let document: ReviewedDocument<T> = read_response(response, false)?;
        if identify(&document.value) != id {
            return Err(TransportError::Server(
                "Unexpected inventory document".into(),
            ));
        }
        Ok(Some(document))
    }
}
