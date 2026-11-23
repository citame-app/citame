use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};
use crate::model::{Service, ServiceOption, ServiceStaff, Staff};
use std::collections::{BTreeMap, BTreeSet};

pub const CREATE: &str = "combination.create";
pub const UPDATE: &str = "combination.update";
pub(crate) const CACHE: &str = "service_combinations_with_fixed_terms";
pub const LIMIT: usize = 100;
pub const MAX_SERVICES: usize = 24;
pub const MAX_FIXED_STAFF: usize = 100;
pub const MAX_FIXED_PRICE_CENTS: u32 = 999_999_999;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedCombinationTerms {
    pub prices_cents: Vec<u32>,
    pub staff_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub online_booking: Option<bool>,
}

impl FixedCombinationTerms {
    pub fn can_remove(&self, active: bool) -> bool {
        !active || self.online_booking != Some(false)
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CombinationDraft {
    pub name: String,
    pub description: Option<String>,
    pub service_ids: Vec<String>,
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixed_terms: Option<FixedCombinationTerms>,
}

impl CombinationDraft {
    pub fn lacked_fixed_terms(&self, current: &Self) -> bool {
        self.fixed_terms.is_none() && current.fixed_terms.is_some()
    }

    pub fn normalized(mut self) -> Self {
        self.name = crate::trim_like_javascript(&self.name).into();
        self.description = self
            .description
            .map(|value| crate::trim_like_javascript(&value).to_owned())
            .filter(|value| !value.is_empty());
        self
    }

    pub(crate) fn validate(&self) -> Result<()> {
        if !(1..=120).contains(&self.name.encode_utf16().count())
            || self.name.chars().any(char::is_control)
            || self.description.as_ref().is_some_and(|description| {
                description.encode_utf16().count() > 1000
                    || description
                        .chars()
                        .any(|c| matches!(c, '\x00'..='\x08' | '\x0b' | '\x0c' | '\x0e'..='\x1f' | '\x7f'))
            })
            || !(2..=MAX_SERVICES).contains(&self.service_ids.len())
            || self
                .service_ids
                .iter()
                .any(|id| uuid::Uuid::parse_str(id).is_err())
            || self
                .service_ids
                .iter()
                .collect::<BTreeSet<_>>()
                .len()
                != self.service_ids.len()
        {
            return Err(CoreError::Invalid("Review the combination name, description and services".into()));
        }
        if let Some(terms) = &self.fixed_terms
            && (terms.prices_cents.len() != self.service_ids.len()
                || terms
                    .prices_cents
                    .iter()
                    .map(|cents| u64::from(*cents))
                    .sum::<u64>()
                    > u64::from(MAX_FIXED_PRICE_CENTS)
                || !(1..=MAX_FIXED_STAFF).contains(&terms.staff_ids.len())
                || terms
                    .staff_ids
                    .iter()
                    .map(|id| uuid::Uuid::parse_str(id))
                    .collect::<std::result::Result<BTreeSet<_>, _>>()
                    .map_or(true, |ids| ids.len() != terms.staff_ids.len()))
        {
            return Err(CoreError::Invalid(
                "Review the fixed prices, professionals and visibility".into(),
            ));
        }
        Ok(())
    }

    pub fn rebase(&self, reviewed: &Self, current: &Self, keep_overlaps: bool) -> Self {
        fn choose<T: Eq>(proposal: T, reviewed: T, current: T, keep: bool) -> T {
            if proposal != reviewed && (keep || current == reviewed) {
                proposal
            } else {
                current
            }
        }
        let (service_ids, fixed_terms) = choose(
            (&self.service_ids, &self.fixed_terms),
            (&reviewed.service_ids, &reviewed.fixed_terms),
            (&current.service_ids, &current.fixed_terms),
            keep_overlaps && !(self.fixed_terms.is_none() && reviewed.lacked_fixed_terms(current)),
        );
        Self {
            name: choose(&self.name, &reviewed.name, &current.name, keep_overlaps).clone(),
            description: choose(
                &self.description,
                &reviewed.description,
                &current.description,
                keep_overlaps,
            )
            .clone(),
            service_ids: service_ids.clone(),
            fixed_terms: fixed_terms.clone(),
            active: choose(self.active, reviewed.active, current.active, keep_overlaps),
        }
    }
}

pub(crate) fn validate_fixed_selection(
    draft: &CombinationDraft,
    terms: &FixedCombinationTerms,
    catalogue: &[Service],
    staff: &[Staff],
) -> Result<()> {
    crate::ops::validate_catalogue_selection(
        catalogue,
        draft.service_ids.iter().map(String::as_str),
    )?;
    let eligible_services = draft.service_ids.iter().all(|id| {
        catalogue.iter().any(|item| {
            item.id == *id
                && item.currency == "EUR"
                && item.active
                && (!(draft.active && terms.online_booking == Some(true))
                    || online_service(item, catalogue))
        })
    });
    let eligible_staff = terms.staff_ids.iter().all(|id| {
        staff
            .iter()
            .any(|person| person.active && person.id.eq_ignore_ascii_case(id))
    });
    if eligible_services && eligible_staff {
        Ok(())
    } else {
        Err(CoreError::IncompatibleServices)
    }
}

pub fn online_service(service: &Service, catalogue: &[Service]) -> bool {
    service.active
        && service.online_booking != Some(false)
        && match &service.catalog {
            Some(ServiceOption::Variant {
                parent_service_id, ..
            }) => catalogue.iter().any(|parent| {
                parent.id == *parent_service_id
                    && parent.active
                    && parent.online_booking != Some(false)
            }),
            _ => true,
        }
}

pub(crate) fn validate_online_selection(
    ids: &[String],
    catalogue: &[Service],
    staff: &[Staff],
    assignments: &[ServiceStaff],
) -> Result<()> {
    crate::ops::validate_catalogue_selection(catalogue, ids.iter().map(String::as_str))?;
    let mut parts: Vec<Vec<&str>> = Vec::new();
    for id in ids {
        let service = catalogue
            .iter()
            .find(|row| row.id == *id && online_service(row, catalogue))
            .ok_or(CoreError::IncompatibleServices)?;
        if matches!(service.catalog, Some(ServiceOption::Addon { .. })) {
            parts
                .last_mut()
                .ok_or(CoreError::IncompatibleServices)?
                .push(id);
        } else {
            parts.push(vec![id]);
        }
    }
    let active: BTreeSet<_> = staff
        .iter()
        .filter(|person| person.active)
        .map(|person| &person.id)
        .collect();
    let mut by_staff: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for row in assignments
        .iter()
        .filter(|row| active.contains(&row.staff_id))
    {
        by_staff
            .entry(&row.staff_id)
            .or_default()
            .insert(&row.service_id);
    }
    let qualified = |ids: &[&str]| {
        by_staff
            .values()
            .any(|services| ids.iter().all(|id| services.contains(id)))
    };
    if qualified(&ids.iter().map(String::as_str).collect::<Vec<_>>())
        || (parts.len() <= 8 && parts.iter().all(|part| qualified(part)))
    {
        Ok(())
    } else {
        Err(CoreError::IncompatibleServices)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ManagedCombination {
    pub id: String,
    pub version: u64,
    pub bookable: bool,
    #[serde(flatten)]
    pub draft: CombinationDraft,
}

impl ManagedCombination {
    pub fn can_review_rejected_version(
        &self,
        version: u64,
        reviewed: Option<&CombinationDraft>,
    ) -> bool {
        self.version > version
            || (self.version == version
                && reviewed.is_some_and(|draft| draft.lacked_fixed_terms(&self.draft)))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct CombinationCatalogue {
    pub generation: String,
    pub combinations: Vec<ManagedCombination>,
}

impl CombinationCatalogue {
    pub fn at_limit(&self, pending: &[QueuedCombination]) -> bool {
        self.combinations.len()
            + pending
                .iter()
                .filter(|row| {
                    row.edit.version.is_none()
                        && self
                            .combinations
                            .iter()
                            .all(|saved| saved.id != row.edit.id)
                })
                .count()
            >= LIMIT
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct PendingCombination {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u64>,
    #[serde(flatten)]
    pub proposed: CombinationDraft,
    #[serde(rename = "_reviewed", default, skip_serializing_if = "Option::is_none")]
    pub reviewed: Option<CombinationDraft>,
}

impl PendingCombination {
    pub fn restore_reviewed_terms(&self, current: &CombinationDraft) -> Option<CombinationDraft> {
        let reviewed = self.reviewed.as_ref().filter(|reviewed| {
            self.proposed.fixed_terms.is_none() && reviewed.lacked_fixed_terms(current)
        })?;
        Some(self.proposed.rebase(reviewed, current, false))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedCombination {
    pub mutation_id: String,
    pub edit: PendingCombination,
    pub submitted: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_prices_and_service_order_rebase_as_a_group() {
        let reviewed = CombinationDraft {
            name: "Original".into(),
            service_ids: vec!["first".into(), "second".into()],
            fixed_terms: Some(FixedCombinationTerms {
                prices_cents: vec![1800, 900],
                staff_ids: vec!["staff".into()],
                online_booking: Some(false),
            }),
            ..Default::default()
        };
        let mut local = reviewed.clone();
        local.name = "Local".into();
        local.fixed_terms.as_mut().unwrap().prices_cents[0] = 1700;
        let mut cloud = reviewed.clone();
        cloud.service_ids.reverse();
        cloud.fixed_terms.as_mut().unwrap().prices_cents.reverse();
        assert_eq!(local.rebase(&reviewed, &cloud, true), local);
        assert_eq!(
            local.rebase(&reviewed, &cloud, false),
            CombinationDraft {
                name: local.name,
                ..cloud.clone()
            }
        );
        let legacy_review = CombinationDraft {
            fixed_terms: None,
            ..reviewed
        };
        let mut legacy = legacy_review.clone();
        legacy.service_ids.push("third".into());
        legacy.name = "Legacy edit".into();
        let safe = legacy.rebase(&legacy_review, &cloud, true);
        assert_eq!(safe.service_ids, cloud.service_ids);
        assert_eq!(safe.fixed_terms, cloud.fixed_terms);
        assert_eq!(safe.name, legacy.name);
    }

    #[test]
    fn archiving_preserves_fixed_terms_and_only_explicit_removal_clears_them() {
        let terms = serde_json::json!({"pricesCents": [1800, 900], "staffIds": ["staff"], "onlineBooking": false});
        let mut entry = crate::model::OutboxEntry {
            seq: 0,
            mutation_id: String::new(),
            created_at: String::new(),
            kind: UPDATE.into(),
            entity_id: String::new(),
            attempts: 0,
            last_error: None,
            payload: serde_json::json!({
                "active": false, "serviceIds": ["first", "second"], "fixedTerms": terms,
                "_reviewed": {"serviceIds": ["first", "second"], "fixedTerms": terms}
            }),
        };
        let wire = entry.to_wire();
        assert!(wire.payload.get("fixedTerms").is_none());
        assert!(wire.payload.get("_reviewed").is_none());

        entry.payload.as_object_mut().unwrap().remove("fixedTerms");
        assert_eq!(
            entry.to_wire().payload.get("fixedTerms"),
            Some(&serde_json::Value::Null)
        );
    }
}
