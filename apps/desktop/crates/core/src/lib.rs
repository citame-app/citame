//! Offline-first core of the Sisters of Beauty desktop client. No GUI dependencies: everything
//! here is unit-testable and is exercised headlessly against the real API.

pub mod auth;
pub mod backoff;
pub mod calendar;
pub mod error;
pub mod http;
pub mod i18n;
pub mod model;
pub mod ops;
pub mod pkce;
pub mod runner;
pub mod sse;
pub mod store;
pub mod sync;

#[cfg(test)]
mod offline_tests;
