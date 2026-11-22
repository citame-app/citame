use super::*;
use sob_core::http::marketing::{InvitationContact, MAX_INVITATION_CONTACTS};
use std::collections::HashMap;

const PAGE_SIZE: usize = 10;

pub(super) struct InvitationEditor {
    selected: Vec<String>,
    contacts: Vec<Client>,
    names: HashMap<String, String>,
    search: Entity<TextField>,
    _subscription: Subscription,
    page: usize,
}

impl InvitationEditor {
    pub(super) fn new(
        root: &Root,
        selected: Vec<String>,
        names: Vec<InvitationContact>,
        cx: &mut Context<Root>,
    ) -> Self {
        let contacts = calendar::directory_clients(&root.svc.store)
            .unwrap_or_default()
            .clients;
        let names = names
            .into_iter()
            .map(|contact| (contact.id, contact.name))
            .chain(contacts.iter().map(|c| (c.id.clone(), c.name.clone())))
            .collect();
        let search = cx.new(|cx| TextField::new(root.t(Key::DirectorySearch), false, cx));
        let subscription = cx.subscribe(&search, |root: &mut Root, _, event, cx| {
            if matches!(event, FieldEvent::Changed)
                && let Some(editor) = root.invitation_editor()
            {
                editor.page = 0;
                cx.notify();
            }
        });
        Self {
            selected,
            contacts,
            names,
            search,
            _subscription: subscription,
            page: 0,
        }
    }

    pub(super) fn packet(&self) -> Option<Vec<String>> {
        (!self.selected.is_empty() && self.selected.len() <= MAX_INVITATION_CONTACTS)
            .then(|| self.selected.clone())
    }

    pub(super) fn toggle(&mut self, id: &str) {
        if let Some(index) = self.selected.iter().position(|selected| selected == id) {
            self.selected.remove(index);
        } else if self.selected.len() < MAX_INVITATION_CONTACTS {
            self.selected.push(id.to_owned());
        }
    }
}

impl Root {
    pub(in crate::root) fn reload_marketing_invitation_contacts(&mut self) {
        if self.invitation_editor().is_none() {
            return;
        }
        let contacts = calendar::directory_clients(&self.svc.store)
            .unwrap_or_default()
            .clients;
        let Some(editor) = self.invitation_editor() else {
            return;
        };
        editor.names = contacts
            .iter()
            .map(|c| (c.id.clone(), c.name.clone()))
            .collect();
        if editor.contacts.len() != contacts.len() {
            editor.page = 0;
        }
        editor.contacts = contacts;
    }

    fn invitation_editor(&mut self) -> Option<&mut InvitationEditor> {
        let editor = self.marketing_desk()?.editor.as_mut()?;
        if editor.pending.is_some() || editor.stale {
            return None;
        }
        editor.invitation.as_mut()
    }

    pub(super) fn render_invitation_contacts(
        &self,
        editor: &InvitationEditor,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let search = text(&editor.search, cx).to_lowercase();
        let mut matches = editor
            .contacts
            .iter()
            .filter(|client| {
                search.is_empty()
                    || client.name.to_lowercase().contains(&search)
                    || client
                        .email
                        .as_ref()
                        .is_some_and(|email| email.to_lowercase().contains(&search))
                    || client
                        .phone
                        .as_ref()
                        .is_some_and(|phone| phone.contains(&search))
            })
            .skip(editor.page * PAGE_SIZE);
        let visible = matches.by_ref().take(PAGE_SIZE).collect::<Vec<_>>();
        let has_more = matches.next().is_some();
        let choice = |group: &'static str, id: &str, label: String, selected| {
            let id = id.to_owned();
            (
                SharedString::from(format!("{group}:{id}")),
                id,
                label,
                selected,
            )
        };
        let selected = editor.selected.iter().map(|id| {
            let name = editor
                .names
                .get(id)
                .map(String::as_str)
                .unwrap_or_else(|| self.t(Key::MarketingInvitationUnavailable));
            choice(
                "remove-invite-contact",
                id,
                format!("{} · {name}", self.t(Key::SaleRemove)),
                true,
            )
        });
        let candidates = visible.iter().map(|client| {
            let detail = client.email.as_deref().or(client.phone.as_deref());
            let label = detail.map_or_else(
                || client.name.clone(),
                |detail| format!("{} · {detail}", client.name),
            );
            choice(
                "toggle-invite-contact",
                &client.id,
                label,
                editor.selected.contains(&client.id),
            )
        });
        let mut render_choice = |(element, id, label, checked): (_, String, String, bool)| {
            self.chip(
                element,
                label,
                checked,
                cx.listener(move |root, _, _, cx| {
                    if let Some(editor) = root.invitation_editor() {
                        editor.toggle(&id);
                        cx.notify();
                    }
                }),
            )
            .tab_index(0)
            .focus(|style| style.border_color(theme::text()))
        };
        let selected = selected.map(&mut render_choice).collect::<Vec<_>>();
        let candidates = candidates
            .filter(|(_, _, _, checked)| {
                *checked || editor.selected.len() < MAX_INVITATION_CONTACTS
            })
            .map(render_choice)
            .collect::<Vec<_>>();
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(self.label(Key::MarketingInvitationSelected))
            .child(format!(
                "{} / {}",
                editor.selected.len(),
                MAX_INVITATION_CONTACTS
            ))
            .child(i18n::fill(
                self.t(Key::MarketingInvitationHelp),
                &[("count", &MAX_INVITATION_CONTACTS.to_string())],
            ))
            .child(div().flex().flex_wrap().gap_2().children(selected))
            .child(self.label(Key::DirectorySearch))
            .child(editor.search.clone())
            .when(visible.is_empty(), |body| {
                body.child(self.t(Key::DirectoryEmpty))
            })
            .child(div().flex().flex_wrap().gap_2().children(candidates))
            .child(
                div()
                    .flex()
                    .gap_2()
                    .when(editor.page > 0, |row| {
                        row.child(self.marketing_button(
                            "invite-previous-page",
                            Key::MarketingPreviousPage,
                            Kind::Ghost,
                            |root, cx| {
                                if let Some(editor) = root.invitation_editor() {
                                    editor.page = editor.page.saturating_sub(1);
                                    cx.notify();
                                }
                            },
                            cx,
                        ))
                    })
                    .when(has_more, |row| {
                        row.child(self.marketing_button(
                            "invite-next-page",
                            Key::MarketingNextPage,
                            Kind::Ghost,
                            |root, cx| {
                                if let Some(editor) = root.invitation_editor() {
                                    editor.page += 1;
                                    cx.notify();
                                }
                            },
                            cx,
                        ))
                    }),
            )
    }
}
