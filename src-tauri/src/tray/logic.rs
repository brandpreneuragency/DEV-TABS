//! Pure click/readiness arbitration; all transitions run on the UI thread.
#[derive(Default, Debug)]
pub(super) struct Intent {
    pub generation: u64,
    pub pending: bool,
    pub requested: bool,
    pub ready: bool,
    pub visible: bool,
    suppress_up: bool,
    closed_by_tray: bool,
}
impl Intent {
    pub fn cancel(&mut self) {
        self.generation += 1;
        self.pending = false;
        self.requested = false;
        self.visible = false;
    }
    pub fn double_click(&mut self) {
        self.cancel();
        self.suppress_up = true;
    }
    pub fn left_down(&mut self) {
        if !self.closed_by_tray {
            self.suppress_up = false;
        }
    }
    pub fn left_up(&mut self) -> Option<u64> {
        if self.suppress_up {
            self.suppress_up = false;
            self.closed_by_tray = false;
            return None;
        }
        if self.requested || self.visible {
            self.cancel();
            return None;
        }
        self.generation += 1;
        self.pending = true;
        Some(self.generation)
    }
    pub fn elapsed(&mut self, generation: u64) -> bool {
        if !self.pending || self.generation != generation {
            return false;
        }
        self.pending = false;
        self.requested = true;
        true
    }
    pub fn should_show(&self) -> bool {
        self.requested && self.ready && !self.visible
    }
    pub fn closed_on_tray(&mut self) {
        self.cancel();
        self.closed_by_tray = true;
        self.suppress_up = true;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tray_blur_before_down_still_toggles_closed() {
        let mut s = Intent::default();
        s.visible = true;
        s.closed_on_tray();
        s.left_down();
        assert_eq!(s.left_up(), None);
        s.left_down();
        assert!(s.left_up().is_some());
    }
    #[test]
    fn cancel_pending_and_loading_blocks_late_ready() {
        for after_timer in [false, true] {
            let mut s = Intent::default();
            let token = s.left_up().unwrap();
            if after_timer {
                assert!(s.elapsed(token));
            }
            s.cancel(); // right click, blur, Escape, close or outside click
            s.ready = true;
            assert!(!s.elapsed(token));
            assert!(!s.should_show());
        }
    }
    #[test]
    fn ready_only_opens_requested_and_repeated_ready_does_not_reopen() {
        let mut s = Intent::default();
        s.ready = true;
        assert!(!s.should_show());
        let token = s.left_up().unwrap();
        assert!(!s.should_show());
        assert!(s.elapsed(token));
        assert!(s.should_show());
        s.visible = true;
        assert!(!s.should_show());
        assert_eq!(s.left_up(), None);
        assert!(!s.visible);
        let token = s.left_up().unwrap();
        assert!(s.elapsed(token));
        assert!(s.should_show());
    }
    #[test]
    fn new_intent_invalidates_old_timer() {
        let mut s = Intent::default();
        let old = s.left_up().unwrap();
        let new = s.left_up().unwrap();
        assert!(!s.elapsed(old));
        assert!(s.elapsed(new));
        assert!(!s.elapsed(new));
    }
    #[test]
    fn double_click_during_loading_invalidates_ready_show() {
        let mut s = Intent::default();
        let token = s.left_up().unwrap();
        s.elapsed(token);
        s.double_click();
        s.ready = true;
        assert!(!s.should_show());
        assert_eq!(s.left_up(), None);
    }
    #[test]
    fn double_click_cancels_timer_and_trailing_up() {
        let mut s = Intent::default();
        let token = s.left_up().unwrap();
        s.double_click();
        assert!(!s.elapsed(token));
        assert_eq!(s.left_up(), None);
        s.ready = true;
        assert!(!s.should_show());
        s.left_down();
        assert!(s.left_up().is_some());
    }
}
