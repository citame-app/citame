//! UI copy for the desktop app: English by default, neutral Argentine Spanish (es-AR) like the
//! web app. Strings live here, not in the views, so they are reviewed and tested in one place.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Locale {
    #[default]
    En,
    EsAr,
}

impl Locale {
    /// Picks a locale from a `LANG`-style value (`es_AR.UTF-8`, `en_US`, ...). Anything that is
    /// not Spanish is English.
    pub fn detect(value: &str) -> Self {
        let lang = value.trim().to_ascii_lowercase();
        if lang == "es" || lang.starts_with("es_") || lang.starts_with("es-") || lang.starts_with("es.") {
            Self::EsAr
        } else {
            Self::En
        }
    }
}

/// Replaces `{name}` placeholders.
pub fn fill(template: &str, args: &[(&str, &str)]) -> String {
    args.iter().fold(template.to_owned(), |acc, (name, value)| acc.replace(&format!("{{{name}}}"), value))
}

macro_rules! keys {
    ($($k:ident => ($en:expr, $es:expr)),* $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum Key { $($k),* }
        impl Key {
            pub const ALL: &'static [Key] = &[$(Key::$k),*];
            fn en(self) -> &'static str { match self { $(Key::$k => $en),* } }
            fn es(self) -> &'static str { match self { $(Key::$k => $es),* } }
        }
    };
}

keys! {
    AppTitle => ("Sisters of Beauty", "Sisters of Beauty"),
    SignInTitle => ("Sign in", "Iniciar sesión"),
    Email => ("Email", "Correo electrónico"),
    Password => ("Password", "Contraseña"),
    SignIn => ("Sign in", "Ingresar"),
    SigningIn => ("Signing in...", "Ingresando..."),
    SignOut => ("Sign out", "Cerrar sesión"),
    ServerUrl => ("Server", "Servidor"),
    ErrWrongCredentials => ("Wrong email or password.", "Correo o contraseña incorrectos."),
    ErrWrongRole => ("This account cannot use the front-desk app.", "Esta cuenta no puede usar la app de recepción."),
    ErrNetwork => ("Cannot reach the server. Check the connection and try again.", "No se puede conectar con el servidor. Revisá la conexión e intentá de nuevo."),
    ErrGeneric => ("Something went wrong.", "Algo salió mal."),
    Today => ("Today", "Hoy"),
    Previous => ("Previous day", "Día anterior"),
    Next => ("Next day", "Día siguiente"),
    NewAppointment => ("New appointment", "Nuevo turno"),
    Online => ("Online", "En línea"),
    Offline => ("Offline", "Sin conexión"),
    Connecting => ("Connecting...", "Conectando..."),
    SessionExpired => ("Session expired", "Sesión vencida"),
    Syncing => ("Syncing...", "Sincronizando..."),
    SyncNow => ("Sync now", "Sincronizar ahora"),
    AllSynced => ("All changes synced", "Todo sincronizado"),
    PendingCount => ("{n} pending", "{n} pendientes"),
    ConflictCount => ("{n} to review", "{n} para revisar"),
    LastSync => ("Last sync {time}", "Última sincronización {time}"),
    NeverSynced => ("Not synced yet", "Todavía sin sincronizar"),
    RetryIn => ("Retrying in {n}s", "Reintentando en {n}s"),
    PendingBadge => ("Pending sync", "Pendiente de sincronizar"),
    ConflictBadge => ("Needs review", "Requiere revisión"),
    NoStaff => ("No staff yet. Connect to the server to load the calendar.", "Todavía no hay personal. Conectate al servidor para cargar la agenda."),
    Client => ("Client", "Cliente"),
    NewClient => ("New client", "Cliente nuevo"),
    ClientName => ("Client name", "Nombre del cliente"),
    ClientPhone => ("Phone (optional)", "Teléfono (opcional)"),
    AddClient => ("Add client", "Agregar cliente"),
    Staff => ("Staff", "Personal"),
    Services => ("Services", "Servicios"),
    Start => ("Start", "Inicio"),
    Notes => ("Notes (optional)", "Notas (opcional)"),
    Book => ("Book", "Reservar"),
    Close => ("Close", "Cerrar"),
    Cancel => ("Cancel", "Cancelar"),
    Back => ("Back", "Volver"),
    MoveEarlier => ("-15 min", "-15 min"),
    MoveLater => ("+15 min", "+15 min"),
    MovePrevDay => ("-1 day", "-1 día"),
    MoveNextDay => ("+1 day", "+1 día"),
    MoveTo => ("Move to", "Mover a"),
    ApplyMove => ("Move appointment", "Mover turno"),
    CancelAppointment => ("Cancel appointment", "Cancelar turno"),
    Details => ("Appointment", "Turno"),
    Conflicts => ("Conflicts", "Conflictos"),
    NoConflicts => ("Nothing to review.", "No hay nada para revisar."),
    ConflictSlotTaken => ("That time is no longer available.", "Ese horario ya no está disponible."),
    ConflictSlotUnavailable => ("That time is outside working hours, during time off or too close to now.", "Ese horario está fuera del horario laboral, en una licencia o demasiado cerca."),
    ConflictStale => ("The appointment changed on the server.", "El turno cambió en el servidor."),
    ConflictNotFound => ("The appointment no longer exists.", "El turno ya no existe."),
    ConflictInvalidState => ("That change is not allowed in the appointment's current state.", "Ese cambio no está permitido en el estado actual del turno."),
    ConflictForbidden => ("You are not allowed to make that change.", "No tenés permiso para hacer ese cambio."),
    ConflictInvalid => ("The server rejected that change.", "El servidor rechazó ese cambio."),
    ConflictPickNewTime => ("Pick another time", "Elegir otro horario"),
    ConflictDropBooking => ("Drop this booking", "Descartar esta reserva"),
    ConflictCancelAppointment => ("Cancel the appointment", "Cancelar el turno"),
    ConflictDismiss => ("Dismiss", "Descartar aviso"),
    ConflictCreate => ("Booking", "Reserva"),
    ConflictReschedule => ("Move", "Cambio de horario"),
    ConflictCancel => ("Cancellation", "Cancelación"),
    ConflictOther => ("Change", "Cambio"),
    UnknownClient => ("Unknown client", "Cliente desconocido"),
    ErrPickService => ("Pick at least one service.", "Elegí al menos un servicio."),
    ErrPickClient => ("Pick or add a client.", "Elegí o agregá un cliente."),
    ErrPickStaff => ("Pick a staff member.", "Elegí a una persona del personal."),
}

pub fn t(locale: Locale, key: Key) -> &'static str {
    match locale {
        Locale::En => key.en(),
        Locale::EsAr => key.es(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_detection_defaults_to_english() {
        assert_eq!(Locale::detect("es_AR.UTF-8"), Locale::EsAr);
        assert_eq!(Locale::detect("es"), Locale::EsAr);
        assert_eq!(Locale::detect("es-ES"), Locale::EsAr);
        assert_eq!(Locale::detect("en_US.UTF-8"), Locale::En);
        assert_eq!(Locale::detect("pt_BR"), Locale::En);
        assert_eq!(Locale::detect(""), Locale::En);
        assert_eq!(Locale::default(), Locale::En);
    }

    #[test]
    fn placeholders_are_filled() {
        assert_eq!(fill("{n} pending, {m} to review", &[("n", "3"), ("m", "1")]), "3 pending, 1 to review");
        assert_eq!(fill("no placeholders", &[("n", "3")]), "no placeholders");
        assert_eq!(fill("{missing}", &[]), "{missing}");
    }

    #[test]
    fn every_key_has_copy_in_every_locale_with_matching_placeholders() {
        let placeholders = |s: &str| {
            let mut v: Vec<String> = s.split('{').skip(1).filter_map(|p| p.split('}').next().map(str::to_owned)).collect();
            v.sort();
            v
        };
        for &k in Key::ALL {
            let (en, es) = (t(Locale::En, k), t(Locale::EsAr, k));
            assert!(!en.trim().is_empty() && !es.trim().is_empty(), "{k:?} is empty");
            assert_eq!(placeholders(en), placeholders(es), "{k:?} placeholders differ");
        }
    }

    #[test]
    fn spanish_is_neutral_argentine_not_slang() {
        for &k in Key::ALL {
            let es = t(Locale::EsAr, k).to_lowercase();
            for slang in ["che ", "boludo", "laburo", "pibe"] {
                assert!(!es.contains(slang), "{k:?} contains {slang:?}");
            }
        }
    }
}
