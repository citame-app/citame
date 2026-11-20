use std::{cell::Cell, rc::Rc};

use gpui::{
    Bounds, Context, MouseButton, Pixels, Point, ScrollHandle, canvas, div, fill, point,
    prelude::*, px, size,
};

use super::Root;
use crate::theme;

pub(super) const WIDTH: f32 = 14.0;

#[derive(Clone, Copy)]
pub(super) enum Axis {
    Horizontal,
    Vertical,
}

#[derive(Clone, Default)]
pub(super) struct Scrollbar {
    pub handle: ScrollHandle,
    drag: Rc<Cell<Option<Pixels>>>,
}

struct Thumb {
    start: Pixels,
    track: Pixels,
    length: Pixels,
    travel: Pixels,
    range: Pixels,
}

impl Axis {
    fn coordinates(self, p: Point<Pixels>) -> Pixels {
        match self {
            Self::Horizontal => p.x,
            Self::Vertical => p.y,
        }
    }
}

impl Scrollbar {
    fn thumb(&self, axis: Axis) -> Option<Thumb> {
        let viewport = self.handle.bounds();
        let max = self.handle.max_offset();
        let (track, range) = match axis {
            Axis::Horizontal => (viewport.size.width, max.width),
            Axis::Vertical => (viewport.size.height, max.height),
        };
        if range <= px(0.) || track <= px(0.) {
            return None;
        }
        let origin = axis.coordinates(viewport.origin);
        let length = px(
            (f32::from(track) / f32::from(track + range) * f32::from(track))
                .max(24.)
                .min(f32::from(track)),
        );
        let travel = track - length;
        let progress = -f32::from(axis.coordinates(self.handle.offset())) / f32::from(range);
        Some(Thumb {
            start: origin + travel * progress,
            track: origin,
            length,
            travel,
            range,
        })
    }

    fn move_thumb(&self, axis: Axis, position: Point<Pixels>, grab: Pixels, thumb: Thumb) {
        if thumb.travel <= px(0.) {
            return;
        }
        let progress = (f32::from(axis.coordinates(position) - thumb.track - grab)
            / f32::from(thumb.travel))
        .clamp(0., 1.);
        let distance = -thumb.range * progress;
        self.handle.set_offset(match axis {
            Axis::Horizontal => point(distance, px(0.)),
            Axis::Vertical => point(px(0.), distance),
        });
    }

    pub fn render(&self, axis: Axis, cx: &mut Context<Root>) -> gpui::Div {
        let selector = match axis {
            Axis::Horizontal => "calendar-horizontal-scrollbar",
            Axis::Vertical => "calendar-vertical-scrollbar",
        };
        self.render_named(axis, selector, cx)
    }

    pub fn render_named(
        &self,
        axis: Axis,
        selector: &'static str,
        cx: &mut Context<Root>,
    ) -> gpui::Div {
        let press = self.clone();
        let drag = self.clone();
        let release = self.drag.clone();
        let paint = self.clone();
        div()
            .debug_selector(move || selector.to_owned())
            .when(matches!(axis, Axis::Horizontal), |track| {
                track.h(px(WIDTH)).w_full()
            })
            .when(matches!(axis, Axis::Vertical), |track| {
                track.w(px(WIDTH)).flex_1().min_h_0()
            })
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |_, event: &gpui::MouseDownEvent, _, cx| {
                    if let Some(thumb) = press.thumb(axis) {
                        let hit = axis.coordinates(event.position) - thumb.start;
                        let grab = if hit >= px(0.) && hit <= thumb.length {
                            hit
                        } else {
                            thumb.length / 2.
                        };
                        press.drag.set(Some(grab));
                        press.move_thumb(axis, event.position, grab, thumb);
                        cx.notify();
                    }
                }),
            )
            .on_mouse_move(cx.listener(move |_, event: &gpui::MouseMoveEvent, _, cx| {
                if event.dragging()
                    && let (Some(grab), Some(thumb)) = (drag.drag.get(), drag.thumb(axis))
                {
                    drag.move_thumb(axis, event.position, grab, thumb);
                    cx.notify();
                }
            }))
            .capture_any_mouse_up(move |_, _, _| release.set(None))
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, (), window, _| {
                        if let Some(thumb) = paint.thumb(axis) {
                            window.paint_quad(fill(bounds, theme::line_soft()));
                            let knob = match axis {
                                Axis::Horizontal => Bounds::new(
                                    point(thumb.start, bounds.top() + px(3.)),
                                    size(thumb.length, px(8.)),
                                ),
                                Axis::Vertical => Bounds::new(
                                    point(bounds.left() + px(3.), thumb.start),
                                    size(px(8.), thumb.length),
                                ),
                            };
                            window.paint_quad(fill(knob, theme::muted()));
                        }
                    },
                )
                .size_full(),
            )
    }
}
