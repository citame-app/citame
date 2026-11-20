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
    transport: Arc<HttpTransport>,
    stop: Arc<AtomicBool>,
    live: Arc<AtomicBool>,
    listener: Option<JoinHandle<()>>,
}

pub struct Services {
    pub config: Config,
    pub auth: Arc<BetterAuthSession>,
    pub session: SessionHandle,
    pub tokens: Arc<FileTokenStore>,
    /// The UI's own connection; the worker has another one on the same WAL database.
    pub store: Store,
    sync: Option<Sync>,
}

impl Services {
    pub fn open(config: Config) -> Result<Self> {
        let store = Store::open_in_memory()?;
        Ok(Self {
            auth: Arc::new(BetterAuthSession::new(&config.network_origin())),
            session: Arc::new(RwLock::new(None)),
            tokens: Arc::new(FileTokenStore::new(config.session_path())),
            store,
            config,
            sync: None,
        })
    }

    pub fn open_session(&mut self, session: Session) -> Result<()> {
        let path = self.config.db_path(&session);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(path.parent().expect("replica directory"))?;
        }
        let store = Store::open(&path)?;
        self.session.write().expect("session lock").take();
        self.stop_sync();
        self.session = Arc::new(RwLock::new(Some(session)));
        self.store = store;
        Ok(())
    }

    pub fn current_session(&self) -> Option<Session> {
        self.session.read().expect("session lock").clone()
    }

    pub fn start_sync(&mut self) -> Result<()> {
        if self.sync.is_some() {
            return Ok(());
        }
        let Some(session) = self.current_session() else {
            return Ok(());
        };
        let transport = Arc::new(
            HttpTransport::new(
                &self.config.network_origin(),
                self.session.clone(),
                self.auth.clone() as Arc<dyn AuthProvider>,
            )
            .with_token_store(self.tokens.clone()),
        );
        let status: SharedStatus = Default::default();
        let core = RunnerCore::new(
            Store::open(&self.config.db_path(&session))?,
            transport.clone(),
            status,
        );
        let runner = SyncRunner::spawn(core);
        let live = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let listener = spawn_stream_listener(
            transport.clone(),
            runner.sender(),
            live.clone(),
            stop.clone(),
        );
        self.sync = Some(Sync {
            runner,
            transport,
            stop,
            live,
            listener: Some(listener),
        });
        Ok(())
    }

    pub fn transport(&self) -> Option<Arc<HttpTransport>> {
        self.sync.as_ref().map(|sync| sync.transport.clone())
    }

    pub fn stop_sync(&mut self) {
        if let Some(mut s) = self.sync.take() {
            s.stop.store(true, Ordering::SeqCst);
            // Drop signals Stop without waiting for an HTTP request on the UI thread.
            drop(s.runner);
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

    pub fn sign_out(&mut self) -> Option<Session> {
        self.stop_sync();
        let session = self.session.write().expect("session lock").take();
        if let Err(error) = self.tokens.clear() {
            eprintln!("could not clear the saved session: {error}");
        }
        session
    }

    pub fn load_saved_session(&mut self) -> Option<Session> {
        let saved = self.tokens.load().ok().flatten()?;
        self.open_session(saved.clone()).ok()?;
        Some(saved)
    }
}
