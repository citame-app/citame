use super::*;
use sob_core::auth::BrowserWorkspace;

pub(super) struct CloudDesk {
    areas: Option<Vec<BrowserWorkspace>>,
    loading: Option<Arc<()>>,
    opening: Option<Arc<()>>,
    error: Option<Key>,
}

fn workspace_label(area: BrowserWorkspace) -> Option<Key> {
    Some(match area {
        BrowserWorkspace::Clients => Key::ClientDirectory,
        BrowserWorkspace::Services => Key::SaleServices,
        BrowserWorkspace::Staff => Key::Staff,
        BrowserWorkspace::Resources => Key::CloudResources,
        BrowserWorkspace::Sales => Key::WalkInSale,
        BrowserWorkspace::Transactions => Key::SalesHistory,
        BrowserWorkspace::Inventory => Key::Inventory,
        BrowserWorkspace::Benefits => Key::CloudBenefits,
        BrowserWorkspace::Reports => Key::Reports,
        BrowserWorkspace::Commissions => Key::CloudCommissions,
        BrowserWorkspace::Marketing => Key::CloudMarketing,
        BrowserWorkspace::Reputation => Key::Reputation,
        BrowserWorkspace::IntakeForms => Key::FormAdmin,
        BrowserWorkspace::Settings => Key::CloudSettings,
        BrowserWorkspace::Whatsapp => Key::CloudWhatsapp,
        BrowserWorkspace::Waitlist => Key::Waitlist,
        BrowserWorkspace::Unknown => return None,
    })
}

impl Root {
    pub(super) fn open_web_management(&mut self, cx: &mut Context<Self>) {
        self.overlay = Overlay::Cloud(CloudDesk {
            areas: None,
            loading: None,
            opening: None,
            error: None,
        });
        cx.notify();
        if self.status.connectivity == Connectivity::Online {
            self.load_web_workspaces(cx);
        }
    }

    fn load_web_workspaces(&mut self, cx: &mut Context<Self>) {
        let Some(transport) = self.svc.transport() else {
            return;
        };
        let Overlay::Cloud(desk) = &mut self.overlay else {
            return;
        };
        if desk.loading.is_some() || desk.opening.is_some() {
            return;
        }
        let request = Arc::new(());
        desk.loading = Some(request.clone());
        desk.error = None;
        let session = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let response = cx
                .background_executor()
                .spawn(async move { transport.browser_workspaces() })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) {
                    return;
                }
                let Overlay::Cloud(desk) = &mut root.overlay else {
                    return;
                };
                if !desk
                    .loading
                    .as_ref()
                    .is_some_and(|pending| Arc::ptr_eq(pending, &request))
                {
                    return;
                }
                desk.loading = None;
                match response {
                    Ok(areas) => desk.areas = Some(areas),
                    Err(_) => desk.error = Some(Key::CloudWorkspacesUnavailable),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn open_web_workspace(&mut self, area: Option<BrowserWorkspace>, cx: &mut Context<Self>) {
        let Some(session) = self.svc.current_session() else {
            return;
        };
        let Some(calendar) = self.cloud_calendar_url() else {
            return;
        };
        let Overlay::Cloud(desk) = &mut self.overlay else {
            return;
        };
        if desk.opening.is_some() || self.status.connectivity != Connectivity::Online {
            return;
        }
        let request = Arc::new(());
        desk.opening = Some(request.clone());
        desk.error = None;
        let auth = self.svc.auth.clone();
        let session_handle = self.svc.session.clone();
        cx.notify();
        cx.spawn(async move |root, cx| {
            let handoff = cx
                .background_executor()
                .spawn(async move {
                    match area {
                        Some(area) => auth.begin_browser_workspace(&session, area),
                        None => auth.begin_browser_calendar(&session, &calendar),
                    }
                    .ok()
                    .flatten()
                })
                .await;
            let should_open = root
                .update(cx, |root, cx| {
                    if !Arc::ptr_eq(&session_handle, &root.svc.session)
                        || root.svc.current_session().is_none()
                    {
                        return false;
                    }
                    let Overlay::Cloud(desk) = &mut root.overlay else {
                        return false;
                    };
                    if !desk
                        .opening
                        .as_ref()
                        .is_some_and(|pending| Arc::ptr_eq(pending, &request))
                    {
                        return false;
                    }
                    desk.opening = None;
                    if let Some(local) = &handoff {
                        root.overlay = Overlay::None;
                        cx.open_url(&local.url());
                        cx.notify();
                        true
                    } else {
                        if area.is_some() {
                            desk.areas = None;
                        }
                        desk.error = Some(Key::OpenCloudCalendarError);
                        cx.notify();
                        false
                    }
                })
                .unwrap_or(false);
            if should_open && let Some(handoff) = handoff {
                cx.background_executor()
                    .spawn(async move { handoff.serve() })
                    .await;
            }
        })
        .detach();
    }

    pub(super) fn render_web_management(
        &self,
        desk: &CloudDesk,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let body = div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::BOLD)
                    .child(self.t(Key::CloudManagement)),
            )
            .when(!online, |view| {
                view.child(self.t(Key::CloudWorkspacesOffline))
            })
            .when(
                online && (desk.loading.is_some() || desk.opening.is_some()),
                |view| view.child(self.t(Key::CloudWorkspacesLoading)),
            )
            .when_some(desk.error, |view, key| {
                view.child(
                    div()
                        .text_sm()
                        .text_color(theme::conflict_fg())
                        .child(self.t(key)),
                )
            })
            .when(self.can_configure_salon(), |view| {
                view.child(self.button(
                    "salon-configuration",
                    self.t(Key::SalonConfiguration),
                    Kind::Ghost,
                    cx.listener(|root, _, _, cx| root.open_salon_configuration(cx)),
                ))
            })
            .when(online && desk.opening.is_none(), |view| {
                let links = div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(self.button(
                        "cloud-calendar",
                        self.t(Key::OpenCloudCalendar),
                        Kind::Primary,
                        cx.listener(|root, _, _, cx| root.open_web_workspace(None, cx)),
                    ))
                    .children(desk.areas.iter().flatten().enumerate().filter_map(
                        |(index, area)| {
                            let area = *area;
                            let key = workspace_label(area)?;
                            Some(self.button(
                                ("cloud-workspace", index),
                                self.t(key),
                                Kind::Ghost,
                                cx.listener(move |root, _, _, cx| {
                                    if matches!(area, BrowserWorkspace::IntakeForms) {
                                        root.open_intake_forms(cx);
                                    } else {
                                        root.open_web_workspace(Some(area), cx);
                                    }
                                }),
                            ))
                        },
                    ))
                    .when(desk.areas.is_none() && desk.loading.is_none(), |list| {
                        list.child(self.button(
                            "cloud-reload",
                            self.t(Key::CloudReloadWorkspaces),
                            Kind::Ghost,
                            cx.listener(|root, _, _, cx| root.load_web_workspaces(cx)),
                        ))
                    });
                view.child(
                    div()
                        .id("cloud-workspace-list")
                        .max_h((viewport.height - px(235.)).max(px(95.)))
                        .overflow_y_scroll()
                        .child(links),
                )
            })
            .child(self.button(
                "close-cloud-workspaces",
                self.t(Key::Close),
                Kind::Ghost,
                cx.listener(|root, _, _, cx| root.dismiss_overlay(cx)),
            ));
        self.modal_with_height(
            body,
            (viewport.width - px(32.)).max(px(220.)).min(px(620.)),
            (viewport.height - px(24.)).max(px(180.)),
            None,
        )
    }
}
