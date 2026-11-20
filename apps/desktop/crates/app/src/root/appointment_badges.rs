use super::*;
use gpui::{PathBuilder, Pixels, Point, Rgba, canvas, point, rgb};

#[derive(Clone, Copy)]
pub(super) enum Icon {
    Paid,
    Invoice,
    Requested,
    Note,
    Comment,
    Pending,
    Conflict,
    External,
}

impl Icon {
    fn colors(self) -> (Rgba, Rgba) {
        let (light, dark) = match self {
            Self::Paid => ((0x17634d, 0xd8f3e7), (0x93ebc7, 0x163f35)),
            Self::Invoice => ((0x294c8e, 0xe3ecff), (0xb8ceff, 0x263859)),
            Self::Requested => ((0x9b315c, 0xfbe2ed), (0xffadd0, 0x51263b)),
            Self::Note => ((0x69468d, 0xf0e6fb), (0xdcbdff, 0x422d57)),
            Self::Comment => ((0x16626e, 0xdcf3f6), (0xa2e4ed, 0x1d4249)),
            Self::Pending => return (theme::pending_fg(), theme::pending_bg()),
            Self::Conflict => return (theme::conflict_fg(), theme::conflict_bg()),
            Self::External => return (theme::muted(), theme::panel()),
        };
        let (fg, bg) = if theme::is_dark() { dark } else { light };
        (rgb(fg), rgb(bg))
    }

    fn draw(self, at: Point<Pixels>, path: &mut PathBuilder) {
        path.translate(at);
        let p = |x, y| point(px(x), px(y));
        match self {
            Self::Requested => {
                path.move_to(p(6., 10.7));
                path.cubic_bezier_to(p(1.2, 4.), p(2.2, 8.1), p(1.2, 6.3));
                path.cubic_bezier_to(p(6., 3.3), p(1.2, 1.5), p(4.5, 0.8));
                path.cubic_bezier_to(p(10.8, 4.), p(7.5, 0.8), p(10.8, 1.5));
                path.cubic_bezier_to(p(6., 10.7), p(10.8, 6.3), p(9.8, 8.1));
                path.close();
            }
            _ => {
                let lines: &[&[(f32, f32)]] = match self {
                    Self::Paid => &[&[(1.5, 6.3), (4.5, 9.3), (10.5, 3.2)]],
                    Self::Invoice => &[
                        &[
                            (2., 1.5),
                            (10., 1.5),
                            (10., 10.5),
                            (8., 9.2),
                            (6., 10.5),
                            (4., 9.2),
                            (2., 10.5),
                            (2., 1.5),
                        ],
                        &[(4., 4.), (8., 4.)],
                        &[(4., 6.4), (8., 6.4)],
                    ],
                    Self::Note => &[
                        &[
                            (1.8, 1.6),
                            (10.2, 1.6),
                            (10.2, 7.2),
                            (7., 10.4),
                            (1.8, 10.4),
                            (1.8, 1.6),
                        ],
                        &[(7., 10.4), (7., 7.2), (10.2, 7.2)],
                        &[(4., 4.4), (8., 4.4)],
                    ],
                    Self::Comment => &[
                        &[
                            (1.5, 2.2),
                            (10.5, 2.2),
                            (10.5, 8.),
                            (5.7, 8.),
                            (3., 10.6),
                            (3., 8.),
                            (1.5, 8.),
                            (1.5, 2.2),
                        ],
                        &[(3.8, 5.2), (8.2, 5.2)],
                    ],
                    Self::Pending => &[
                        &[(6., 2.6), (6., 6.), (8.3, 7.3)],
                        &[
                            (6., 1.),
                            (9.5, 2.5),
                            (11., 6.),
                            (9.5, 9.5),
                            (6., 11.),
                            (2.5, 9.5),
                            (1., 6.),
                            (2.5, 2.5),
                            (6., 1.),
                        ],
                    ],
                    Self::Conflict => &[&[(6., 2.), (6., 6.7)], &[(6., 9.), (6., 10.)]],
                    Self::External => &[
                        &[(5., 2.), (2., 2.), (2., 10.), (10., 10.), (10., 7.)],
                        &[(7., 1.4), (10.6, 1.4), (10.6, 5.)],
                        &[(10.6, 1.4), (5.7, 6.3)],
                    ],
                    Self::Requested => unreachable!(),
                };
                for line in lines {
                    let [(x, y), rest @ ..] = line else { continue };
                    path.move_to(p(*x, *y));
                    for &(x, y) in rest {
                        path.line_to(p(x, y));
                    }
                }
            }
        }
    }

    pub(super) fn element(self, color: Rgba) -> impl IntoElement {
        canvas(
            |_, _, _| (),
            move |bounds, (), window, _| {
                let mut path = PathBuilder::stroke(px(1.35));
                self.draw(bounds.origin, &mut path);
                if let Ok(path) = path.build() {
                    window.paint_path(path, color);
                }
            },
        )
        .size(px(12.))
        .flex_none()
    }
}

#[derive(Clone, Copy)]
pub(super) struct Indicator(pub(super) Icon, pub(super) Key);

struct BadgeTooltip(&'static str);

impl Render for BadgeTooltip {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .px_2()
            .py_1()
            .rounded_md()
            .border_1()
            .border_color(theme::line())
            .bg(theme::panel())
            .text_color(theme::text())
            .text_xs()
            .child(self.0)
    }
}

impl Indicator {
    pub(super) fn chip(self, label: &'static str, compact: bool) -> impl IntoElement {
        let (fg, bg) = self.0.colors();
        let chip = div()
            .h(px(if compact { 16. } else { 22. }))
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .gap_1()
            .rounded_full()
            .bg(bg)
            .text_color(fg)
            .text_xs()
            .child(self.0.element(fg));
        if compact {
            chip.id(label)
                .w(px(16.))
                .tooltip(move |_, cx| cx.new(|_| BadgeTooltip(label)).into())
                .into_any_element()
        } else {
            chip.px_2().child(label).into_any_element()
        }
    }
}

pub(super) fn service(badge: &CalendarServiceBadge) -> [Option<Indicator>; 4] {
    let billing = match (badge.billing_source, badge.paid, badge.invoiced) {
        (source, true, _) => Some(Indicator(
            Icon::Paid,
            match source {
                Some(CalendarBillingSource::Booksy) => Key::ImportedPaid,
                Some(CalendarBillingSource::Citame) => Key::CitameAppointmentPaid,
                None => Key::AppointmentPaidBadge,
            },
        )),
        (source, false, true) => Some(Indicator(
            Icon::Invoice,
            match source {
                Some(CalendarBillingSource::Booksy) => Key::ImportedInvoiced,
                Some(CalendarBillingSource::Citame) => Key::CitameAppointmentInvoiced,
                None => Key::AppointmentInvoicedBadge,
            },
        )),
        _ => None,
    };
    [
        billing,
        badge
            .requested
            .then_some(Indicator(Icon::Requested, Key::RequestedProfessional)),
        badge
            .internal_note
            .then_some(Indicator(Icon::Note, Key::AppointmentInternalNote)),
        badge
            .customer_comment
            .then_some(Indicator(Icon::Comment, Key::AppointmentCustomerComment)),
    ]
}

pub(super) fn calendar(item: &CalendarItem) -> [Option<Indicator>; 5] {
    let appointment = &item.appointment;
    let badges = &appointment.service_badges;
    let covers_all = !badges.is_empty() && badges.len() == appointment.services.len();
    let billing = if covers_all && badges.iter().all(|badge| badge.paid) {
        Some(Indicator(Icon::Paid, Key::AppointmentPaidBadge))
    } else if covers_all && badges.iter().all(|badge| badge.invoiced) {
        Some(Indicator(Icon::Invoice, Key::AppointmentInvoicedBadge))
    } else if badges.iter().any(|badge| badge.invoiced || badge.paid) {
        Some(Indicator(
            Icon::Invoice,
            Key::AppointmentPartialBillingBadge,
        ))
    } else {
        None
    };
    [
        if item.conflict {
            Some(Indicator(Icon::Conflict, Key::ConflictBadge))
        } else {
            item.pending
                .then_some(Indicator(Icon::Pending, Key::PendingBadge))
        },
        billing,
        badges
            .iter()
            .any(|badge| badge.requested)
            .then_some(Indicator(Icon::Requested, Key::RequestedProfessional)),
        badges
            .iter()
            .any(|badge| badge.internal_note)
            .then_some(Indicator(Icon::Note, Key::AppointmentInternalNote)),
        badges
            .iter()
            .any(|badge| badge.customer_comment)
            .then_some(Indicator(Icon::Comment, Key::AppointmentCustomerComment)),
    ]
}
