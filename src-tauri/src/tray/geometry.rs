//! Geometry is physical throughout; only content dimensions are logical.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Rect {
    pub fn contains(self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }
}
pub(super) fn placement(icon: Rect, work: Rect, scale: f64, width: f64, height: f64) -> Rect {
    let width = (width.min(640.0) * scale)
        .round()
        .clamp(1.0, work.width.max(1.0));
    let bottom = icon.y.min(work.y + work.height).max(work.y + 1.0);
    let height = (height * scale)
        .round()
        .clamp(1.0, (bottom - work.y).max(1.0));
    Rect {
        x: (icon.x + icon.width - width).clamp(work.x, (work.x + work.width - width).max(work.x)),
        y: bottom - height,
        width,
        height,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn above_icon_high_dpi_negative_monitor() {
        let r = placement(
            Rect {
                x: -50.0,
                y: 1400.0,
                width: 30.0,
                height: 30.0,
            },
            Rect {
                x: -1920.0,
                y: 0.0,
                width: 1920.0,
                height: 1400.0,
            },
            1.5,
            640.0,
            400.0,
        );
        assert_eq!((r.x, r.y, r.width, r.height), (-980.0, 800.0, 960.0, 600.0));
    }
    #[test]
    fn clamps_to_tiny_work_area_and_space_above_icon() {
        let r = placement(
            Rect {
                x: 100.0,
                y: -60.0,
                width: 20.0,
                height: 20.0,
            },
            Rect {
                x: 100.0,
                y: -360.0,
                width: 480.0,
                height: 320.0,
            },
            2.0,
            900.0,
            1000.0,
        );
        assert_eq!((r.x, r.y, r.width, r.height), (100.0, -360.0, 480.0, 300.0));
    }
    #[test]
    fn left_edge_stays_in_selected_monitor() {
        let r = placement(
            Rect {
                x: -1900.0,
                y: 1000.0,
                width: 20.0,
                height: 20.0,
            },
            Rect {
                x: -1920.0,
                y: 0.0,
                width: 1920.0,
                height: 1040.0,
            },
            1.0,
            640.0,
            200.0,
        );
        assert_eq!((r.x, r.y), (-1920.0, 800.0));
    }
}
