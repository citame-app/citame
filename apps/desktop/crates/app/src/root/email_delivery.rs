use super::*;
use sob_core::http::email_delivery::{
    EmailDelivery, EmailProvider, Encryption, SaveError, UpdateEmailDelivery,
};
use sob_core::sync::TransportError;

const LABELS: [Key; 6] = [
    Key::EmailDeliverySender,
    Key::EmailDeliverySenderName,
    Key::EmailDeliveryHost,
    Key::EmailDeliveryPort,
    Key::EmailDeliveryUsername,
    Key::EmailDeliveryCredential,
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Provider {
    Inherit,
    Smtp,
    Gmail,
    Resend,
    Disabled,
}

impl Provider {
    fn current(settings: &EmailProvider) -> Self {
        match settings {
            EmailProvider::Inherit => Self::Inherit,
            EmailProvider::Smtp { .. } => Self::Smtp,
            EmailProvider::Gmail { .. } => Self::Gmail,
            EmailProvider::Resend { .. } => Self::Resend,
            EmailProvider::Disabled => Self::Disabled,
        }
    }

    fn active(self) -> bool {
        !matches!(self, Self::Disabled | Self::Inherit)
    }
}

struct Editor {
    saved: EmailDelivery,
    provider: Provider,
    encryption: Encryption,
    fields: [Entity<TextField>; 6],
}

impl Editor {
    fn new(saved: EmailDelivery, locale: Locale, cx: &mut Context<Root>) -> Self {
        let provider = Provider::current(&saved.settings);
        let mut encryption = Encryption::default();
        let mut values = [
            String::new(),
            String::new(),
            String::new(),
            "587".into(),
            String::new(),
            String::new(),
        ];
        match &saved.settings {
            EmailProvider::Smtp {
                from_email,
                from_name,
                host,
                port,
                encryption: saved_encryption,
                username,
            } => {
                values = [
                    from_email.clone(),
                    from_name.clone(),
                    host.clone(),
                    port.to_string(),
                    username.clone(),
                    String::new(),
                ];
                encryption = *saved_encryption;
            }
            EmailProvider::Gmail {
                from_email,
                from_name,
            }
            | EmailProvider::Resend {
                from_email,
                from_name,
            } => {
                values[0] = from_email.clone();
                values[1] = from_name.clone();
            }
            _ => {}
        }
        let fields = std::array::from_fn(|index| {
            let field = cx.new(|cx| {
                let mut field = TextField::new(i18n::t(locale, LABELS[index]), index == 5, cx);
                field.set_text(&values[index], cx);
                field
            });
            cx.subscribe(&field, |_, _, event, cx| {
                if matches!(event, FieldEvent::Changed) {
                    cx.notify();
                }
            })
            .detach();
            field
        });
        Self {
            saved,
            provider,
            encryption,
            fields,
        }
    }

    fn change(&self, cx: &App) -> Option<UpdateEmailDelivery> {
        let [from_email, from_name, host, port, username, secret] =
            self.fields.each_ref().map(|field| field.read(cx).text());
        if self.provider.active() && (from_email.trim().is_empty() || from_name.trim().is_empty()) {
            return None;
        }
        let from_email = from_email.trim().to_owned();
        let from_name = from_name.trim().to_owned();
        let settings = match self.provider {
            Provider::Inherit => EmailProvider::Inherit,
            Provider::Disabled => EmailProvider::Disabled,
            Provider::Smtp => {
                let port = port.trim().parse().ok().filter(|port| *port > 0)?;
                if host.trim().is_empty() || username.trim().is_empty() {
                    return None;
                }
                EmailProvider::Smtp {
                    from_email,
                    from_name,
                    host: host.trim().to_ascii_lowercase(),
                    port,
                    encryption: self.encryption,
                    username: username.trim().to_owned(),
                }
            }
            Provider::Gmail => EmailProvider::Gmail {
                from_email,
                from_name,
            },
            Provider::Resend => EmailProvider::Resend {
                from_email,
                from_name,
            },
        };
        Some(UpdateEmailDelivery {
            revision: self.saved.revision.clone(),
            settings,
            secret: (self.provider.active() && !secret.is_empty()).then(|| secret.to_owned()),
        })
    }

    fn dirty(&self, cx: &App) -> bool {
        self.change(cx)
            .is_none_or(|change| change.settings != self.saved.settings || change.secret.is_some())
    }

    fn can_test(&self, cx: &App) -> bool {
        !self.dirty(cx)
            && (self.provider.active()
                || (self.provider == Provider::Inherit && self.saved.server_email_enabled))
    }
}

#[derive(Clone, Copy)]
enum Discard {
    Close,
    Reload,
}

pub(super) struct Desk {
    identity: Arc<()>,
    editor: Option<Editor>,
    busy: bool,
    blocked: bool,
    message: Option<Key>,
    discard: Option<Discard>,
}

enum Operation {
    Load,
    Save(UpdateEmailDelivery),
    Test,
}

impl Root {
    pub(super) fn open_email_delivery(&mut self, cx: &mut Context<Self>) {
        if !self.can_configure_salon() {
            return;
        }
        self.overlay = Overlay::EmailDelivery(Box::new(Desk {
            identity: Arc::new(()),
            editor: None,
            busy: false,
            blocked: false,
            message: None,
            discard: None,
        }));
        self.request_email_delivery(Operation::Load, cx);
        cx.notify();
    }

    pub(super) fn load_email_delivery_after_reconnect(&mut self, cx: &mut Context<Self>) {
        if matches!(&self.overlay, Overlay::EmailDelivery(desk) if desk.editor.is_none() && !desk.busy)
        {
            self.request_email_delivery(Operation::Load, cx);
        }
    }

    pub(super) fn dismiss_email_delivery(&mut self, cx: &mut Context<Self>) {
        let Overlay::EmailDelivery(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy {
            return;
        }
        if desk.discard.take().is_none() {
            if desk.editor.as_ref().is_some_and(|editor| editor.dirty(cx)) {
                desk.discard = Some(Discard::Close);
            } else {
                self.open_web_management(cx);
            }
        }
        cx.notify();
    }

    fn request_email_delivery(&mut self, operation: Operation, cx: &mut Context<Self>) {
        let Overlay::EmailDelivery(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy {
            return;
        }
        let Some(transport) = self
            .svc
            .transport()
            .filter(|_| self.status.connectivity == Connectivity::Online)
        else {
            desk.message = Some(Key::EmailDeliveryNeedsConnection);
            cx.notify();
            return;
        };
        let testing = matches!(operation, Operation::Test);
        let saving = matches!(operation, Operation::Save(_));
        let identity = desk.identity.clone();
        let session = self.svc.session.clone();
        desk.busy = true;
        desk.message = None;
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match operation {
                        Operation::Load => transport.email_delivery().map(Some).map_err(Into::into),
                        Operation::Save(change) => transport.save_email_delivery(&change).map(Some),
                        Operation::Test => transport
                            .test_email_delivery()
                            .map(|()| None)
                            .map_err(Into::into),
                    }
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let Overlay::EmailDelivery(desk) = &mut root.overlay else {
                    return;
                };
                if !Arc::ptr_eq(&identity, &desk.identity) {
                    return;
                }
                desk.busy = false;
                desk.message = match result {
                    Ok(Some(saved)) => {
                        desk.editor = Some(Editor::new(saved, root.locale, cx));
                        desk.blocked = false;
                        saving.then_some(Key::EmailDeliverySaved)
                    }
                    Ok(None) => Some(Key::EmailDeliveryTestSent),
                    Err(SaveError::Conflict) => {
                        desk.blocked = true;
                        desk.clear_credential(cx);
                        Some(Key::EmailDeliveryConflict)
                    }
                    Err(SaveError::Transport(TransportError::BadRequest(_))) if saving => {
                        Some(Key::EmailDeliveryInvalid)
                    }
                    Err(SaveError::Transport(error)) => {
                        if saving
                            && matches!(
                                error,
                                TransportError::Offline(_) | TransportError::Server(_)
                            )
                        {
                            desk.blocked = true;
                            desk.clear_credential(cx);
                            Some(Key::EmailDeliveryUnconfirmed)
                        } else if testing {
                            Some(Key::EmailDeliveryTestUnconfirmed)
                        } else {
                            Some(Key::EmailDeliveryFailed)
                        }
                    }
                };
                cx.notify();
            });
        })
        .detach();
    }

    fn save_email_delivery(&mut self, cx: &mut Context<Self>) {
        let Overlay::EmailDelivery(desk) = &mut self.overlay else {
            return;
        };
        if desk.blocked || desk.busy || desk.discard.is_some() {
            return;
        }
        let Some(editor) = &desk.editor else { return };
        let Some(change) = editor.change(cx) else {
            desk.message = Some(Key::EmailDeliveryInvalid);
            cx.notify();
            return;
        };
        if change.settings != editor.saved.settings || change.secret.is_some() {
            self.request_email_delivery(Operation::Save(change), cx);
        }
    }

    pub(super) fn render_email_delivery(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let body = div()
            .id("email-delivery-scroll")
            .min_h_0()
            .flex_shrink()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(self.t(Key::EmailDelivery)),
            )
            .when(!online, |body| {
                body.child(self.t(Key::EmailDeliveryNeedsConnection))
            })
            .when_some(desk.message, |body, message| {
                body.child(div().text_sm().child(self.t(message)))
            });
        let body = if desk.busy {
            body.child(self.t(Key::EmailDeliveryWorking))
        } else if let Some(discard) = desk.discard {
            body.child(self.t(Key::SalonConfirmDiscard)).child(
                div()
                    .flex()
                    .gap_2()
                    .child(self.button(
                        "email-cancel-discard",
                        self.t(Key::Cancel),
                        Kind::Ghost,
                        cx.listener(|root, _, _, cx| root.dismiss_email_delivery(cx)),
                    ))
                    .child(self.button(
                        "email-confirm-discard",
                        self.t(Key::ReviewDiscard),
                        Kind::Primary,
                        cx.listener(move |root, _, _, cx| match discard {
                            Discard::Close => root.open_web_management(cx),
                            Discard::Reload => {
                                if let Overlay::EmailDelivery(desk) = &mut root.overlay {
                                    desk.discard = None;
                                    desk.editor = None;
                                }
                                root.request_email_delivery(Operation::Load, cx);
                            }
                        }),
                    )),
            )
        } else {
            body.when_some(desk.editor.as_ref(), |body, editor| {
                body.child(self.render_email_fields(editor, cx))
                    .when(online && !desk.blocked, |body| {
                        body.child(div().flex().flex_wrap().gap_2()
                            .when(editor.dirty(cx), |actions| {
                                actions.child(self.button("email-save", self.t(Key::EmailDeliverySave), Kind::Primary,
                                    cx.listener(|root, _, _, cx| root.save_email_delivery(cx))))
                            })
                            .when(editor.can_test(cx), |actions| {
                                actions.child(self.button("email-test", self.t(Key::EmailDeliveryTest), Kind::Ghost,
                                    cx.listener(|root, _, _, cx| {
                                        if matches!(&root.overlay, Overlay::EmailDelivery(desk) if !desk.blocked
                                            && desk.editor.as_ref().is_some_and(|editor| editor.can_test(cx))) {
                                            root.request_email_delivery(Operation::Test, cx);
                                        }
                                    })))
                            }))
                    })
            }).child(div().flex().gap_2()
                .child(self.button("email-close", self.t(Key::Back), Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.dismiss_email_delivery(cx))))
                .when(online, |actions| actions.child(self.button("email-reload", self.t(Key::EmailDeliveryReload), Kind::Ghost,
                    cx.listener(|root, _, _, cx| {
                        if let Overlay::EmailDelivery(desk) = &mut root.overlay
                            && desk.editor.as_ref().is_some_and(|editor| editor.dirty(cx)) {
                            desk.discard = Some(Discard::Reload);
                            cx.notify();
                        } else {
                            root.request_email_delivery(Operation::Load, cx);
                        }
                    })))))
        };
        self.modal_with_height(
            body,
            (viewport.width - px(32.)).max(px(220.)).min(px(560.)),
            (viewport.height - px(28.)).max(px(140.)),
            Some(cx),
        )
    }

    fn render_email_fields(&self, editor: &Editor, cx: &mut Context<Self>) -> gpui::Div {
        let fields = (0..LABELS.len()).filter(|index| match *index {
            0 | 1 | 5 => editor.provider.active(),
            _ => editor.provider == Provider::Smtp,
        });
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div().flex().flex_wrap().gap_2().children(
                    [
                        (Provider::Inherit, self.t(Key::EmailDeliveryInherit)),
                        (Provider::Smtp, "SMTP"),
                        (Provider::Gmail, "Gmail / Google Workspace"),
                        (Provider::Resend, "Resend"),
                        (Provider::Disabled, self.t(Key::EmailDeliveryDisabled)),
                    ]
                    .into_iter()
                    .enumerate()
                    .map(|(index, (provider, label))| {
                        self.button(
                            ("email-provider", index),
                            label,
                            if provider == editor.provider {
                                Kind::Primary
                            } else {
                                Kind::Ghost
                            },
                            cx.listener(move |root, _, _, cx| {
                                if let Overlay::EmailDelivery(desk) = &mut root.overlay
                                    && let Some(editor) = &mut desk.editor
                                    && editor.provider != provider
                                {
                                    editor.provider = provider;
                                    editor.fields[5].update(cx, |field, cx| field.clear(cx));
                                    desk.message = None;
                                    cx.notify();
                                }
                            }),
                        )
                    }),
                ),
            )
            .when(editor.provider == Provider::Inherit, |body| {
                body.child(
                    div()
                        .text_sm()
                        .child(self.t(if editor.saved.server_email_enabled {
                            Key::EmailDeliveryServerReady
                        } else {
                            Key::EmailDeliveryServerMissing
                        })),
                )
            })
            .children(fields.map(|index| {
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(div().text_sm().child(self.t(if index == 5 {
                        match editor.provider {
                            Provider::Gmail => Key::EmailDeliveryGooglePassword,
                            Provider::Resend => Key::EmailDeliveryResendKey,
                            _ => LABELS[index],
                        }
                    } else {
                        LABELS[index]
                    })))
                    .child(editor.fields[index].clone())
            }))
            .when(
                editor.provider.active()
                    && editor.saved.has_secret
                    && editor.provider == Provider::current(&editor.saved.settings),
                |body| body.child(div().text_sm().child(self.t(Key::EmailDeliveryStored))),
            )
            .when(editor.provider == Provider::Smtp, |body| {
                body.child(
                    div().flex().gap_2().children(
                        [(Encryption::StartTls, "STARTTLS"), (Encryption::Tls, "TLS")]
                            .into_iter()
                            .enumerate()
                            .map(|(index, (encryption, label))| {
                                self.button(
                                    ("email-encryption", index),
                                    label,
                                    if encryption == editor.encryption {
                                        Kind::Primary
                                    } else {
                                        Kind::Ghost
                                    },
                                    cx.listener(move |root, _, _, cx| {
                                        if let Overlay::EmailDelivery(desk) = &mut root.overlay
                                            && let Some(editor) = &mut desk.editor
                                        {
                                            editor.encryption = encryption;
                                            desk.message = None;
                                            cx.notify();
                                        }
                                    }),
                                )
                            }),
                    ),
                )
            })
    }
}

impl Desk {
    fn clear_credential(&mut self, cx: &mut Context<Root>) {
        if let Some(editor) = &self.editor {
            editor.fields[5].update(cx, |field, cx| field.clear(cx));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn editing_email_delivery_cannot_queue_credentials_offline(cx: &mut TestAppContext) {
        let (_directory, window) = super::super::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                root.status.connectivity = Connectivity::Offline;
                root.open_email_delivery(cx);
                let Overlay::EmailDelivery(desk) = &mut root.overlay else {
                    panic!("The owner email settings did not open");
                };
                assert!(matches!(
                    desk.message,
                    Some(Key::EmailDeliveryNeedsConnection)
                ));
                let saved = EmailDelivery {
                    revision: Some("revision".into()),
                    settings: EmailProvider::Resend {
                        from_email: "bookings@example.test".into(),
                        from_name: "Citame".into(),
                    },
                    server_email_enabled: true,
                    has_secret: true,
                };
                let editor = Editor::new(saved, root.locale, cx);
                assert!(editor.can_test(cx));
                assert!(editor.fields[5].read(cx).text().is_empty());
                editor.fields[5].update(cx, |field, cx| field.set_text("re_sample", cx));
                assert!(editor.dirty(cx));
                assert!(!editor.can_test(cx));
                desk.editor = Some(editor);
                root.save_email_delivery(cx);
                assert_eq!(root.svc.store.outbox_len().unwrap(), 0);
                root.dismiss_email_delivery(cx);
                assert!(matches!(&root.overlay, Overlay::EmailDelivery(desk)
                if matches!(desk.discard, Some(Discard::Close))));
            })
            .unwrap();
    }
}
