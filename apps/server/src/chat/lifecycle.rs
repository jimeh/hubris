#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AppServerProcessState {
    Stopped,
    Starting,
    Initializing,
    Ready,
    Stopping,
    Fatal,
}

#[derive(Debug)]
pub(super) struct AppServerLifecycle {
    state: AppServerProcessState,
}

impl Default for AppServerLifecycle {
    fn default() -> Self {
        Self {
            state: AppServerProcessState::Stopped,
        }
    }
}

impl AppServerLifecycle {
    pub(super) fn is_fatal(&self) -> bool {
        matches!(self.state, AppServerProcessState::Fatal)
    }

    pub(super) fn mark_starting(&mut self) {
        self.state = AppServerProcessState::Starting;
    }

    pub(super) fn mark_initializing(&mut self) {
        self.state = AppServerProcessState::Initializing;
    }

    pub(super) fn mark_ready(&mut self) {
        self.state = AppServerProcessState::Ready;
    }

    pub(super) fn mark_stopping(&mut self) {
        self.state = AppServerProcessState::Stopping;
    }

    pub(super) fn mark_stopped(&mut self) {
        self.state = AppServerProcessState::Stopped;
    }

    pub(super) fn mark_fatal(&mut self) {
        self.state = AppServerProcessState::Fatal;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ThreadStreamResumeState {
    NotStarted,
    NeedsResume,
    Resuming,
    Resumed,
}

#[derive(Debug, Clone)]
pub(super) struct ThreadStreamLifecycle {
    resume_state: ThreadStreamResumeState,
}

impl Default for ThreadStreamLifecycle {
    fn default() -> Self {
        Self {
            resume_state: ThreadStreamResumeState::NotStarted,
        }
    }
}

impl ThreadStreamLifecycle {
    pub(super) fn mark_needs_resume(&mut self) {
        self.resume_state = ThreadStreamResumeState::NeedsResume;
    }

    pub(super) fn mark_resuming(&mut self) {
        self.resume_state = ThreadStreamResumeState::Resuming;
    }

    pub(super) fn mark_resumed(&mut self) {
        self.resume_state = ThreadStreamResumeState::Resumed;
    }

    pub(super) fn mark_process_lost(&mut self) {
        if matches!(self.resume_state, ThreadStreamResumeState::Resumed) {
            self.resume_state = ThreadStreamResumeState::NeedsResume;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_startup_path_reaches_ready() {
        let mut lifecycle = AppServerLifecycle::default();
        assert_eq!(lifecycle.state, AppServerProcessState::Stopped);

        lifecycle.mark_starting();
        assert_eq!(lifecycle.state, AppServerProcessState::Starting);

        lifecycle.mark_initializing();
        assert_eq!(lifecycle.state, AppServerProcessState::Initializing);

        lifecycle.mark_ready();
        assert_eq!(lifecycle.state, AppServerProcessState::Ready);
    }

    #[test]
    fn process_initialization_failure_becomes_fatal() {
        let mut lifecycle = AppServerLifecycle::default();
        lifecycle.mark_starting();
        lifecycle.mark_initializing();
        lifecycle.mark_fatal();

        assert_eq!(lifecycle.state, AppServerProcessState::Fatal);
        assert!(lifecycle.is_fatal());
    }

    #[test]
    fn process_shutdown_path_reaches_stopped() {
        let mut lifecycle = AppServerLifecycle::default();
        lifecycle.mark_starting();
        lifecycle.mark_initializing();
        lifecycle.mark_ready();
        lifecycle.mark_stopping();
        assert_eq!(lifecycle.state, AppServerProcessState::Stopping);

        lifecycle.mark_stopped();
        assert_eq!(lifecycle.state, AppServerProcessState::Stopped);
    }

    #[test]
    fn thread_stream_resume_path_reaches_resumed() {
        let mut lifecycle = ThreadStreamLifecycle::default();
        lifecycle.mark_needs_resume();
        assert_eq!(lifecycle.resume_state, ThreadStreamResumeState::NeedsResume);

        lifecycle.mark_resuming();
        assert_eq!(lifecycle.resume_state, ThreadStreamResumeState::Resuming);

        lifecycle.mark_resumed();
        assert_eq!(lifecycle.resume_state, ThreadStreamResumeState::Resumed);
    }

    #[test]
    fn process_loss_marks_resumed_thread_as_needing_resume() {
        let mut lifecycle = ThreadStreamLifecycle::default();
        lifecycle.mark_resumed();
        lifecycle.mark_process_lost();

        assert_eq!(lifecycle.resume_state, ThreadStreamResumeState::NeedsResume);
    }

    #[test]
    fn process_loss_preserves_not_started_thread() {
        let mut lifecycle = ThreadStreamLifecycle::default();
        lifecycle.mark_process_lost();

        assert_eq!(lifecycle.resume_state, ThreadStreamResumeState::NotStarted);
    }
}
