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
    #[error("the chosen services cannot be booked together")]
    IncompatibleServices,
    #[error("the reviewed service version has changed")]
    CatalogueVersionChanged,
    #[error("the selected service has booking details waiting to sync")]
    CatalogueEditPending,
    #[error("this time overlaps a schedule block")]
    TimeOffOverlap,
    #[error("this time exceeds the professional's capacity")]
    StaffCapacityExceeded,
    #[error("this client has not finished syncing")]
    PendingClient,
    #[error("the calendar must be refreshed after a restore")]
    CalendarGenerationChanged,
    #[error("the reviewed appointment has changed")]
    AppointmentChanged,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}
