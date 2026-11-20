use thiserror::Error;

pub type Result<T, E = CoreError> = std::result::Result<T, E>;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("local database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("protocol violation: {0}")]
    Protocol(String),
    #[error("{0}")]
    Invalid(String),
    #[error("this time overlaps a schedule block")]
    TimeOffOverlap,
    #[error("this time exceeds the professional's capacity")]
    StaffCapacityExceeded,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}
