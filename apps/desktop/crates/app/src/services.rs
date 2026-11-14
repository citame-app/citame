//! Everything the UI talks to: auth, the local store and the background sync worker.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::thread::JoinHandle;

use sob_core::auth::{
    AuthProvider, BetterAuthSession, FileTokenStore, Session, SessionHandle, TokenStore,
};
use sob_core::error::Result;
use sob_core::http::{HttpTransport, spawn_stream_listener};
use sob_core::runner::{RunnerCore, SharedStatus, SyncRunner, SyncStatus, Wake};
use sob_core::store::Store;

use crate::config::Config;

struct Sync {
    runner: SyncRunner,
    stop: Arc<AtomicBool>,
    live: Arc<AtomicBool>,
    listener: Option<JoinHandle<()>>,
}

pub struct Services {
    pub config: Config,
    pub auth: Arc<BetterAuthSession>,
    pub session: SessionHandle,
    pub tokens: FileTokenStore,
    /// The UI's own connection; the worker has another one on the same WAL database.
    pub store: Store,
    sync: Option<Sync>,
}

impl Services {
    pub fn open(config: Config) -> Result<Self> {
        let store = Store::open(&config.db_path())?;
        Ok(Self {
            auth: Arc::new(BetterAuthSession::new(&config.api_url)),
            session: Arc::new(RwLock::new(None)),
            tokens: FileTokenStore::new(config.session_path()),
            store,
            config,
            sync: None,
        })
    }

    pub fn set_session(&mut self, session: Option<Session>) {
        *self.session.write().expect("session lock") = session;
    }

    pub fn current_session(&self) -> Option<Session> {
        self.session.read().expect("session lock").clone()
    }

    pub fn start_sync(&mut self) -> Result<()> {
        if self.sync.is_some() {
            return Ok(());
        }
        let transport = Arc::new(HttpTransport::new(
            &self.config.api_url,
            self.session.clone(),
            self.auth.clone() as Arc<dyn AuthProvider>,
        ));
        let status: SharedStatus = Default::default();
        let core = RunnerCore::new(
            Store::open(&self.config.db_path())?,
            transport.clone(),
            status,
        );
        let runner = SyncRunner::spawn(core);
        let live = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let listener =
            spawn_stream_listener(transport, runner.sender(), live.clone(), stop.clone());
        self.sync = Some(Sync {
            runner,
            stop,
            live,
            listener: Some(listener),
        });
        Ok(())
    }

    pub fn stop_sync(&mut self) {
        if let Some(mut s) = self.sync.take() {
            s.stop.store(true, Ordering::SeqCst);
            s.runner.stop();
            // The stream thread exits at its next line or reconnect; do not block the UI on it.
            drop(s.listener.take());
        }
    }

    pub fn status(&self) -> SyncStatus {
        match &self.sync {
            Some(s) => {
                let mut st = s.runner.status();
                st.stream_live = s.live.load(Ordering::SeqCst);
                st
            }
            None => SyncStatus::default(),
        }
    }

    pub fn wake(&self, why: Wake) {
        if let Some(s) = &self.sync {
            s.runner.wake(why);
        }
    }

    pub fn sign_out(&mut self) {
        self.stop_sync();
        if let Some(session) = self.current_session() {
            self.auth.sign_out(&session);
        }
        self.set_session(None);
        let _ = self.tokens.clear();
    }

    pub fn load_saved_session(&mut self) -> Option<Session> {
        let saved = self.tokens.load().ok().flatten()?;
        self.set_session(Some(saved.clone()));
        Some(saved)
    }
}
