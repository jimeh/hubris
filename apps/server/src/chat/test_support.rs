use super::*;

use sqlx::migrate::Migrator;

static TEST_MIGRATOR: Migrator = sqlx::migrate!("./chat-migrations");

pub(super) fn test_conversation() -> ChatConversationSummary {
    ChatConversationSummary {
        id: "chat-1".to_string(),
        session_id: "default".to_string(),
        project_id: "project-1".to_string(),
        worktree_id: "worktree-1".to_string(),
        branch_name: Some("main".to_string()),
        provider: ChatProvider::Codex,
        provider_thread_id: Some("thread-1".to_string()),
        title: DEFAULT_CHAT_TITLE.to_string(),
        created_at: 0,
        updated_at: 0,
        last_activity_at: 0,
        last_message_at: None,
        open_tab_id: None,
        archived_at: None,
        selected_model: None,
        selected_effort: None,
        selected_permission_mode: None,
        last_run_state: ChatRunStatus::Completed,
        last_error: None,
        last_reconciliation_state: ChatReconciliationStatus::NotNeeded,
        last_reconciliation_error: None,
        context_used_tokens: None,
        context_max_tokens: None,
        context_percent_used: None,
        context_updated_at: None,
        pending_request_count: 0,
        latest_pending_request_id: None,
        latest_pending_request_kind: None,
        latest_pending_request_status: None,
        has_pending_request_attention: false,
        revision: 0,
    }
}

pub(super) async fn test_service() -> Arc<ChatService> {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    TEST_MIGRATOR.run(&pool).await.unwrap();
    let tmp = tempfile::TempDir::new().unwrap();
    let settings = SettingsManager::new(tmp.path().join("settings.toml"))
        .await
        .unwrap();
    Arc::new(ChatService {
        pool,
        events: Arc::new(crate::events::EventBus::new()),
        settings: Arc::new(settings),
        app_server: Arc::new(CodexAppServerManager::new_for_tests(Arc::new(|| {
            Box::pin(async {
                Err(ChatServiceError::new(
                    ChatErrorKind::Upstream,
                    "test app-server factory should not be used",
                ))
            })
        }))),
        runtimes: DashMap::new(),
        thread_to_conversation: DashMap::new(),
        turn_to_conversation: DashMap::new(),
        item_to_conversation: DashMap::new(),
        server_request_to_conversation: DashMap::new(),
        pending_server_responders: DashMap::new(),
        op_locks: DashMap::new(),
        stream_owner_generation: AtomicU64::new(1),
        app_event_loop: Mutex::new(None),
        cancellation_token: CancellationToken::new(),
    })
}

pub(super) fn route_hints(
    thread_id: Option<&str>,
    turn_id: Option<&str>,
    item_id: Option<&str>,
    request_id: Option<&str>,
) -> RouteHints {
    RouteHints {
        thread_id: thread_id.map(str::to_string),
        turn_id: turn_id.map(str::to_string),
        item_id: item_id.map(str::to_string),
        request_id: request_id.map(str::to_string),
    }
}

pub(super) async fn insert_test_runtime(
    service: &Arc<ChatService>,
    conversation_id: &str,
    provider_thread_id: &str,
    active: bool,
    owner_generation: u64,
) -> RuntimeEntry {
    let mut conversation = test_conversation();
    conversation.id = conversation_id.to_string();
    conversation.provider_thread_id = Some(provider_thread_id.to_string());
    let runtime = RuntimeEntry {
        state: Arc::new(Mutex::new(RuntimeState::new(
            &conversation,
            "/tmp/worktree",
        ))),
    };
    {
        let mut state = runtime.state.lock().await;
        state.owner_generation = owner_generation;
        state.provider_thread_id = Some(provider_thread_id.to_string());
        state.stream_lifecycle.mark_resumed();
        state.lifecycle = if active {
            state.active_run_id = Some(format!("run-{conversation_id}"));
            ChatRuntimeLifecycle::Running
        } else {
            ChatRuntimeLifecycle::Ready
        };
    }
    service
        .runtimes
        .insert(conversation_id.to_string(), runtime.clone());
    service
        .register_provider_thread_route(conversation_id, &runtime, provider_thread_id)
        .await;
    runtime
}

pub(super) async fn create_persisted_conversation(
    service: &Arc<ChatService>,
) -> ChatConversationSummary {
    service
        .create_conversation(ChatCreateOptions {
            session_id: "default".to_string(),
            project_id: "project-1".to_string(),
            worktree_id: "worktree-1".to_string(),
            branch_name: "main".to_string(),
        })
        .await
        .unwrap()
}

pub(super) async fn start_test_run(
    service: &Arc<ChatService>,
    conversation: &ChatConversationSummary,
    runtime: &RuntimeEntry,
) -> (String, String, String, String) {
    let user_message_id = uuid::Uuid::new_v4().to_string();
    let assistant_message_id = uuid::Uuid::new_v4().to_string();
    let run_id = uuid::Uuid::new_v4().to_string();
    let turn_id = uuid::Uuid::new_v4().to_string();
    service
        .persist_run_start(
            conversation,
            &user_message_id,
            &assistant_message_id,
            &run_id,
            &turn_id,
            "hello",
        )
        .await
        .unwrap();
    {
        let mut state = runtime.state.lock().await;
        state.active_run_id = Some(run_id.clone());
        state.active_turn_id = Some(turn_id.clone());
        state.active_message_id = Some(assistant_message_id.clone());
        state.lifecycle = ChatRuntimeLifecycle::Running;
    }
    (user_message_id, assistant_message_id, run_id, turn_id)
}

pub(super) struct FakeCodexConnection {
    pub(super) requests: Arc<Mutex<Vec<(String, Value)>>>,
    pub(super) stream_events: broadcast::Sender<CodexStreamEvent>,
}

impl FakeCodexConnection {
    pub(super) fn new(requests: Arc<Mutex<Vec<(String, Value)>>>) -> Self {
        let (stream_events, _) = broadcast::channel(16);
        Self {
            requests,
            stream_events,
        }
    }
}

impl CodexAppServerConnection for FakeCodexConnection {
    fn request<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> CodexAppServerFuture<'a, Result<Value, ChatServiceError>> {
        Box::pin(async move {
            self.requests
                .lock()
                .await
                .push((method.to_string(), params));
            Ok(json!({}))
        })
    }

    fn respond_result<'a>(
        &'a self,
        _id: Value,
        _result: Value,
    ) -> CodexAppServerFuture<'a, Result<(), ChatServiceError>> {
        Box::pin(async { Ok(()) })
    }

    fn subscribe(&self) -> broadcast::Receiver<CodexStreamEvent> {
        self.stream_events.subscribe()
    }

    fn lifecycle_state<'a>(&'a self) -> CodexAppServerFuture<'a, AppServerProcessState> {
        Box::pin(async { AppServerProcessState::Ready })
    }
}

pub(super) async fn wait_for_provider_event_loop(
    service: &ChatService,
    connection: &FakeCodexConnection,
    finished: bool,
) {
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let handle_finished = service
                .app_event_loop
                .lock()
                .await
                .as_ref()
                .is_some_and(JoinHandle::is_finished);
            let receiver_ready = connection.stream_events.receiver_count() == 1;
            if handle_finished == finished && (finished || receiver_ready) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("provider event loop did not reach the expected state");
}
