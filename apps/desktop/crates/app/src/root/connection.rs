use super::*;

impl Root {
    pub(super) fn open_server_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.login.busy || self.disconnecting || self.svc.config.api_url_locked {
            return;
        }
        self.login.server_editor = true;
        self.login.server_error = None;
        self.login.server.update(cx, |field, cx| {
            field.set_text(&self.svc.config.api_url, cx);
        });
        self.login.server.read(cx).focus(window);
        cx.notify();
    }

    pub(super) fn save_server(&mut self, cx: &mut Context<Self>) {
        if !self.login.server_editor || self.svc.config.api_url_locked || self.login.busy {
            return;
        }
        let Some(origin) = crate::config::server_origin(self.login.server.read(cx).text()) else {
            self.login.server_error = Some(Key::ServerInvalid);
            cx.notify();
            return;
        };
        if crate::config::server_origin(&self.svc.config.api_url).as_ref() == Some(&origin) {
            if self.svc.config.save_server().is_err() {
                self.login.server_error = Some(Key::ServerSaveFailed);
                cx.notify();
                return;
            }
            self.login.server_editor = false;
            cx.notify();
            return;
        }
        let mut config = self.svc.config.clone();
        config.api_url = config.retained_server_key(origin);
        let next = Services::open(config).and_then(|services| {
            self.svc.config.remember_server_key()?;
            services.config.save_server()?;
            Ok(services)
        });
        let Ok(next) = next else {
            self.login.server_error = Some(Key::ServerSaveFailed);
            cx.notify();
            return;
        };

        let mut previous = std::mem::replace(&mut self.svc, next);
        previous.session.write().expect("session lock").take();
        previous.stop_sync();
        self.screen = Screen::Login;
        self.overlay = Overlay::None;
        self.calendar_scope = None;
        self.notices.clear();
        self.notice_cursor = 0;
        self.login.server_editor = false;
        self.login.server_error = None;
        self.login.error = None;
        self.disconnect_failed = false;
        if let Some(saved) = self.svc.load_saved_session() {
            self.enter_main(cx);
            self.validate_saved(saved, cx);
        } else {
            self.reload(cx);
        }
    }

    pub(super) fn render_server_editor(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .w(px(420.))
                    .p_6()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .rounded_lg()
                    .border_1()
                    .border_color(theme::line())
                    .bg(theme::panel())
                    .child(
                        div()
                            .text_xl()
                            .font_weight(FontWeight::BOLD)
                            .child(self.t(Key::ServerUrl)),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme::muted())
                            .child(self.t(Key::ServerHelp)),
                    )
                    .child(self.login.server.clone())
                    .when_some(self.login.server_error, |d, error| {
                        d.child(
                            div()
                                .text_sm()
                                .text_color(theme::conflict_fg())
                                .child(self.t(error)),
                        )
                    })
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .justify_end()
                            .when(!self.svc.config.api_url.is_empty(), |d| {
                                d.child(self.button(
                                    "server-cancel",
                                    self.t(Key::Cancel),
                                    Kind::Ghost,
                                    cx.listener(|this, _, _, cx| {
                                        this.login.server_editor = false;
                                        cx.notify();
                                    }),
                                ))
                            })
                            .child(self.button(
                                "server-use",
                                self.t(Key::ServerUse),
                                Kind::Primary,
                                cx.listener(|this, _, _, cx| this.save_server(cx)),
                            )),
                    ),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn a_new_installation_starts_by_asking_for_its_server(cx: &mut TestAppContext) {
        let profile = tempfile::tempdir().unwrap();
        let config = crate::config::Config {
            api_url: "http://127.0.0.1:3000".into(),
            api_url_locked: false,
            data_dir: profile.path().to_path_buf(),
            locale: Locale::EsAr,
            start_date: None,
            start_view: None,
        };
        let handle = cx.add_window(|window, cx| Root::new(config, window, cx));
        handle
            .update(cx, |root, _, cx| {
                assert!(root.login.server_editor);
                root.login
                    .server
                    .update(cx, |field, cx| field.set_text("local.example", cx));
                root.save_server(cx);
                assert!(matches!(root.screen, Screen::Login));
                assert!(!root.login.server_editor);
                assert_eq!(root.svc.config.api_url, "https://local.example");
            })
            .unwrap();
    }

    #[gpui::test]
    async fn changing_origins_preserves_the_previous_offline_queue_and_session(
        cx: &mut TestAppContext,
    ) {
        let (_profile, handle) = super::super::tests::open(cx);
        handle
            .update(cx, |root, window, cx| {
                let old_config = root.svc.config.clone();
                let session = root.svc.current_session().unwrap();
                ops::create_client(&mut root.svc.store, "Pending from old server", None).unwrap();
                root.open_server_editor(window, cx);
                root.login
                    .server
                    .update(cx, |field, cx| field.set_text("http://server.example/", cx));
                root.save_server(cx);
                assert!(matches!(root.login.server_error, Some(Key::ServerInvalid)));
                assert_eq!(root.svc.config.api_url, old_config.api_url);
                assert!(!old_config.data_dir.join("api-url").exists());

                root.login
                    .server
                    .update(cx, |field, cx| field.set_text("http://127.0.0.1:10/", cx));
                root.save_server(cx);
                assert!(matches!(root.screen, Screen::Login));
                assert!(root.svc.current_session().is_none());
                assert!(root.svc.store.outbox(1).unwrap().is_empty());
                assert_eq!(
                    std::fs::read_to_string(old_config.data_dir.join("api-url")).unwrap(),
                    "http://127.0.0.1:10\n",
                );
                root.open_server_editor(window, cx);
                root.login
                    .server
                    .update(cx, |field, cx| field.set_text(&old_config.api_url, cx));
                root.save_server(cx);
                assert!(matches!(root.screen, Screen::Main));
                assert_eq!(root.svc.current_session().as_ref(), Some(&session));
                assert_eq!(root.svc.store.outbox_len().unwrap(), 1);
            })
            .unwrap();
    }
}
