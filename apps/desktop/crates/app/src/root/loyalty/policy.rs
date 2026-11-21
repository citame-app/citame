use super::*;
use sob_core::loyalty::{Policy, PolicyFields, ReviewedPolicy};
use sob_core::reports::decimal_amount;

const FIELD_LABELS: [Key; 5] = [
    Key::LoyaltyProgrammeSpend,
    Key::LoyaltyProgrammeEarn,
    Key::LoyaltyProgrammeValue,
    Key::LoyaltyProgrammeLimit,
    Key::LoyaltyProgrammeExpiry,
];

pub(super) struct Editor {
    identity: Arc<()>,
    current: Option<ReviewedPolicy>,
    base: Option<ReviewedPolicy>,
    fields: [Entity<TextField>; 5],
    enabled: bool,
    review: Option<ReviewedPolicy>,
    busy: bool,
    confirm_exit: bool,
    feedback: Option<Key>,
    observed: Option<i64>,
    refresh_at: Instant,
    retry_at: Option<Instant>,
}

enum PolicyRequest {
    Refresh,
    Reload,
    Save(ReviewedPolicy),
}

fn policy_values(policy: &Policy) -> [String; 5] {
    [
        decimal_amount(policy.earn_every_cents.into()),
        policy.points_per_step.to_string(),
        decimal_amount(policy.redeem_value_cents.into()),
        decimal_amount(policy.maximum_discount_basis_points.into()),
        policy
            .expiry_days
            .map(|days| days.to_string())
            .unwrap_or_default(),
    ]
}

impl Editor {
    fn dirty(&self, cx: &App) -> bool {
        self.base.as_ref().is_some_and(|base| {
            self.enabled != base.policy.enabled
                || self
                    .fields
                    .iter()
                    .zip(policy_values(&base.policy))
                    .any(|(field, value)| field.read(cx).text() != value)
        })
    }

    fn stale(&self) -> bool {
        self.base.is_some() && self.base != self.current
    }

    fn can_save(&self) -> bool {
        let (Some(base), Some(current), Some(review)) = (&self.base, &self.current, &self.review)
        else {
            return false;
        };
        if base == current {
            return true;
        }
        let Some(next_version) = review.policy.version.checked_add(1) else {
            return false;
        };
        let mut expected = review.clone();
        expected.policy.version = next_version;
        expected == *current
    }

    fn replace(&mut self, saved: ReviewedPolicy, cx: &mut Context<Root>) {
        self.enabled = saved.policy.enabled;
        for (field, value) in self.fields.iter().zip(policy_values(&saved.policy)) {
            field.update(cx, |field, cx| field.set_text(&value, cx));
        }
        self.current = Some(saved.clone());
        self.base = Some(saved);
        self.review = None;
        self.feedback = None;
    }

    fn limited(&self) -> bool {
        self.retry_at
            .is_some_and(|deadline| Instant::now() < deadline)
    }
}

impl Root {
    pub(super) fn can_configure_points(&self) -> bool {
        self.svc
            .current_session()
            .is_some_and(|session| session.role == "owner")
    }

    fn points_policy(&mut self) -> Option<&mut Editor> {
        self.loyalty_desk()?.policy.as_mut()
    }

    pub(in crate::root) fn preserve_open_points_policy(&mut self, cx: &mut Context<Self>) -> bool {
        if !self.can_configure_points() {
            return false;
        }
        let Some(desk) = self.loyalty_desk() else {
            return false;
        };
        let Some(editor) = &mut desk.policy else {
            return false;
        };
        desk.results.clear();
        desk.selected = None;
        desk.statement = None;
        desk.request = None;
        desk.loading = false;
        for field in [&desk.search, &desk.points, &desk.reason] {
            field.update(cx, |field, cx| field.clear(cx));
        }
        editor.identity = Arc::new(());
        editor.busy = false;
        editor.current = None;
        editor.refresh_at = Instant::now();
        true
    }

    pub(super) fn open_points_policy(&mut self, cx: &mut Context<Self>) {
        if !self.can_configure_points() {
            return;
        }
        let Some(desk) = self
            .loyalty_desk()
            .filter(|desk| desk.adjustment.is_none() && !desk.saving)
        else {
            return;
        };
        desk.policy = Some(Editor {
            identity: Arc::new(()),
            current: None,
            base: None,
            fields: std::array::from_fn(|_| cx.new(|cx| TextField::new("", false, cx))),
            enabled: false,
            review: None,
            busy: false,
            confirm_exit: false,
            feedback: None,
            observed: None,
            refresh_at: Instant::now(),
            retry_at: None,
        });
        self.request_points_policy(PolicyRequest::Refresh, cx);
    }

    pub(super) fn refresh_points_policy(
        &mut self,
        reconnected: bool,
        observed: Option<i64>,
        cx: &mut Context<Self>,
    ) {
        if !self.can_configure_points() {
            self.overlay = Overlay::None;
            cx.notify();
            return;
        }
        let Some(editor) = self.points_policy() else {
            return;
        };
        if editor.limited() {
            return;
        }
        if editor.retry_at.take().is_some() {
            cx.notify();
        }
        if !editor.busy
            && (reconnected || observed != editor.observed || Instant::now() >= editor.refresh_at)
        {
            self.request_points_policy(PolicyRequest::Refresh, cx);
        }
    }

    fn request_points_policy(&mut self, request: PolicyRequest, cx: &mut Context<Self>) {
        let Some(transport) = self.svc.transport().filter(|_| {
            self.can_configure_points() && self.status.connectivity == Connectivity::Online
        }) else {
            return;
        };
        let session = self.svc.session.clone();
        let observed = self.svc.store.live_view_revision(LIVE_TOPIC).ok();
        let Some(editor) = self
            .points_policy()
            .filter(|editor| !editor.busy && !editor.limited())
        else {
            return;
        };
        let identity = editor.identity.clone();
        let writing = matches!(request, PolicyRequest::Save(_));
        let replace = matches!(request, PolicyRequest::Reload);
        editor.busy = true;
        editor.observed = observed;
        editor.refresh_at = Instant::now() + Duration::from_secs(15);
        if replace || writing {
            editor.feedback = None;
        }
        cx.notify();
        cx.spawn(async move |root, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    match request {
                        PolicyRequest::Save(review) => {
                            transport.save_loyalty_policy(&review.generation, &review.policy)
                        }
                        PolicyRequest::Refresh | PolicyRequest::Reload => {
                            transport.loyalty_policy()
                        }
                    }
                })
                .await;
            let _ = root.update(cx, |root, cx| {
                if !Arc::ptr_eq(&session, &root.svc.session) || !root.can_configure_points() {
                    return;
                }
                let Some(editor) = root
                    .points_policy()
                    .filter(|editor| Arc::ptr_eq(&identity, &editor.identity))
                else {
                    return;
                };
                editor.busy = false;
                match result {
                    Ok(policy)
                        if replace || writing || (!editor.dirty(cx) && editor.review.is_none()) =>
                    {
                        let feedback = editor.feedback;
                        if editor.base.as_ref() != Some(&policy) || replace || writing {
                            editor.replace(policy, cx);
                        }
                        editor.feedback = if writing {
                            Some(Key::LoyaltyProgrammeSaved)
                        } else {
                            feedback
                                .filter(|key| *key != Key::LoyaltyProgrammeLoadFailed && !replace)
                        };
                    }
                    Ok(policy) => editor.current = Some(policy),
                    Err(TransportError::Forbidden(_) | TransportError::Unauthorized) => {
                        editor.current = None;
                        editor.base = None;
                        editor.review = None;
                        editor.feedback = Some(Key::LoyaltyProgrammeLoadFailed);
                    }
                    Err(error) => {
                        if let TransportError::RateLimited(delay) = &error {
                            editor.retry_at = Instant::now()
                                .checked_add(delay.unwrap_or(Duration::from_secs(10)));
                        }
                        if writing {
                            editor.feedback = Some(match error {
                                TransportError::ReplicaGenerationChanged
                                | TransportError::BadRequest(_) => {
                                    editor.current = None;
                                    editor.refresh_at = Instant::now();
                                    Key::LoyaltyProgrammeChanged
                                }
                                _ => Key::LoyaltyProgrammeUnconfirmed,
                            });
                        } else if editor.feedback.is_none() || replace {
                            editor.feedback = Some(Key::LoyaltyProgrammeLoadFailed);
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn review_points_policy(&mut self, cx: &mut Context<Self>) {
        let Some(editor) = self
            .points_policy()
            .filter(|editor| !editor.busy && !editor.stale())
        else {
            return;
        };
        let Some(base) = &editor.base else {
            return;
        };
        let [
            earn_amount,
            points_per_step,
            redeem_value,
            maximum_discount,
            expiry_days,
        ] = editor.fields.each_ref().map(|field| field.read(cx).text());
        let fields = PolicyFields {
            earn_amount,
            points_per_step,
            redeem_value,
            maximum_discount,
            expiry_days,
        };
        let Some(policy) = base.policy.edit(editor.enabled, fields) else {
            editor.feedback = Some(Key::LoyaltyProgrammeInvalid);
            cx.notify();
            return;
        };
        if policy != base.policy {
            editor.review = Some(ReviewedPolicy {
                generation: base.generation.clone(),
                policy,
            });
            editor.feedback = None;
            cx.notify();
        }
    }

    fn save_points_policy(&mut self, cx: &mut Context<Self>) {
        if let Some(review) = self
            .points_policy()
            .filter(|editor| editor.can_save())
            .and_then(|editor| editor.review.clone())
        {
            self.request_points_policy(PolicyRequest::Save(review), cx);
        }
    }

    pub(super) fn close_points_policy(&mut self, confirm: bool, cx: &mut Context<Self>) {
        let directory = self.directory_enabled();
        let Some(editor) = self.points_policy() else {
            return;
        };
        if editor.busy {
            return;
        }
        if editor.confirm_exit && !confirm {
            editor.confirm_exit = false;
        } else if editor.dirty(cx) && !editor.confirm_exit {
            editor.confirm_exit = true;
        } else if !directory {
            self.overlay = Overlay::None;
        } else if let Some(desk) = self.loyalty_desk() {
            desk.policy = None;
        }
        cx.notify();
    }

    pub(super) fn render_points_policy(
        &self,
        editor: &Editor,
        viewport: gpui::Size<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let online = self.status.connectivity == Connectivity::Online;
        let ready = online && !editor.busy && !editor.limited();
        let body = div()
            .flex()
            .flex_col()
            .gap_3()
            .when(!online, |body| body.child(self.t(Key::LoyaltyOffline)))
            .when(editor.busy, |body| {
                body.child(self.t(Key::MarketingLoading))
            })
            .when_some(editor.feedback, |body, key| body.child(self.t(key)))
            .when(editor.stale() && !editor.can_save(), |body| {
                body.child(self.t(Key::LoyaltyProgrammeChanged))
            });
        let body = if editor.confirm_exit {
            body.child(self.t(Key::LoyaltyProgrammeDiscard))
                .child(self.loyalty_button(
                    "keep-points-policy",
                    Key::Back,
                    Kind::Ghost,
                    |root, cx| root.close_points_policy(false, cx),
                    cx,
                ))
        } else if let Some(review) = &editor.review {
            let values = policy_values(&review.policy);
            body.child(self.t(if review.policy.enabled {
                Key::LoyaltyProgrammeOn
            } else {
                Key::LoyaltyDisabled
            }))
            .children(FIELD_LABELS.into_iter().zip(values).map(|(key, value)| {
                div().child(self.label(key)).child(if value.is_empty() {
                    self.t(Key::LoyaltyProgrammeNoExpiry).to_string()
                } else {
                    value
                })
            }))
            .when(ready && editor.can_save(), |body| {
                body.child(self.loyalty_button(
                    "confirm-points-policy",
                    Key::LoyaltyProgrammeSave,
                    Kind::Primary,
                    Root::save_points_policy,
                    cx,
                ))
            })
            .when(
                !editor.busy && editor.feedback != Some(Key::LoyaltyProgrammeUnconfirmed),
                |body| {
                    body.child(self.loyalty_button(
                        "edit-points-policy",
                        Key::Back,
                        Kind::Ghost,
                        |root, cx| {
                            if let Some(editor) = root.points_policy() {
                                editor.review = None;
                                cx.notify();
                            }
                        },
                        cx,
                    ))
                },
            )
        } else {
            body.when(editor.base.is_some(), |body| {
                body.child(self.loyalty_button(
                    "toggle-points-policy",
                    if editor.enabled {
                        Key::LoyaltyProgrammeOn
                    } else {
                        Key::LoyaltyProgrammeOff
                    },
                    Kind::Ghost,
                    |root, cx| {
                        if let Some(editor) = root.points_policy() {
                            editor.enabled = !editor.enabled;
                            cx.notify();
                        }
                    },
                    cx,
                ))
                .children(
                    FIELD_LABELS
                        .into_iter()
                        .zip(&editor.fields)
                        .map(|(key, field)| {
                            div().w_full().child(self.label(key)).child(field.clone())
                        }),
                )
                .when(ready && !editor.stale() && editor.dirty(cx), |body| {
                    body.child(self.loyalty_button(
                        "review-points-policy",
                        Key::LoyaltyProgrammeReview,
                        Kind::Primary,
                        Root::review_points_policy,
                        cx,
                    ))
                })
            })
        };
        self.modal_with_height(
            div()
                .tab_group()
                .child(self.label(Key::LoyaltyProgramme))
                .child(
                    div()
                        .id("points-policy-scroll")
                        .min_h_0()
                        .overflow_y_scroll()
                        .child(body),
                )
                .when(
                    ready
                        && !editor.confirm_exit
                        && (editor.base.is_none()
                            || editor.stale()
                            || editor.feedback == Some(Key::LoyaltyProgrammeUnconfirmed)),
                    |panel| {
                        panel.child(self.loyalty_button(
                            "reload-points-policy",
                            Key::LoyaltyProgrammeReload,
                            Kind::Ghost,
                            |root, cx| root.request_points_policy(PolicyRequest::Reload, cx),
                            cx,
                        ))
                    },
                )
                .when(!editor.busy, |panel| {
                    panel.child(self.loyalty_button(
                        "close-points-policy",
                        if editor.confirm_exit {
                            Key::LoyaltyProgrammeDrop
                        } else {
                            Key::Close
                        },
                        Kind::Ghost,
                        |root, cx| root.close_points_policy(true, cx),
                        cx,
                    ))
                }),
            (viewport.width - px(24.)).clamp(px(0.), px(580.)),
            (viewport.height - px(24.)).clamp(px(0.), px(720.)),
            None,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[gpui::test]
    async fn restoring_the_replica_fences_a_review_without_discarding_it(
        cx: &mut gpui::TestAppContext,
    ) {
        let (_directory, window) = crate::root::tests::open(cx);
        window
            .update(cx, |root, _, cx| {
                root.svc.stop_sync();
                root.svc
                    .store
                    .set_meta("client_directory", "allowed")
                    .unwrap();
                root.status.connectivity = Connectivity::Offline;
                root.open_loyalty(cx);
                root.open_points_policy(cx);
                let current = ReviewedPolicy {
                    generation: "old-generation".into(),
                    policy: Policy {
                        enabled: false,
                        earn_every_cents: 100,
                        points_per_step: 1,
                        redeem_value_cents: 1,
                        maximum_discount_basis_points: 2_000,
                        expiry_days: Some(365),
                        version: 2,
                    },
                };
                let editor = root.points_policy().unwrap();
                editor.replace(current, cx);
                editor.enabled = true;
                root.review_points_policy(cx);
                assert!(root.points_policy().unwrap().can_save());

                let desk = root.loyalty_desk().unwrap();
                desk.search
                    .update(cx, |field, cx| field.set_text("Private search", cx));
                desk.results.push((Uuid::now_v7(), "Private client".into()));
                root.replica_generation = Some("old-generation".into());
                root.reload(cx);
                let desk = root.loyalty_desk().unwrap();
                assert!(desk.search.read(cx).text().is_empty());
                assert!(desk.results.is_empty());
                let editor = root.points_policy().unwrap();
                assert!(editor.review.as_ref().unwrap().policy.enabled);
                assert!(editor.stale());
                assert!(!editor.can_save());

                root.svc.session.write().unwrap().as_mut().unwrap().role = "staff".into();
                root.refresh_loyalty(false, cx);
                assert!(matches!(root.overlay, Overlay::None));
            })
            .unwrap();
    }
}
