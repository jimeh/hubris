use super::*;

#[derive(Debug, Clone)]
pub(super) struct RuntimeEntry {
    pub(super) state: Arc<Mutex<RuntimeState>>,
}

#[derive(Debug, Clone)]
pub(super) struct RuntimeState {
    pub(super) session_id: String,
    project_id: String,
    worktree_id: String,
    worktree_path: String,
    pub(super) provider_thread_id: Option<String>,
    pub(super) active_run_id: Option<String>,
    pub(super) active_turn_id: Option<String>,
    pub(super) active_message_id: Option<String>,
    active_error: Option<String>,
    pub(super) lifecycle: ChatRuntimeLifecycle,
    active_reasoning_summary_index: Option<u64>,
    active_commentary_item_id: Option<String>,
    has_reasoning_projection: bool,
    agent_message_projection_by_item_id: HashMap<String, AgentMessageProjection>,
    commentary_delta_seen_item_ids: HashSet<String>,
    commentary_completed_item_ids: HashSet<String>,
    streaming_snapshot_emitted_at: HashMap<String, tokio::time::Instant>,
    reasoning_message_snapshot_emitted_at: HashMap<String, tokio::time::Instant>,
    pub(super) stream_lifecycle: ThreadStreamLifecycle,
    pub(super) owner_generation: u64,
    idle_generation: u64,
    inactive_deadline_at: Option<u64>,
    last_error: Option<String>,
}

fn should_emit_streaming_snapshot(
    tracker: &mut HashMap<String, tokio::time::Instant>,
    key: &str,
    is_streaming: bool,
) -> bool {
    if !is_streaming {
        tracker.remove(key);
        return true;
    }

    let now = tokio::time::Instant::now();
    match tracker.get_mut(key) {
        Some(last_emitted) if now.duration_since(*last_emitted) < STREAMING_SNAPSHOT_INTERVAL => {
            false
        }
        Some(last_emitted) => {
            *last_emitted = now;
            true
        }
        None => {
            tracker.insert(key.to_string(), now);
            true
        }
    }
}

impl RuntimeState {
    pub(super) fn new(conversation: &ChatConversationSummary, worktree_path: &str) -> Self {
        let mut stream_lifecycle = ThreadStreamLifecycle::default();
        if conversation.provider_thread_id.is_some() {
            stream_lifecycle.mark_needs_resume();
        }

        Self {
            session_id: conversation.session_id.clone(),
            project_id: conversation.project_id.clone(),
            worktree_id: conversation.worktree_id.clone(),
            worktree_path: worktree_path.to_string(),
            provider_thread_id: conversation.provider_thread_id.clone(),
            active_run_id: None,
            active_turn_id: None,
            active_message_id: None,
            active_error: None,
            lifecycle: ChatRuntimeLifecycle::Starting,
            active_reasoning_summary_index: None,
            active_commentary_item_id: None,
            has_reasoning_projection: false,
            agent_message_projection_by_item_id: HashMap::new(),
            commentary_delta_seen_item_ids: HashSet::new(),
            commentary_completed_item_ids: HashSet::new(),
            streaming_snapshot_emitted_at: HashMap::new(),
            reasoning_message_snapshot_emitted_at: HashMap::new(),
            stream_lifecycle,
            owner_generation: 0,
            idle_generation: 0,
            inactive_deadline_at: None,
            last_error: None,
        }
    }

    fn reset_text_projection_state(&mut self) {
        self.active_reasoning_summary_index = None;
        self.active_commentary_item_id = None;
        self.has_reasoning_projection = false;
        self.agent_message_projection_by_item_id.clear();
        self.commentary_delta_seen_item_ids.clear();
        self.commentary_completed_item_ids.clear();
        self.reasoning_message_snapshot_emitted_at.clear();
    }

    pub(super) fn should_emit_item_snapshot(&mut self, item: &ChatItem) -> bool {
        should_emit_streaming_snapshot(
            &mut self.streaming_snapshot_emitted_at,
            &item.id,
            item.status == ChatItemStatus::Streaming,
        )
    }

    fn should_emit_reasoning_message_snapshot(&mut self, message: &ChatMessage) -> bool {
        should_emit_streaming_snapshot(
            &mut self.reasoning_message_snapshot_emitted_at,
            &message.id,
            message.status == ChatMessageStatus::Streaming,
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AgentMessageProjection {
    Response,
    Reasoning,
}

#[derive(Debug, Clone)]
pub(super) struct RouteEntry {
    conversation_id: String,
    owner_generation: u64,
}

#[derive(Debug, Clone)]
pub(super) struct PendingServerRequestRoute {
    route: RouteEntry,
    method: String,
    turn_id: Option<String>,
    item_id: Option<String>,
}

fn chat_thread_resume_state_from_lifecycle(
    state: ThreadStreamResumeState,
) -> ChatThreadStreamResumeState {
    match state {
        ThreadStreamResumeState::NotStarted => ChatThreadStreamResumeState::NotStarted,
        ThreadStreamResumeState::NeedsResume => ChatThreadStreamResumeState::NeedsResume,
        ThreadStreamResumeState::Resuming => ChatThreadStreamResumeState::Resuming,
        ThreadStreamResumeState::Resumed => ChatThreadStreamResumeState::Resumed,
    }
}

fn thread_stream_status_from_state(
    conversation_id: &str,
    state: RuntimeState,
    last_error: Option<String>,
) -> ChatThreadStreamStatus {
    ChatThreadStreamStatus {
        conversation_id: conversation_id.to_string(),
        session_id: state.session_id,
        project_id: state.project_id,
        worktree_id: state.worktree_id,
        resume_state: chat_thread_resume_state_from_lifecycle(
            state.stream_lifecycle.resume_state(),
        ),
        lifecycle: state.lifecycle,
        active_run_id: state.active_run_id,
        active_message_id: state.active_message_id,
        provider_thread_id: state.provider_thread_id,
        inactive_deadline_at: state.inactive_deadline_at,
        last_error: last_error.or(state.last_error),
        updated_at: now_ms(),
    }
}

impl ChatService {
    /// Touch an existing runtime without starting a new process.
    pub async fn touch_runtime(&self, conversation_id: &str) {
        // Clone the Arc'd state out of the DashMap so the shard guard is
        // dropped before awaiting the runtime mutex.
        let runtime_state = self
            .runtimes
            .get(conversation_id)
            .map(|entry| entry.state.clone());
        if let Some(runtime_state) = runtime_state {
            let mut state = runtime_state.lock().await;
            state.idle_generation = state.idle_generation.saturating_add(1);
            state.inactive_deadline_at = None;
        }
    }

    /// Return the shared Codex app-server process status.
    pub async fn app_server_status(&self) -> ChatAppServerStatus {
        self.app_server.status().await
    }

    /// List live thread stream summaries visible to a session.
    pub async fn list_thread_stream_statuses(
        &self,
        session_id: &str,
    ) -> Result<Vec<ChatThreadStreamStatus>, ChatServiceError> {
        // Snapshot the map before awaiting so no DashMap shard guard is
        // held across the per-runtime mutex awaits.
        let runtimes = self
            .runtimes
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect::<Vec<_>>();
        let mut statuses = Vec::new();
        for (conversation_id, runtime) in runtimes {
            let state = runtime.state.lock().await.clone();
            if state.session_id != session_id {
                continue;
            }
            statuses.push(thread_stream_status_from_state(
                &conversation_id,
                state,
                None,
            ));
        }
        statuses.sort_by(|left, right| {
            left.updated_at
                .cmp(&right.updated_at)
                .reverse()
                .then_with(|| left.conversation_id.cmp(&right.conversation_id))
        });
        Ok(statuses)
    }

    /// List live runtime summaries visible to a session.
    pub async fn list_runtime_statuses(
        &self,
        session_id: &str,
    ) -> Result<Vec<ChatRuntimeStatus>, ChatServiceError> {
        // Snapshot the map before awaiting so no DashMap shard guard is
        // held across the per-runtime mutex awaits.
        let runtimes = self
            .runtimes
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect::<Vec<_>>();
        let mut statuses = Vec::new();
        for (conversation_id, runtime) in runtimes {
            let state = runtime.state.lock().await;
            if state.session_id != session_id {
                continue;
            }
            statuses.push(ChatRuntimeStatus {
                conversation_id,
                session_id: state.session_id.clone(),
                project_id: state.project_id.clone(),
                worktree_id: state.worktree_id.clone(),
                lifecycle: state.lifecycle,
                active_run_id: state.active_run_id.clone(),
                active_message_id: state.active_message_id.clone(),
                provider_thread_id: state.provider_thread_id.clone(),
                last_error: state.last_error.clone(),
                updated_at: now_ms(),
            });
        }
        statuses.sort_by(|left, right| {
            left.updated_at
                .cmp(&right.updated_at)
                .reverse()
                .then_with(|| left.conversation_id.cmp(&right.conversation_id))
        });
        Ok(statuses)
    }

    /// Persist a new user message, ensure a runtime exists, and start a turn.
    pub async fn send_message(
        self: &Arc<Self>,
        conversation_id: &str,
        worktree_path: &str,
        text: String,
    ) -> Result<(), ChatServiceError> {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err(ChatServiceError::new(
                ChatErrorKind::BadRequest,
                "message cannot be empty",
            ));
        }

        let lock = self.operation_lock(conversation_id);
        let _guard = lock.lock().await;
        let conversation = self
            .get_conversation_summary(conversation_id)
            .await?
            .ok_or_else(|| ChatServiceError::new(ChatErrorKind::NotFound, "chat not found"))?;
        if conversation.archived_at.is_some() {
            return Err(ChatServiceError::new(
                ChatErrorKind::Conflict,
                "chat is archived",
            ));
        }
        let user_message_id = uuid::Uuid::new_v4().to_string();
        let assistant_message_id = uuid::Uuid::new_v4().to_string();
        let run_id = uuid::Uuid::new_v4().to_string();
        let turn_id = uuid::Uuid::new_v4().to_string();

        let runtime = self
            .ensure_runtime(conversation_id, &conversation, worktree_path)
            .await?;

        self.persist_run_start(
            &conversation,
            &user_message_id,
            &assistant_message_id,
            &run_id,
            &turn_id,
            &text,
        )
        .await?;
        {
            let mut state = runtime.state.lock().await;
            state.active_run_id = Some(run_id.clone());
            state.active_turn_id = Some(turn_id.clone());
            state.active_message_id = Some(assistant_message_id.clone());
            state.lifecycle = ChatRuntimeLifecycle::Running;
            state.reset_text_projection_state();
            state.active_error = None;
            state.last_error = None;
            state.inactive_deadline_at = None;
            state.idle_generation = state.idle_generation.saturating_add(1);
        }
        self.emit_thread_stream_status(conversation_id, &runtime.state, None)
            .await;

        let thread_id = runtime
            .state
            .lock()
            .await
            .provider_thread_id
            .clone()
            .ok_or_else(|| {
                ChatServiceError::new(ChatErrorKind::Internal, "chat runtime missing thread id")
            })?;
        let turn_params = build_turn_start_params(&thread_id, worktree_path, &text, &conversation);

        let turn_response = self
            .app_server
            .request("turn/start", Value::Object(turn_params))
            .await?;
        let provider_turn_id = extract_turn_id(&turn_response);
        if let Some(provider_turn_id) = provider_turn_id.as_deref() {
            self.register_turn_route(conversation_id, &runtime, provider_turn_id)
                .await;
        }
        self.attach_turn_to_run(
            conversation_id,
            &run_id,
            &turn_id,
            &assistant_message_id,
            provider_turn_id.as_deref(),
        )
        .await?;

        Ok(())
    }

    /// Interrupt the active provider turn if a runtime is present.
    pub async fn interrupt(
        self: &Arc<Self>,
        conversation_id: &str,
    ) -> Result<(), ChatServiceError> {
        let lock = self.operation_lock(conversation_id);
        let _guard = lock.lock().await;
        let runtime = self
            .runtimes
            .get(conversation_id)
            .map(|entry| entry.clone())
            .ok_or_else(|| ChatServiceError::new(ChatErrorKind::Conflict, "chat is not running"))?;
        let thread_id = runtime
            .state
            .lock()
            .await
            .provider_thread_id
            .clone()
            .ok_or_else(|| {
                ChatServiceError::new(ChatErrorKind::Conflict, "chat runtime missing thread id")
            })?;
        self.app_server
            .request("turn/interrupt", json!({ "threadId": thread_id }))
            .await?;
        Ok(())
    }

    async fn ensure_runtime(
        self: &Arc<Self>,
        conversation_id: &str,
        conversation: &ChatConversationSummary,
        worktree_path: &str,
    ) -> Result<RuntimeEntry, ChatServiceError> {
        let runtime = if let Some(existing) = self.runtimes.get(conversation_id) {
            existing.clone()
        } else {
            let runtime = RuntimeEntry {
                state: Arc::new(Mutex::new(RuntimeState::new(conversation, worktree_path))),
            };
            self.runtimes
                .insert(conversation_id.to_string(), runtime.clone());
            runtime
        };

        let client = self.app_server.ensure_client().await?;
        self.ensure_provider_event_loop(client).await;
        self.emit_app_server_status().await;

        let already_resumed = {
            let mut state = runtime.state.lock().await;
            state.worktree_path = worktree_path.to_string();
            state.idle_generation = state.idle_generation.saturating_add(1);
            state.inactive_deadline_at = None;
            matches!(
                state.stream_lifecycle.resume_state(),
                ThreadStreamResumeState::Resumed
            ) && state.provider_thread_id.is_some()
        };
        if already_resumed {
            return Ok(runtime);
        }

        {
            let mut state = runtime.state.lock().await;
            state.stream_lifecycle.mark_resuming();
            state.lifecycle = ChatRuntimeLifecycle::Starting;
            state.last_error = None;
        }
        self.emit_thread_stream_status(conversation_id, &runtime.state, None)
            .await;

        let resume_or_start = if let Some(provider_thread_id) = &conversation.provider_thread_id {
            let mut params = serde_json::Map::new();
            params.insert(
                "threadId".to_string(),
                Value::String(provider_thread_id.clone()),
            );
            params.insert("cwd".to_string(), Value::String(worktree_path.to_string()));
            apply_thread_permission_mode(&mut params, conversation.selected_permission_mode);
            let result = self
                .app_server
                .request("thread/resume", Value::Object(params))
                .await?;
            if has_blank_model_field(&result) {
                tracing::warn!(
                    conversation_id,
                    provider_thread_id,
                    "resumed codex thread has blank model; starting a replacement thread"
                );
                start_provider_thread(
                    &self.app_server,
                    worktree_path,
                    conversation.selected_model.as_deref(),
                    conversation.selected_permission_mode,
                )
                .await?
            } else {
                (
                    extract_thread_id(&result).unwrap_or_else(|| provider_thread_id.clone()),
                    result,
                )
            }
        } else {
            start_provider_thread(
                &self.app_server,
                worktree_path,
                conversation.selected_model.as_deref(),
                conversation.selected_permission_mode,
            )
            .await?
        };
        let (provider_thread_id, thread_response) = resume_or_start;

        {
            let mut state = runtime.state.lock().await;
            state.owner_generation = self.stream_owner_generation.load(Ordering::Acquire);
            state.provider_thread_id = Some(provider_thread_id.clone());
            state.lifecycle = ChatRuntimeLifecycle::Ready;
            state.stream_lifecycle.mark_resumed();
            state.inactive_deadline_at = None;
            state.last_error = None;
            state.idle_generation = state.idle_generation.saturating_add(1);
        }
        self.register_provider_thread_route(conversation_id, &runtime, &provider_thread_id)
            .await;

        self.persist_provider_thread_id(conversation_id, &provider_thread_id)
            .await?;
        self.persist_thread_preferences(
            conversation_id,
            extract_model(&thread_response),
            extract_reasoning_effort(&thread_response),
        )
        .await?;
        self.emit_thread_stream_status(conversation_id, &runtime.state, None)
            .await;
        self.reconcile_inflight_run_if_needed(conversation_id, &runtime, worktree_path)
            .await?;
        Ok(runtime)
    }

    async fn ensure_provider_event_loop(self: &Arc<Self>, client: CodexAppServerConnectionRef) {
        let mut event_loop = self.app_event_loop.lock().await;
        if event_loop
            .as_ref()
            .is_some_and(|handle| !handle.is_finished())
        {
            return;
        }

        let service = self.clone();
        let cancellation_token = self.cancellation_token.clone();
        *event_loop = Some(tokio::spawn(async move {
            let mut rx = client.subscribe();
            loop {
                let event = tokio::select! {
                    _ = cancellation_token.cancelled() => break,
                    event = rx.recv() => event,
                };
                match event {
                    Ok(CodexStreamEvent::ServerRequest {
                        id,
                        method,
                        params,
                        thread_id,
                        mut route_hints,
                    }) => {
                        if route_hints.thread_id.is_none() {
                            route_hints.thread_id = thread_id;
                        }
                        let response = if let Some((conversation_id, runtime)) =
                            service.runtime_for_provider_event(&route_hints).await
                        {
                            service
                                .register_route_hints(&conversation_id, &runtime, &route_hints)
                                .await;
                            service
                                .register_pending_server_request(
                                    &conversation_id,
                                    &runtime,
                                    &method,
                                    &route_hints,
                                )
                                .await;
                            match service
                                .handle_provider_request(
                                    id.clone(),
                                    &conversation_id,
                                    &runtime,
                                    &method,
                                    params,
                                    &route_hints,
                                )
                                .await
                            {
                                Ok(Some(result)) => {
                                    service.app_server.respond_result(id, result).await
                                }
                                Ok(None) => Ok(()),
                                Err(error) => Err(error),
                            }
                        } else {
                            tracing::warn!(
                                method,
                                "unroutable codex app-server request; declining"
                            );
                            service
                                .app_server
                                .respond_result(id, json!({ "decision": "decline" }))
                                .await
                        };
                        if let Err(error) = response {
                            tracing::warn!(method, "chat provider request failed: {error}");
                        }
                    }
                    Ok(CodexStreamEvent::Notification {
                        method,
                        params,
                        thread_id,
                        mut route_hints,
                    }) => {
                        if route_hints.thread_id.is_none() {
                            route_hints.thread_id = thread_id;
                        }
                        let Some((conversation_id, runtime)) =
                            service.runtime_for_provider_event(&route_hints).await
                        else {
                            if is_global_provider_notification(&method) {
                                tracing::debug!(
                                    method,
                                    "unroutable global codex app-server notification"
                                );
                            } else {
                                tracing::warn!(method, "unroutable codex app-server notification");
                            }
                            continue;
                        };
                        service
                            .register_route_hints(&conversation_id, &runtime, &route_hints)
                            .await;
                        if let Err(error) = service
                            .handle_provider_notification(
                                &conversation_id,
                                &runtime,
                                &method,
                                params,
                            )
                            .await
                        {
                            tracing::warn!(
                                conversation_id,
                                "chat provider notification failed: {error}"
                            );
                        }
                    }
                    Ok(CodexStreamEvent::Closed { reason }) => {
                        let _ = service.handle_provider_closed(reason).await;
                        break;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }));
    }

    async fn runtime_for_provider_event(
        &self,
        route_hints: &RouteHints,
    ) -> Option<(String, RuntimeEntry)> {
        // Clone route entries out of the DashMaps so no shard guard is held
        // across the awaited runtime lookups below.
        if let Some(thread_id) = route_hints.thread_id.as_deref() {
            let route = self
                .thread_to_conversation
                .get(thread_id)
                .map(|entry| entry.value().clone());
            if let Some(runtime) = self.runtime_for_route_entry(route.as_ref()).await {
                return Some(runtime);
            }
        }
        if let Some(turn_id) = route_hints.turn_id.as_deref() {
            let route = self
                .turn_to_conversation
                .get(turn_id)
                .map(|entry| entry.value().clone());
            if let Some(runtime) = self.runtime_for_route_entry(route.as_ref()).await {
                return Some(runtime);
            }
        }
        if let Some(item_id) = route_hints.item_id.as_deref() {
            let route = self
                .item_to_conversation
                .get(item_id)
                .map(|entry| entry.value().clone());
            if let Some(runtime) = self.runtime_for_route_entry(route.as_ref()).await {
                return Some(runtime);
            }
        }
        if let Some(request_id) = route_hints.request_id.as_deref() {
            let route = self
                .server_request_to_conversation
                .get(request_id)
                .map(|entry| entry.route.clone());
            if let Some(runtime) = self.runtime_for_route_entry(route.as_ref()).await {
                return Some(runtime);
            }
        }

        let runtimes = self
            .runtimes
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect::<Vec<_>>();
        if let Some(thread_id) = route_hints.thread_id.as_deref() {
            for (conversation_id, runtime) in &runtimes {
                let state = runtime.state.lock().await;
                if state.provider_thread_id.as_deref() == Some(thread_id) {
                    self.thread_to_conversation.insert(
                        thread_id.to_string(),
                        RouteEntry {
                            conversation_id: conversation_id.clone(),
                            owner_generation: state.owner_generation,
                        },
                    );
                    return Some((conversation_id.clone(), runtime.clone()));
                }
            }
        }

        if route_hints.thread_id.is_some()
            || route_hints.turn_id.is_some()
            || route_hints.item_id.is_some()
            || route_hints.request_id.is_some()
        {
            return None;
        }

        let mut active = Vec::new();
        for (conversation_id, runtime) in runtimes {
            let state = runtime.state.lock().await;
            if state.active_run_id.is_some()
                || matches!(state.lifecycle, ChatRuntimeLifecycle::Running)
            {
                active.push((conversation_id, runtime.clone()));
            }
        }
        if active.len() == 1 {
            active.into_iter().next()
        } else {
            None
        }
    }

    async fn runtime_for_route_entry(
        &self,
        route: Option<&RouteEntry>,
    ) -> Option<(String, RuntimeEntry)> {
        let route = route?;
        let runtime = self
            .runtimes
            .get(&route.conversation_id)
            .map(|entry| entry.value().clone())?;
        let state = runtime.state.lock().await;
        if state.owner_generation != route.owner_generation {
            return None;
        }
        drop(state);
        Some((route.conversation_id.clone(), runtime))
    }

    pub(super) async fn register_provider_thread_route(
        &self,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        thread_id: &str,
    ) {
        let owner_generation = runtime.state.lock().await.owner_generation;
        self.thread_to_conversation.insert(
            thread_id.to_string(),
            RouteEntry {
                conversation_id: conversation_id.to_string(),
                owner_generation,
            },
        );
    }

    pub(super) async fn register_turn_route(
        &self,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        turn_id: &str,
    ) {
        let owner_generation = runtime.state.lock().await.owner_generation;
        self.turn_to_conversation.insert(
            turn_id.to_string(),
            RouteEntry {
                conversation_id: conversation_id.to_string(),
                owner_generation,
            },
        );
    }

    pub(super) async fn register_item_route(
        &self,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        item_id: &str,
    ) {
        let owner_generation = runtime.state.lock().await.owner_generation;
        self.item_to_conversation.insert(
            item_id.to_string(),
            RouteEntry {
                conversation_id: conversation_id.to_string(),
                owner_generation,
            },
        );
    }

    async fn register_route_hints(
        &self,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        route_hints: &RouteHints,
    ) {
        if let Some(thread_id) = route_hints.thread_id.as_deref() {
            self.register_provider_thread_route(conversation_id, runtime, thread_id)
                .await;
        }
        if let Some(turn_id) = route_hints.turn_id.as_deref() {
            self.register_turn_route(conversation_id, runtime, turn_id)
                .await;
        }
        if let Some(item_id) = route_hints.item_id.as_deref() {
            self.register_item_route(conversation_id, runtime, item_id)
                .await;
        }
    }

    async fn register_pending_server_request(
        &self,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        method: &str,
        route_hints: &RouteHints,
    ) {
        let Some(request_id) = route_hints.request_id.as_deref() else {
            return;
        };
        let owner_generation = runtime.state.lock().await.owner_generation;
        self.server_request_to_conversation.insert(
            request_id.to_string(),
            PendingServerRequestRoute {
                route: RouteEntry {
                    conversation_id: conversation_id.to_string(),
                    owner_generation,
                },
                method: method.to_string(),
                turn_id: route_hints.turn_id.clone(),
                item_id: route_hints.item_id.clone(),
            },
        );
    }

    pub(super) fn clear_pending_server_request(&self, request_id: &str) {
        if let Some((_, route)) = self.server_request_to_conversation.remove(request_id) {
            tracing::trace!(
                request_id,
                method = route.method,
                turn_id = route.turn_id.as_deref().unwrap_or(""),
                item_id = route.item_id.as_deref().unwrap_or(""),
                "cleared codex app-server request route"
            );
        }
        if let Some((_, responder)) = self.pending_server_responders.remove(request_id) {
            self.pending_server_responders
                .remove(&responder.provider_request_id);
        }
    }

    fn clear_route_indexes(&self) {
        self.thread_to_conversation.clear();
        self.turn_to_conversation.clear();
        self.item_to_conversation.clear();
        self.server_request_to_conversation.clear();
        self.pending_server_responders.clear();
    }

    /// Resolve one pending Codex server request from any browser client.
    pub async fn resolve_pending_request(
        self: &Arc<Self>,
        conversation_id: &str,
        request_id: &str,
        resolution: ResolveChatPendingRequestRequest,
    ) -> Result<ChatPendingRequest, ChatServiceError> {
        let lock = self.operation_lock(conversation_id);
        let _guard = lock.lock().await;
        let Some(existing) = self
            .get_pending_request_by_id(conversation_id, request_id)
            .await?
        else {
            return Err(ChatServiceError::new(
                ChatErrorKind::NotFound,
                "pending request not found",
            ));
        };
        if !matches!(existing.status, ChatPendingRequestStatus::Pending) {
            return Err(ChatServiceError::new(
                ChatErrorKind::Conflict,
                "pending request has already been resolved",
            ));
        }
        sqlx::query(
            "
            UPDATE chat_pending_requests
            SET status = ?, updated_at_ms = ?
            WHERE conversation_id = ? AND id = ? AND status = ?
            ",
        )
        .bind(ChatPendingRequestStatus::Resolving.as_str())
        .bind(now_ms() as i64)
        .bind(conversation_id)
        .bind(request_id)
        .bind(ChatPendingRequestStatus::Pending.as_str())
        .execute(&self.pool)
        .await?;
        if let Some(request) = self
            .get_pending_request_by_id(conversation_id, request_id)
            .await?
        {
            self.events.emit(EventKind::ChatPendingRequestUpdated {
                session_id: request_session_id(self, conversation_id).await?,
                request,
            });
        }

        let responder = self
            .pending_server_responders
            .get(request_id)
            .map(|entry| entry.value().clone())
            .ok_or_else(|| {
                ChatServiceError::new(
                    ChatErrorKind::Conflict,
                    "codex request can no longer be answered",
                )
            });
        let responder = match responder {
            Ok(responder) => responder,
            Err(error) => {
                if let Some(update) = self
                    .update_pending_request_terminal(
                        conversation_id,
                        request_id,
                        ChatPendingRequestStatus::Stale,
                        None,
                        None,
                        Some(&error.message),
                    )
                    .await?
                    && update.transitioned
                {
                    self.events.emit(EventKind::ChatPendingRequestUpdated {
                        session_id: request_session_id(self, conversation_id).await?,
                        request: update.request,
                    });
                }
                return Err(error);
            }
        };
        if responder.conversation_id != conversation_id {
            return Err(ChatServiceError::new(
                ChatErrorKind::Conflict,
                "pending request belongs to another conversation",
            ));
        }
        let Some(runtime) = self
            .runtimes
            .get(conversation_id)
            .map(|entry| entry.value().clone())
        else {
            self.mark_pending_requests_stale_for_conversation(
                conversation_id,
                "codex runtime is no longer available",
            )
            .await?;
            return Err(ChatServiceError::new(
                ChatErrorKind::Conflict,
                "codex runtime is no longer available",
            ));
        };
        let owner_matches =
            runtime.state.lock().await.owner_generation == responder.owner_generation;
        if !owner_matches {
            self.mark_pending_requests_stale_for_conversation(
                conversation_id,
                "codex stream ownership changed before the request was answered",
            )
            .await?;
            return Err(ChatServiceError::new(
                ChatErrorKind::Conflict,
                "codex request can no longer be answered",
            ));
        }

        let response = provider_response_for_pending_request(&existing, &resolution)?;
        let send_result = self
            .app_server
            .respond_result(responder.jsonrpc_id.clone(), response.clone())
            .await;
        match send_result {
            Ok(()) => {
                let status = resolution.decision.terminal_status();
                let update = self
                    .update_pending_request_terminal(
                        conversation_id,
                        request_id,
                        status,
                        Some(&resolution.decision),
                        Some(&response),
                        None,
                    )
                    .await?
                    .ok_or_else(|| {
                        ChatServiceError::new(
                            ChatErrorKind::Internal,
                            "pending request missing after resolution",
                        )
                    })?;
                if update.transitioned {
                    self.events.emit(EventKind::ChatPendingRequestResolved {
                        session_id: request_session_id(self, conversation_id).await?,
                        request: update.request.clone(),
                    });
                    let _ = self.emit_conversation_updated(conversation_id).await?;
                }
                Ok(update.request)
            }
            Err(error) => {
                let update = self
                    .update_pending_request_terminal(
                        conversation_id,
                        request_id,
                        ChatPendingRequestStatus::Failed,
                        Some(&resolution.decision),
                        Some(&response),
                        Some(&error.message),
                    )
                    .await?
                    .ok_or_else(|| {
                        ChatServiceError::new(
                            ChatErrorKind::Internal,
                            "pending request missing after failed resolution",
                        )
                    })?;
                if update.transitioned {
                    self.events.emit(EventKind::ChatPendingRequestUpdated {
                        session_id: request_session_id(self, conversation_id).await?,
                        request: update.request,
                    });
                    let _ = self.emit_conversation_updated(conversation_id).await?;
                }
                Err(error)
            }
        }
    }

    async fn handle_provider_request(
        self: &Arc<Self>,
        jsonrpc_id: Value,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        method: &str,
        params: Value,
        route_hints: &RouteHints,
    ) -> Result<Option<Value>, ChatServiceError> {
        let kind = pending_request_kind_for_method(method);
        if matches!(kind, ChatPendingRequestKind::Unsupported) {
            let request = self
                .persist_provider_request(
                    conversation_id,
                    runtime,
                    PersistProviderRequest {
                        jsonrpc_id,
                        method: method.to_string(),
                        params,
                        route_hints: route_hints.clone(),
                        status: ChatPendingRequestStatus::Declined,
                        decision: Some(ChatPendingRequestDecision::Decline),
                        error_message: Some(format!(
                            "unsupported codex app-server request: {method}"
                        )),
                    },
                )
                .await?;
            self.events.emit(EventKind::ChatPendingRequestResolved {
                session_id: request_session_id(self, conversation_id).await?,
                request,
            });
            return Ok(Some(json!({ "decision": "decline" })));
        }

        let request = self
            .persist_provider_request(
                conversation_id,
                runtime,
                PersistProviderRequest {
                    jsonrpc_id,
                    method: method.to_string(),
                    params,
                    route_hints: route_hints.clone(),
                    status: ChatPendingRequestStatus::Pending,
                    decision: None,
                    error_message: None,
                },
            )
            .await?;
        self.events.emit(EventKind::ChatPendingRequestCreated {
            session_id: request_session_id(self, conversation_id).await?,
            request,
        });
        let _ = self.emit_conversation_updated(conversation_id).await?;
        self.emit_thread_stream_status(conversation_id, &runtime.state, None)
            .await;
        Ok(None)
    }

    pub(super) async fn handle_provider_notification(
        self: &Arc<Self>,
        conversation_id: &str,
        runtime: &RuntimeEntry,
        method: &str,
        params: Value,
    ) -> Result<(), ChatServiceError> {
        match method {
            "error" => {
                let error_message = params
                    .get("error")
                    .and_then(extract_error_message)
                    .unwrap_or_else(|| "codex turn failed".to_string());
                {
                    let mut state = runtime.state.lock().await;
                    state.active_error = Some(error_message.clone());
                    state.last_error = Some(error_message.clone());
                }
                self.emit_thread_stream_status(
                    conversation_id,
                    &runtime.state,
                    Some(error_message),
                )
                .await;
            }
            "serverRequest/resolved" => {
                let route_hints = RouteHints::from_value(&params);
                if let Some(request_id) = route_hints.request_id.as_deref() {
                    self.reconcile_provider_request_resolved(conversation_id, request_id)
                        .await?;
                    self.clear_pending_server_request(request_id);
                }
            }
            "turn/started" => {
                let provider_turn_id = RouteHints::from_value(&params)
                    .turn_id
                    .or_else(|| extract_turn_id(&params));
                let (run_id, turn_id, message_id) = {
                    let state = runtime.state.lock().await;
                    (
                        state.active_run_id.clone(),
                        state.active_turn_id.clone(),
                        state.active_message_id.clone(),
                    )
                };
                if let Some(provider_turn_id) = provider_turn_id.as_deref() {
                    self.register_turn_route(conversation_id, runtime, provider_turn_id)
                        .await;
                }
                if let (Some(run_id), Some(turn_id), Some(message_id)) =
                    (run_id, turn_id, message_id)
                {
                    self.attach_turn_to_run(
                        conversation_id,
                        &run_id,
                        &turn_id,
                        &message_id,
                        provider_turn_id.as_deref(),
                    )
                    .await?;
                }
            }
            "item/started" => {
                trace_codex_text_event("item/started", conversation_id, &params);
                let kind = item_kind_from_params(&params);
                let projection = agent_message_projection_from_value(&params);
                let route_hints = RouteHints::from_value(&params);
                if let (Some(item_id), Some(projection)) =
                    (route_hints.item_id.as_deref(), projection)
                {
                    runtime
                        .state
                        .lock()
                        .await
                        .agent_message_projection_by_item_id
                        .insert(item_id.to_string(), projection);
                }
                let persisted_kind = if projection == Some(AgentMessageProjection::Reasoning) {
                    ChatItemKind::Reasoning
                } else {
                    kind
                };
                let _ = self
                    .upsert_chat_item(
                        conversation_id,
                        runtime,
                        &params,
                        persisted_kind,
                        ChatItemStatus::Started,
                    )
                    .await?;
            }
            "item/commandExecution/outputDelta" | "command/exec/outputDelta" => {
                self.append_activity_output(
                    conversation_id,
                    runtime,
                    &params,
                    ChatItemKind::CommandExecution,
                    "stdout",
                )
                .await?;
            }
            "item/fileChange/outputDelta" => {
                self.append_activity_output(
                    conversation_id,
                    runtime,
                    &params,
                    ChatItemKind::FileChange,
                    "patch",
                )
                .await?;
            }
            "item/fileChange/patchUpdated" => {
                let _ = self
                    .upsert_chat_item(
                        conversation_id,
                        runtime,
                        &params,
                        ChatItemKind::FileChange,
                        ChatItemStatus::Streaming,
                    )
                    .await?;
            }
            "item/mcpToolCall/progress" => {
                let _ = self
                    .upsert_chat_item(
                        conversation_id,
                        runtime,
                        &params,
                        ChatItemKind::McpToolCall,
                        ChatItemStatus::Streaming,
                    )
                    .await?;
            }
            "item/autoApprovalReview/started" => {
                let _ = self
                    .upsert_chat_item(
                        conversation_id,
                        runtime,
                        &params,
                        ChatItemKind::AutoApprovalReview,
                        ChatItemStatus::Started,
                    )
                    .await?;
            }
            "item/autoApprovalReview/completed" => {
                let _ = self
                    .upsert_chat_item(
                        conversation_id,
                        runtime,
                        &params,
                        ChatItemKind::AutoApprovalReview,
                        ChatItemStatus::Completed,
                    )
                    .await?;
            }
            "hook/started" => {
                let _ = self
                    .upsert_chat_item(
                        conversation_id,
                        runtime,
                        &params,
                        ChatItemKind::Hook,
                        ChatItemStatus::Started,
                    )
                    .await?;
            }
            "hook/completed" => {
                let _ = self
                    .upsert_chat_item(
                        conversation_id,
                        runtime,
                        &params,
                        ChatItemKind::Hook,
                        ChatItemStatus::Completed,
                    )
                    .await?;
            }
            "model/rerouted" => {
                let _ = self
                    .upsert_chat_item(
                        conversation_id,
                        runtime,
                        &params,
                        ChatItemKind::ModelReroute,
                        ChatItemStatus::Completed,
                    )
                    .await?;
            }
            "turn/plan/updated" => {
                self.upsert_active_plan(conversation_id, runtime, &params)
                    .await?;
            }
            "item/plan/delta" => {
                let delta = params
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !delta.is_empty() {
                    self.append_proposed_plan_delta(conversation_id, runtime, &params, delta)
                        .await?;
                }
            }
            "turn/diff/updated" => {
                self.upsert_diff_summary(conversation_id, runtime, &params)
                    .await?;
            }
            "thread/tokenUsage/updated" => {
                self.upsert_context_usage(conversation_id, runtime, &params)
                    .await?;
            }
            "item/reasoning/summaryTextDelta" => {
                trace_codex_text_event("item/reasoning/summaryTextDelta", conversation_id, &params);
                let delta = params
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if delta.is_empty() {
                    return Ok(());
                }
                let _ = self
                    .append_reasoning_item_delta(
                        conversation_id,
                        runtime,
                        &params,
                        delta,
                        ChatItemStatus::Streaming,
                    )
                    .await?;
                let summary_index = params
                    .get("summaryIndex")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let (message_id, session_id, prefixed_delta) = {
                    let mut state = runtime.state.lock().await;
                    let Some(message_id) = state.active_message_id.clone() else {
                        return Ok(());
                    };
                    let needs_separator = matches!(
                        state.active_reasoning_summary_index,
                        Some(current) if current != summary_index
                    );
                    state.active_reasoning_summary_index = Some(summary_index);
                    state.has_reasoning_projection = true;
                    let prefix = if needs_separator { "\n\n" } else { "" };
                    (
                        message_id,
                        state.session_id.clone(),
                        format!("{prefix}{delta}"),
                    )
                };
                let Some(message) = self
                    .append_message_reasoning_delta(conversation_id, &message_id, &prefixed_delta)
                    .await?
                else {
                    return Ok(());
                };
                if runtime
                    .state
                    .lock()
                    .await
                    .should_emit_reasoning_message_snapshot(&message)
                {
                    self.events.emit(EventKind::ChatMessageUpdated {
                        session_id,
                        conversation_id: conversation_id.to_string(),
                        message,
                    });
                }
            }
            "item/agentMessage/delta" => {
                trace_codex_text_event("item/agentMessage/delta", conversation_id, &params);
                let delta = params
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if delta.is_empty() {
                    return Ok(());
                }
                let route_hints = RouteHints::from_value(&params);
                let (message_id, session_id, is_reasoning_delta, prefixed_delta) = {
                    let mut state = runtime.state.lock().await;
                    let is_reasoning_delta = is_commentary_phase(&params)
                        || route_hints.item_id.as_deref().is_some_and(|item_id| {
                            state
                                .agent_message_projection_by_item_id
                                .get(item_id)
                                .is_some_and(|projection| {
                                    matches!(projection, AgentMessageProjection::Reasoning)
                                })
                        });
                    let prefixed_delta = if is_reasoning_delta {
                        let item_changed = route_hints.item_id.as_ref().is_some_and(|item_id| {
                            state.active_commentary_item_id.as_ref() != Some(item_id)
                        });
                        let prefix = if item_changed && state.has_reasoning_projection {
                            "\n\n"
                        } else {
                            ""
                        };
                        if let Some(item_id) = route_hints.item_id.as_ref() {
                            state.active_commentary_item_id = Some(item_id.clone());
                            state.commentary_delta_seen_item_ids.insert(item_id.clone());
                        }
                        state.has_reasoning_projection = true;
                        format!("{prefix}{delta}")
                    } else {
                        delta.clone()
                    };
                    (
                        state.active_message_id.clone(),
                        state.session_id.clone(),
                        is_reasoning_delta,
                        prefixed_delta,
                    )
                };
                let Some(message_id) = message_id else {
                    return Ok(());
                };
                if is_reasoning_delta {
                    let _ = self
                        .append_reasoning_item_delta(
                            conversation_id,
                            runtime,
                            &params,
                            &delta,
                            ChatItemStatus::Streaming,
                        )
                        .await?;
                    let Some(message) = self
                        .append_message_reasoning_delta(
                            conversation_id,
                            &message_id,
                            &prefixed_delta,
                        )
                        .await?
                    else {
                        return Ok(());
                    };
                    if runtime
                        .state
                        .lock()
                        .await
                        .should_emit_reasoning_message_snapshot(&message)
                    {
                        self.events.emit(EventKind::ChatMessageUpdated {
                            session_id,
                            conversation_id: conversation_id.to_string(),
                            message,
                        });
                    }
                    return Ok(());
                }
                let _ = self
                    .upsert_chat_item(
                        conversation_id,
                        runtime,
                        &params,
                        ChatItemKind::AgentMessage,
                        ChatItemStatus::Streaming,
                    )
                    .await?;
                self.append_message_delta(conversation_id, &message_id, &delta)
                    .await?;
                if let Some(summary) = self.get_conversation_summary(conversation_id).await? {
                    self.events.emit(EventKind::ChatMessageDelta {
                        session_id,
                        conversation_id: conversation_id.to_string(),
                        message_id,
                        delta,
                        revision: summary.revision,
                    });
                }
            }
            "item/completed" => {
                trace_codex_text_event("item/completed", conversation_id, &params);
                let item = params.get("item").cloned().unwrap_or(Value::Null);
                let kind = item_kind_from_params(&params);
                let is_commentary_agent_message = matches!(kind, ChatItemKind::AgentMessage)
                    && (is_commentary_phase(&params) || is_commentary_phase(&item));
                let route_hints = RouteHints::from_value(&params);
                let projection = agent_message_projection_from_value(&params);
                if let (Some(item_id), Some(projection)) =
                    (route_hints.item_id.as_deref(), projection)
                {
                    runtime
                        .state
                        .lock()
                        .await
                        .agent_message_projection_by_item_id
                        .insert(item_id.to_string(), projection);
                }
                self.finalize_proposed_plan_for_item(conversation_id, runtime, &params)
                    .await?;
                if is_plan_payload(&params) {
                    return Ok(());
                }
                let persisted_kind = if is_commentary_agent_message {
                    ChatItemKind::Reasoning
                } else {
                    kind
                };
                let _ = self
                    .upsert_chat_item(
                        conversation_id,
                        runtime,
                        &params,
                        persisted_kind,
                        ChatItemStatus::Completed,
                    )
                    .await?;
                if matches!(kind, ChatItemKind::AgentMessage)
                    && let Some(text) = item.get("text").and_then(Value::as_str)
                {
                    let (message_id, reasoning_completion_delta) = {
                        let mut state = runtime.state.lock().await;
                        let reasoning_completion_delta = if is_commentary_agent_message {
                            let item_id = route_hints.item_id.as_ref();
                            let already_streamed = item_id.is_some_and(|item_id| {
                                state.commentary_delta_seen_item_ids.contains(item_id)
                            });
                            let already_completed = item_id.is_some_and(|item_id| {
                                state.commentary_completed_item_ids.contains(item_id)
                            });
                            if !already_streamed && !already_completed {
                                let prefix = if state.has_reasoning_projection {
                                    "\n\n"
                                } else {
                                    ""
                                };
                                state.has_reasoning_projection = true;
                                if let Some(item_id) = item_id {
                                    state.active_commentary_item_id = Some(item_id.clone());
                                    state.commentary_completed_item_ids.insert(item_id.clone());
                                }
                                Some(format!("{prefix}{text}"))
                            } else {
                                if let Some(item_id) = item_id {
                                    state.commentary_completed_item_ids.insert(item_id.clone());
                                }
                                None
                            }
                        } else {
                            None
                        };
                        (state.active_message_id.clone(), reasoning_completion_delta)
                    };
                    if let Some(message_id) = message_id {
                        if let Some(reasoning_completion_delta) = reasoning_completion_delta {
                            let _ = self
                                .append_reasoning_item_delta(
                                    conversation_id,
                                    runtime,
                                    &params,
                                    text,
                                    ChatItemStatus::Completed,
                                )
                                .await?;
                            let Some(message) = self
                                .append_message_reasoning_delta(
                                    conversation_id,
                                    &message_id,
                                    &reasoning_completion_delta,
                                )
                                .await?
                            else {
                                return Ok(());
                            };
                            let should_emit = runtime
                                .state
                                .lock()
                                .await
                                .should_emit_reasoning_message_snapshot(&message);
                            if should_emit
                                && let Some(summary) =
                                    self.get_conversation_summary(conversation_id).await?
                            {
                                self.events.emit(EventKind::ChatMessageUpdated {
                                    session_id: summary.session_id,
                                    conversation_id: conversation_id.to_string(),
                                    message,
                                });
                            }
                        } else if is_commentary_agent_message {
                            return Ok(());
                        } else {
                            self.replace_message_content(
                                conversation_id,
                                &message_id,
                                text,
                                ChatMessageStatus::Streaming,
                            )
                            .await?;
                        }
                    }
                }
            }
            "turn/completed" => {
                trace_codex_text_event("turn/completed", conversation_id, &params);
                let status = params
                    .get("turn")
                    .and_then(|turn| turn.get("status"))
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                let (run_id, turn_id, message_id, session_id, generation, active_error) = {
                    let mut state = runtime.state.lock().await;
                    state.lifecycle = ChatRuntimeLifecycle::Ready;
                    state.reset_text_projection_state();
                    state.idle_generation = state.idle_generation.saturating_add(1);
                    let generation = state.idle_generation;
                    let active_error = state.active_error.take();
                    (
                        state.active_run_id.take(),
                        state.active_turn_id.take(),
                        state.active_message_id.take(),
                        state.session_id.clone(),
                        generation,
                        active_error,
                    )
                };
                let mut run_status = parse_turn_status(status);
                if let Some(run_id) = run_id {
                    let provider_turn_id = extract_turn_id(&params);
                    let error_message = params
                        .get("turn")
                        .and_then(|turn| turn.get("error"))
                        .and_then(extract_error_message)
                        .or(active_error);
                    let final_text = params
                        .get("turn")
                        .and_then(extract_turn_text)
                        .unwrap_or_default();
                    if matches!(run_status, ChatRunStatus::Completed)
                        && error_message.is_some()
                        && final_text.is_empty()
                    {
                        run_status = ChatRunStatus::Failed;
                    }
                    let message_status = match run_status {
                        ChatRunStatus::Completed => ChatMessageStatus::Completed,
                        ChatRunStatus::Interrupted => ChatMessageStatus::Interrupted,
                        ChatRunStatus::Failed => ChatMessageStatus::Failed,
                        ChatRunStatus::Starting | ChatRunStatus::Running => {
                            ChatMessageStatus::Completed
                        }
                    };
                    let assistant_message = message_id
                        .as_deref()
                        .map(|message_id| (message_id, final_text.as_str(), message_status));
                    let (run, finalized_message) = self
                        .finalize_run(
                            conversation_id,
                            &run_id,
                            run_status,
                            error_message.clone(),
                            assistant_message,
                        )
                        .await?;
                    if let Some(turn_id) = turn_id.as_deref() {
                        let turn = self
                            .finalize_turn(
                                conversation_id,
                                turn_id,
                                chat_turn_status_from_run_status(run_status),
                                error_message.clone(),
                            )
                            .await?;
                        self.finalize_streaming_plans_for_turn(
                            conversation_id,
                            &session_id,
                            turn_id,
                            provider_turn_id.as_deref(),
                            ChatPlanStatus::Completed,
                        )
                        .await?;
                        self.events.emit(EventKind::ChatTurnUpdated {
                            session_id: session_id.clone(),
                            conversation_id: conversation_id.to_string(),
                            turn,
                        });
                    }
                    if let Some(message) = finalized_message {
                        let should_emit = runtime
                            .state
                            .lock()
                            .await
                            .should_emit_reasoning_message_snapshot(&message);
                        debug_assert!(should_emit);
                        self.events.emit(EventKind::ChatMessageUpdated {
                            session_id: session_id.clone(),
                            conversation_id: conversation_id.to_string(),
                            message,
                        });
                    }
                    self.events.emit(EventKind::ChatRunUpdated {
                        session_id: session_id.clone(),
                        conversation_id: conversation_id.to_string(),
                        run,
                    });
                    if let Some(summary) = self.emit_conversation_updated(conversation_id).await? {
                        self.events.emit(EventKind::ChatConversationUpdated {
                            session_id,
                            conversation: summary,
                        });
                    }
                }
                self.emit_thread_stream_status(conversation_id, &runtime.state, None)
                    .await;
                self.mark_pending_requests_stale_for_conversation(
                    conversation_id,
                    "codex turn completed before this request was answered",
                )
                .await?;
                self.schedule_idle_unsubscribe(conversation_id.to_string(), generation);
                self.enforce_inactive_stream_limit().await;
            }
            _ => {}
        }
        Ok(())
    }

    pub(super) async fn handle_provider_closed(
        self: &Arc<Self>,
        reason: String,
    ) -> Result<(), ChatServiceError> {
        self.stream_owner_generation.fetch_add(1, Ordering::AcqRel);
        self.clear_route_indexes();
        self.app_server.mark_fatal(reason.clone()).await;
        self.emit_app_server_status().await;
        let runtimes = self
            .runtimes
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect::<Vec<_>>();
        for (conversation_id, runtime) in runtimes {
            let (run_id, turn_id, message_id, provider_thread_id, owner_generation) = {
                let mut state = runtime.state.lock().await;
                state.lifecycle = ChatRuntimeLifecycle::Failed;
                state.stream_lifecycle.mark_process_lost();
                state.reset_text_projection_state();
                state.inactive_deadline_at = None;
                state.last_error = Some(reason.clone());
                (
                    state.active_run_id.take(),
                    state.active_turn_id.take(),
                    state.active_message_id.take(),
                    state.provider_thread_id.clone(),
                    state.owner_generation,
                )
            };
            if run_id.is_some() || turn_id.is_some() || message_id.is_some() {
                let reconciliation = self
                    .mark_reconciliation_pending(
                        &conversation_id,
                        provider_thread_id,
                        "codex app-server exited before the active turn completed",
                        owner_generation,
                    )
                    .await?;
                if let Some(summary) = self.emit_conversation_updated(&conversation_id).await? {
                    self.events.emit(EventKind::ChatReconciliationStarted {
                        session_id: summary.session_id,
                        reconciliation,
                    });
                }
            }
            self.emit_thread_stream_status(&conversation_id, &runtime.state, Some(reason.clone()))
                .await;
            self.mark_pending_requests_stale_for_conversation(
                &conversation_id,
                "codex app-server exited before this request was answered",
            )
            .await?;
        }
        Ok(())
    }

    fn schedule_idle_unsubscribe(self: &Arc<Self>, conversation_id: String, generation: u64) {
        let service = self.clone();
        tokio::spawn(async move {
            let minutes = service
                .settings
                .get()
                .await
                .settings
                .chat
                .idle_timeout_minutes;
            let timeout = Duration::from_secs(u64::from(minutes) * 60);
            service
                .schedule_unsubscribe_after(conversation_id, generation, timeout)
                .await;
        });
    }

    fn schedule_unsubscribe_retry(self: &Arc<Self>, conversation_id: String, generation: u64) {
        let service = self.clone();
        tokio::spawn(async move {
            service
                .schedule_unsubscribe_after(conversation_id, generation, UNSUBSCRIBE_RETRY_DELAY)
                .await;
        });
    }

    async fn schedule_unsubscribe_after(
        self: Arc<Self>,
        conversation_id: String,
        generation: u64,
        timeout: Duration,
    ) {
        let deadline = now_ms().saturating_add(timeout.as_millis() as u64);
        // Clone the Arc'd state out of the DashMap so the shard guard is
        // dropped before awaiting the runtime mutex.
        let runtime_state = self
            .runtimes
            .get(&conversation_id)
            .map(|entry| entry.state.clone());
        if let Some(runtime_state) = runtime_state {
            let mut state = runtime_state.lock().await;
            if state.idle_generation == generation {
                state.inactive_deadline_at = Some(deadline);
            }
        }
        tokio::time::sleep(timeout).await;
        // Re-fetch after the sleep; the runtime may have been replaced or
        // removed while this task was suspended.
        let runtime_state = self
            .runtimes
            .get(&conversation_id)
            .map(|entry| entry.state.clone());
        let should_unsubscribe = if let Some(runtime_state) = runtime_state {
            let state = runtime_state.lock().await;
            state.active_run_id.is_none()
                && state.idle_generation == generation
                && state.provider_thread_id.is_some()
                && matches!(
                    state.stream_lifecycle.resume_state(),
                    ThreadStreamResumeState::Resumed
                )
        } else {
            false
        };
        if should_unsubscribe {
            let _ = self.unsubscribe_runtime(&conversation_id).await;
        }
    }

    pub(super) async fn unsubscribe_runtime(
        self: &Arc<Self>,
        conversation_id: &str,
    ) -> Result<(), ChatServiceError> {
        let runtime = {
            self.runtimes
                .get(conversation_id)
                .map(|entry| entry.value().clone())
        };
        let Some(runtime) = runtime else {
            return Ok(());
        };
        let provider_thread_id = {
            let mut state = runtime.state.lock().await;
            let provider_thread_id = state.provider_thread_id.clone();
            state.lifecycle = ChatRuntimeLifecycle::Stopping;
            state.inactive_deadline_at = None;
            provider_thread_id
        };
        self.emit_thread_stream_status(conversation_id, &runtime.state, None)
            .await;
        let Some(provider_thread_id) = provider_thread_id else {
            return Ok(());
        };
        match self
            .app_server
            .request(
                "thread/unsubscribe",
                json!({ "threadId": provider_thread_id }),
            )
            .await
        {
            Ok(_) => {
                {
                    let mut state = runtime.state.lock().await;
                    state.lifecycle = ChatRuntimeLifecycle::Stopped;
                    state.stream_lifecycle.mark_needs_resume();
                    state.inactive_deadline_at = None;
                    state.last_error = None;
                }
                self.mark_pending_requests_stale_for_conversation(
                    conversation_id,
                    "codex thread stream was unsubscribed before this request was answered",
                )
                .await?;
                self.emit_thread_stream_status(conversation_id, &runtime.state, None)
                    .await;
            }
            Err(error) => {
                let retry_at = now_ms().saturating_add(UNSUBSCRIBE_RETRY_DELAY.as_millis() as u64);
                let generation = {
                    let mut state = runtime.state.lock().await;
                    state.lifecycle = ChatRuntimeLifecycle::Ready;
                    state.inactive_deadline_at = Some(retry_at);
                    state.last_error = Some(error.message.clone());
                    state.idle_generation = state.idle_generation.saturating_add(1);
                    state.idle_generation
                };
                self.emit_thread_stream_status(
                    conversation_id,
                    &runtime.state,
                    Some(error.message),
                )
                .await;
                self.schedule_unsubscribe_retry(conversation_id.to_string(), generation);
            }
        }
        Ok(())
    }

    async fn enforce_inactive_stream_limit(self: &Arc<Self>) {
        let runtimes = self
            .runtimes
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect::<Vec<_>>();
        let mut inactive = Vec::new();
        for (conversation_id, runtime) in runtimes {
            let state = runtime.state.lock().await;
            if state.active_run_id.is_none()
                && matches!(state.lifecycle, ChatRuntimeLifecycle::Ready)
                && matches!(
                    state.stream_lifecycle.resume_state(),
                    ThreadStreamResumeState::Resumed
                )
            {
                inactive.push((state.idle_generation, conversation_id));
            }
        }
        inactive.sort_by_key(|(generation, _)| *generation);
        let overflow = inactive.len().saturating_sub(MAX_INACTIVE_THREAD_STREAMS);
        for (_, conversation_id) in inactive.into_iter().take(overflow) {
            let _ = self.unsubscribe_runtime(&conversation_id).await;
        }
    }

    async fn emit_app_server_status(&self) {
        self.events.emit(EventKind::ChatAppServerUpdated {
            app_server: self.app_server.status().await,
        });
    }

    async fn emit_thread_stream_status(
        &self,
        conversation_id: &str,
        runtime_state: &Arc<Mutex<RuntimeState>>,
        last_error: Option<String>,
    ) {
        let state = runtime_state.lock().await.clone();
        self.events.emit(EventKind::ChatThreadStreamUpdated {
            session_id: state.session_id.clone(),
            stream: thread_stream_status_from_state(
                conversation_id,
                state.clone(),
                last_error.clone(),
            ),
        });
        self.events.emit(EventKind::ChatRuntimeUpdated {
            session_id: state.session_id.clone(),
            runtime: ChatRuntimeStatus {
                conversation_id: conversation_id.to_string(),
                session_id: state.session_id.clone(),
                project_id: state.project_id.clone(),
                worktree_id: state.worktree_id.clone(),
                lifecycle: state.lifecycle,
                active_run_id: state.active_run_id.clone(),
                active_message_id: state.active_message_id.clone(),
                provider_thread_id: state.provider_thread_id.clone(),
                last_error: last_error.or(state.last_error),
                updated_at: now_ms(),
            },
        });
    }

    pub(super) async fn emit_conversation_updated(
        &self,
        conversation_id: &str,
    ) -> Result<Option<ChatConversationSummary>, ChatServiceError> {
        let Some(summary) = self.get_conversation_summary(conversation_id).await? else {
            return Ok(None);
        };
        self.events.emit(EventKind::ChatConversationUpdated {
            session_id: summary.session_id.clone(),
            conversation: summary.clone(),
        });
        Ok(Some(summary))
    }

    pub(super) fn cleanup_conversation_runtime(&self, conversation_id: &str) {
        self.runtimes.remove(conversation_id);
        self.op_locks.remove(conversation_id);
        self.thread_to_conversation
            .retain(|_, route| route.conversation_id != conversation_id);
        self.turn_to_conversation
            .retain(|_, route| route.conversation_id != conversation_id);
        self.item_to_conversation
            .retain(|_, route| route.conversation_id != conversation_id);
        self.server_request_to_conversation
            .retain(|_, route| route.route.conversation_id != conversation_id);
        self.pending_server_responders
            .retain(|_, responder| responder.conversation_id != conversation_id);
    }

    pub(super) fn operation_lock(&self, conversation_id: &str) -> Arc<Mutex<()>> {
        self.op_locks
            .entry(conversation_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::test_support::*;

    /// Regression test: `touch_runtime` used to hold a DashMap shard read
    /// guard across the runtime mutex await. On a single-threaded runtime
    /// that deadlocks as soon as another task does a blocking insert into
    /// the same shard while the mutex is contended. The scenario runs on a
    /// dedicated runtime thread so a regression fails via timeout instead
    /// of hanging the whole test suite.
    #[test]
    fn touch_runtime_does_not_hold_shard_guard_across_await() {
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async move {
                let service = test_service().await;
                let runtime =
                    insert_test_runtime(&service, "chat-guard", "thread-guard", false, 1).await;

                // Hold the runtime mutex so the touch task suspends at its
                // `.lock().await` point.
                let state_guard = runtime.state.lock().await;
                let toucher = {
                    let service = service.clone();
                    tokio::spawn(async move { service.touch_runtime("chat-guard").await })
                };
                // Let the touch task run until it parks on the mutex.
                for _ in 0..8 {
                    tokio::task::yield_now().await;
                }

                // Same key, therefore same shard: if the suspended touch
                // task still owned the shard read guard, this blocking
                // write would deadlock the only executor thread.
                service.runtimes.insert(
                    "chat-guard".to_string(),
                    RuntimeEntry {
                        state: runtime.state.clone(),
                    },
                );

                drop(state_guard);
                toucher.await.unwrap();
            });
            let _ = done_tx.send(());
        });
        done_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("touch_runtime deadlocked holding a DashMap shard guard across an await");
    }

    #[tokio::test]
    async fn routes_notification_by_turn_id_with_multiple_active_streams() {
        let service = test_service().await;
        let runtime_a = insert_test_runtime(&service, "chat-a", "thread-a", true, 1).await;
        let runtime_b = insert_test_runtime(&service, "chat-b", "thread-b", true, 1).await;
        service
            .register_turn_route("chat-a", &runtime_a, "turn-a")
            .await;
        service
            .register_turn_route("chat-b", &runtime_b, "turn-b")
            .await;

        let (conversation_id, _) = service
            .runtime_for_provider_event(&route_hints(None, Some("turn-b"), None, None))
            .await
            .expect("turn route should resolve");

        assert_eq!(conversation_id, "chat-b");
    }

    #[tokio::test]
    async fn routes_server_request_by_item_id_and_records_pending_request() {
        let service = test_service().await;
        let runtime_a = insert_test_runtime(&service, "chat-a", "thread-a", true, 1).await;
        let _runtime_b = insert_test_runtime(&service, "chat-b", "thread-b", true, 1).await;
        service
            .register_item_route("chat-a", &runtime_a, "item-a")
            .await;

        let hints = route_hints(None, None, Some("item-a"), Some("request-a"));
        let (conversation_id, runtime) = service
            .runtime_for_provider_event(&hints)
            .await
            .expect("item route should resolve");
        service
            .register_pending_server_request(
                &conversation_id,
                &runtime,
                "item/commandExecution/requestApproval",
                &hints,
            )
            .await;

        let (conversation_id, _) = service
            .runtime_for_provider_event(&route_hints(None, None, None, Some("request-a")))
            .await
            .expect("pending request route should resolve");

        assert_eq!(conversation_id, "chat-a");
        let pending = service
            .server_request_to_conversation
            .get("request-a")
            .expect("request route should be recorded");
        assert_eq!(pending.method, "item/commandExecution/requestApproval");
        assert_eq!(pending.item_id.as_deref(), Some("item-a"));
    }

    #[tokio::test]
    async fn server_request_resolved_clears_pending_request_route() {
        let service = test_service().await;
        let runtime = insert_test_runtime(&service, "chat-a", "thread-a", true, 1).await;
        let hints = route_hints(None, Some("turn-a"), None, Some("request-a"));
        service
            .register_pending_server_request(
                "chat-a",
                &runtime,
                "item/tool/requestUserInput",
                &hints,
            )
            .await;

        service
            .handle_provider_notification(
                "chat-a",
                &runtime,
                "serverRequest/resolved",
                json!({ "requestId": "request-a" }),
            )
            .await
            .unwrap();

        assert!(
            !service
                .server_request_to_conversation
                .contains_key("request-a")
        );
    }

    #[tokio::test]
    async fn unroutable_multi_stream_event_has_no_fallback() {
        let service = test_service().await;
        insert_test_runtime(&service, "chat-a", "thread-a", true, 1).await;
        insert_test_runtime(&service, "chat-b", "thread-b", true, 1).await;

        assert!(
            service
                .runtime_for_provider_event(&RouteHints::default())
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn stale_owner_route_entries_are_ignored() {
        let service = test_service().await;
        insert_test_runtime(&service, "chat-a", "thread-a", true, 2).await;
        service.turn_to_conversation.insert(
            "turn-a".to_string(),
            RouteEntry {
                conversation_id: "chat-a".to_string(),
                owner_generation: 1,
            },
        );

        assert!(
            service
                .runtime_for_provider_event(&route_hints(None, Some("turn-a"), None, None))
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn thread_id_route_takes_precedence_over_turn_id_route() {
        let service = test_service().await;
        let runtime_a = insert_test_runtime(&service, "chat-a", "thread-a", true, 1).await;
        let runtime_b = insert_test_runtime(&service, "chat-b", "thread-b", true, 1).await;
        service
            .register_turn_route("chat-b", &runtime_b, "turn-shared")
            .await;
        service
            .register_provider_thread_route("chat-a", &runtime_a, "thread-a")
            .await;

        let (conversation_id, _) = service
            .runtime_for_provider_event(&route_hints(
                Some("thread-a"),
                Some("turn-shared"),
                None,
                None,
            ))
            .await
            .expect("thread route should win");

        assert_eq!(conversation_id, "chat-a");
    }

    #[tokio::test]
    async fn single_active_stream_fallback_still_routes_legacy_events() {
        let service = test_service().await;
        insert_test_runtime(&service, "chat-a", "thread-a", true, 1).await;
        insert_test_runtime(&service, "chat-b", "thread-b", false, 1).await;

        let (conversation_id, _) = service
            .runtime_for_provider_event(&RouteHints::default())
            .await
            .expect("single active stream should be fallback");

        assert_eq!(conversation_id, "chat-a");
    }

    #[tokio::test]
    async fn provider_event_loop_restarts_after_closed_event() {
        let service = test_service().await;
        let requests = Arc::new(Mutex::new(Vec::new()));
        let connection = Arc::new(FakeCodexConnection::new(requests));

        service.ensure_provider_event_loop(connection.clone()).await;
        wait_for_provider_event_loop(&service, &connection, false).await;
        connection
            .stream_events
            .send(CodexStreamEvent::Closed {
                reason: "first connection closed".to_string(),
            })
            .unwrap();
        wait_for_provider_event_loop(&service, &connection, true).await;

        service.ensure_provider_event_loop(connection.clone()).await;
        wait_for_provider_event_loop(&service, &connection, false).await;
        connection
            .stream_events
            .send(CodexStreamEvent::Closed {
                reason: "second connection closed".to_string(),
            })
            .unwrap();
        wait_for_provider_event_loop(&service, &connection, true).await;
    }
}
