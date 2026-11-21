use super::*;
use sob_core::http::{
    AccountLookupError, AccountRole, AccountRoleReceipt, UnlinkedAccount, valid_staff_login,
};

pub(super) struct Desk {
    identity: Arc<()>,
    email: Entity<TextField>,
    account: Option<UnlinkedAccount>,
    proposed: Option<AccountRole>,
    saved: Option<AccountRoleReceipt>,
    busy: bool,
    notice: Option<Key>,
}

enum Command {
    Lookup(String),
    Change(UnlinkedAccount, AccountRole),
}

enum Reply {
    Account(UnlinkedAccount),
    Saved(AccountRoleReceipt),
}

impl Root {
    pub(super) fn open_account_roles(&mut self, cx: &mut Context<Self>) {
        if !self.can_configure_salon() {
            return;
        }
        let label = self.t(Key::AccessLoginEmail);
        self.overlay = Overlay::AccountRoles(Box::new(Desk {
            identity: Arc::new(()),
            email: cx.new(|cx| TextField::new(label, false, cx)),
            account: None,
            proposed: None,
            saved: None,
            busy: false,
            notice: None,
        }));
        cx.notify();
    }

    fn request_account_role(&mut self, role: Option<AccountRole>, cx: &mut Context<Self>) {
        if !self.can_configure_salon() || self.status.connectivity != Connectivity::Online {
            return;
        }
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let Overlay::AccountRoles(desk) = &mut self.overlay else {
            return;
        };
        if desk.busy {
            return;
        }
        let command = if let Some(role) = role {
            if desk.proposed != Some(role)
                || !desk
                    .account
                    .as_ref()
                    .is_some_and(|account| account.can_change_to(role))
            {
                return;
            }
            let Some(account) = desk.account.take() else {
                return;
            };
            Command::Change(account, role)
        } else {
            let email = desk.email.read(cx).text().trim().to_owned();
            desk.account = None;
            desk.saved = None;
            if !valid_staff_login(&email, None) {
                desk.notice = Some(Key::AccountsEmailInvalid);
                cx.notify();
                return;
            }
            Command::Lookup(email)
        };
        let lookup = matches!(command, Command::Lookup(_));
        desk.busy = true;
        desk.proposed = None;
        desk.notice = None;
        desk.saved = None;
        let identity = desk.identity.clone();
        let session = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match command {
                        Command::Lookup(email) => transport
                            .lookup_unlinked_account(&email)
                            .map(Reply::Account),
                        Command::Change(account, role) => transport
                            .change_unlinked_role(&account, role)
                            .map(Reply::Saved)
                            .map_err(AccountLookupError::from),
                    }
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let Overlay::AccountRoles(desk) = &mut root.overlay else {
                    return;
                };
                if !Arc::ptr_eq(&identity, &desk.identity) {
                    return;
                }
                desk.busy = false;
                match result {
                    Ok(Reply::Account(account)) => desk.account = Some(account),
                    Ok(Reply::Saved(receipt)) => {
                        desk.saved = Some(receipt);
                        root.svc.wake(Wake::Local);
                    }
                    Err(AccountLookupError::NotFound) => desk.notice = Some(Key::AccountsNotFound),
                    Err(AccountLookupError::InvalidAddress) => {
                        desk.notice = Some(Key::AccountsEmailInvalid)
                    }
                    Err(_) => {
                        desk.notice = Some(if lookup {
                            Key::AccountsLookupFailed
                        } else {
                            Key::AccountsSaveFailed
                        })
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn review_account_role(&mut self, role: AccountRole, cx: &mut Context<Self>) {
        if self.status.connectivity == Connectivity::Online
            && self.can_configure_salon()
            && let Overlay::AccountRoles(desk) = &mut self.overlay
            && !desk.busy
            && desk.proposed.is_none()
            && desk
                .account
                .as_ref()
                .is_some_and(|account| account.can_change_to(role))
        {
            desk.proposed = Some(role);
            cx.notify();
        }
    }

    pub(super) fn close_account_roles(&mut self, cx: &mut Context<Self>) {
        let Overlay::AccountRoles(desk) = &mut self.overlay else {
            return;
        };
        if !desk.busy {
            if desk.proposed.take().is_none() {
                self.overlay = Overlay::None;
            }
            cx.notify();
        }
    }

    pub(super) fn render_account_roles(
        &self,
        desk: &Desk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let body = div()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap_2()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::BOLD)
                            .child(self.t(Key::AccountsFind)),
                    )
                    .when(!desk.busy, |bar| {
                        bar.child(self.button(
                            "close-account-roles",
                            self.t(if desk.proposed.is_some() {
                                Key::Cancel
                            } else {
                                Key::Close
                            }),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.close_account_roles(cx)),
                        ))
                    }),
            )
            .when(!online, |view| view.child(self.t(Key::AccessOnline)))
            .when(desk.busy, |view| {
                view.child(self.t(Key::CloudWorkspacesLoading))
            })
            .when_some(desk.notice, |view, notice| view.child(self.t(notice)))
            .when(!desk.busy && desk.account.is_none(), |view| {
                view.child(div().text_sm().child(self.t(Key::AccountsExactEmail)))
                    .child(desk.email.clone())
                    .when(online, |view| {
                        view.child(self.button(
                            "lookup-account-exact",
                            self.t(Key::AccountsSearch),
                            Kind::Primary,
                            cx.listener(|root, _, _, cx| root.request_account_role(None, cx)),
                        ))
                    })
            })
            .when_some(desk.account.as_ref(), |view, account| {
                view.child(div().text_sm().child(account.name.clone()))
                    .child(div().text_sm().child(account.email.clone()))
                    .child(div().text_sm().child(i18n::fill(
                        self.t(Key::AccessRoleCurrent),
                        &[("role", self.t(role_label(account.role)))],
                    )))
                    .when(!account.email_verified, |view| {
                        view.child(self.t(Key::AccountsVerifyEmail))
                    })
                    .when(online && desk.proposed.is_none(), |view| {
                        view.child(self.button(
                            "start-another-account-lookup",
                            self.t(Key::AccountsSearchAnother),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| {
                                if let Overlay::AccountRoles(desk) = &mut root.overlay {
                                    desk.account = None;
                                    cx.notify();
                                }
                            }),
                        ))
                        .children(
                            AccountRole::ALL
                                .into_iter()
                                .filter(|role| account.can_change_to(*role))
                                .map(|role| {
                                    self.button(
                                        ("review-unlinked-role", role as usize),
                                        self.t(role_label(role)),
                                        Kind::Ghost,
                                        cx.listener(move |root, _, _, cx| {
                                            root.review_account_role(role, cx)
                                        }),
                                    )
                                }),
                        )
                    })
                    .when_some(desk.proposed, |view, role| {
                        view.child(i18n::fill(
                            self.t(Key::AccessRoleReview),
                            &[
                                ("account", &account.email),
                                ("role", self.t(role_label(role))),
                            ],
                        ))
                        .child(self.t(role_impact(role)))
                        .when(online, |view| {
                            view.child(self.button(
                                "confirm-unlinked-role",
                                self.t(Key::AccessRoleConfirm),
                                Kind::Danger,
                                cx.listener(move |root, _, _, cx| {
                                    root.request_account_role(Some(role), cx)
                                }),
                            ))
                        })
                    })
            })
            .when_some(desk.saved.as_ref(), |view, saved| {
                view.child(self.t(Key::AccessRoleSaved)).when_some(
                    saved.staff_id.clone(),
                    |view, id| {
                        view.child(self.button(
                            "open-new-staff-calendar",
                            self.t(Key::StaffAccess),
                            Kind::Ghost,
                            cx.listener(move |root, _, _, cx| {
                                root.open_staff_access(cx);
                                root.select_staff_access(&id, cx);
                            }),
                        ))
                    },
                )
            });
        self.modal_with_height(
            body,
            (viewport.width - px(32.)).max(px(260.)).min(px(530.)),
            (viewport.height - px(32.)).max(px(200.)).min(px(625.)),
            Some(cx),
        )
    }
}

fn role_impact(role: AccountRole) -> Key {
    match role {
        AccountRole::Owner => Key::AccessRoleOwnerImpact,
        AccountRole::Staff => Key::AccountsStaffImpact,
        AccountRole::Client => Key::AccountsClientImpact,
    }
}

use super::staff_access::role_label;

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    async fn unlinked_role_confirmation_respects_verification_and_can_be_cancelled(
        cx: &mut TestAppContext,
    ) {
        let (_directory, window) = super::super::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                root.open_account_roles(cx);
                root.status.connectivity = Connectivity::Online;
                let Overlay::AccountRoles(desk) = &mut root.overlay else {
                    panic!("Missing account lookup")
                };
                desk.account = Some(UnlinkedAccount {
                    user_id: "synthetic-account".into(),
                    name: "Synthetic account".into(),
                    email: "account@example.test".into(),
                    email_verified: false,
                    role: AccountRole::Client,
                    generation: "initial".into(),
                    revision: "a".repeat(64),
                });
                root.review_account_role(AccountRole::Staff, cx);
                let Overlay::AccountRoles(desk) = &mut root.overlay else {
                    panic!("Missing role review")
                };
                assert!(desk.proposed.is_none());
                desk.account.as_mut().unwrap().email_verified = true;
                root.review_account_role(AccountRole::Staff, cx);
                assert!(matches!(&root.overlay, Overlay::AccountRoles(desk)
                if desk.proposed == Some(AccountRole::Staff) && !desk.busy));
                root.close_account_roles(cx);
                assert!(matches!(&root.overlay, Overlay::AccountRoles(desk)
                if desk.proposed.is_none() && desk.account.is_some() && !desk.busy));
            })
            .unwrap();
    }
}
