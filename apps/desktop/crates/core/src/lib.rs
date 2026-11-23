//! Offline-first core of the Sisters of Beauty desktop client. No GUI dependencies: everything
//! here is unit-testable and is exercised headlessly against the real API.

pub mod auth;
pub mod backoff;
pub mod billing;
pub mod booking;
pub mod booking_links;
pub mod booking_policy;
pub mod calendar;
pub mod combinations;
pub mod csv_file;
pub mod error;
pub mod http;
pub mod i18n;
pub mod intake;
pub mod inventory;
pub mod inventory_classifications;
pub mod inventory_documents;
pub mod loyalty;
pub mod model;
pub mod ops;
pub mod pkce;
pub mod product_editor;
pub mod promotions;
pub mod purchase_orders;
pub mod receipt_print;
pub mod reports;
pub mod resource_calendar;
pub mod resource_pools;
pub mod reviews;
pub mod runner;
pub mod service_resources;
pub mod sse;
pub mod staff_portrait_image;
pub mod store;
pub mod sync;
pub mod team_shifts;
pub mod waitlist;
pub mod warehouses;

fn trim_like_javascript(text: &str) -> &str {
    // JavaScript's String.trim treats BOM as whitespace and keeps NEXT LINE.
    text.trim_matches(|character: char| {
        character == '\u{feff}' || (character.is_whitespace() && character != '\u{0085}')
    })
}

#[cfg(test)]
mod offline_tests;
