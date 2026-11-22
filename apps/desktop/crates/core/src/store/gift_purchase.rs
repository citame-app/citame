use super::*;
use crate::{http::gift_cards::GiftPurchase, sync::TransportError};

impl Store {
    pub fn pending_gift_purchase(&self, actor: &str) -> Result<Option<GiftPurchase>> {
        self.get_meta(&format!("gift_purchase_pending:{actor}"))?
            .map(|value| {
                let (generation, mut purchase): (String, GiftPurchase) =
                    serde_json::from_str(&value)?;
                purchase.generation = generation;
                Ok(purchase)
            })
            .transpose()
    }

    pub fn reserve_gift_purchase(&self, actor: &str, purchase: &GiftPurchase) -> Result<bool> {
        let key = format!("gift_purchase_pending:{actor}");
        Ok(self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING",
            params![
                key,
                serde_json::to_string(&(&purchase.generation, purchase))?
            ],
        )? == 1)
    }

    pub fn settle_gift_purchase(
        &self,
        actor: &str,
        purchase: &GiftPurchase,
        result: std::result::Result<(), &TransportError>,
    ) -> Result<bool> {
        if !matches!(result, Ok(()) | Err(TransportError::BadRequest(_))) {
            return Ok(false);
        }
        self.clear_gift_purchase(actor, purchase)?;
        Ok(true)
    }

    pub fn clear_gift_purchase(&self, actor: &str, purchase: &GiftPurchase) -> Result<()> {
        self.conn.execute(
            "DELETE FROM meta WHERE key = ?1 AND value = ?2",
            params![
                format!("gift_purchase_pending:{actor}"),
                serde_json::to_string(&(&purchase.generation, purchase))?
            ],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gift_purchase_survives_a_restart_and_clears_only_the_exact_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("replica.db");
        let purchase = GiftPurchase {
            amount_cents: 3500,
            purchase_price_cents: Some(2700),
            label: "Synthetic gift".into(),
            buyer_client_id: None,
            expires_at: None,
            idempotency_key: uuid::Uuid::now_v7(),
            generation: "reviewed".into(),
        };
        let store = Store::open(&database).unwrap();
        assert!(store.reserve_gift_purchase("owner", &purchase).unwrap());
        let mut other = purchase.clone();
        other.idempotency_key = uuid::Uuid::now_v7();
        assert!(!store.reserve_gift_purchase("owner", &other).unwrap());
        drop(store);

        let store = Store::open(&database).unwrap();
        assert!(
            store
                .pending_gift_purchase("other-owner")
                .unwrap()
                .is_none()
        );
        store.clear_gift_purchase("owner", &other).unwrap();
        let reopened = store.pending_gift_purchase("owner").unwrap().unwrap();
        assert_eq!(reopened.idempotency_key, purchase.idempotency_key);
        assert_eq!(reopened.generation, "reviewed");
        assert_eq!(reopened.price_cents(), 2700);
        assert_eq!(reopened.amount_cents, 3500);
        let timeout = TransportError::Offline("timed out".into());
        assert!(
            !store
                .settle_gift_purchase("owner", &reopened, Err(&timeout))
                .unwrap()
        );
        assert!(store.pending_gift_purchase("owner").unwrap().is_some());
        assert!(
            store
                .settle_gift_purchase("owner", &reopened, Ok(()))
                .unwrap()
        );
        assert!(store.pending_gift_purchase("owner").unwrap().is_none());
    }
}
