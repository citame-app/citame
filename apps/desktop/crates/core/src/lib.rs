//! Offline-first core of the Sisters of Beauty desktop client. No GUI dependencies: everything
//! here is unit-testable and is exercised headlessly against the real API.

pub mod backoff;
pub mod error;
pub mod model;
pub mod pkce;
pub mod sse;
pub mod store;
