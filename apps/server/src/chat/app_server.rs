use super::*;

/// Upper bound on a single app-server JSON-RPC round-trip. Generous so a
/// slow-but-alive server (cold start, large thread resume) is never cut
/// off; only a truly wedged process hits it.
const APP_SERVER_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub(super) struct PendingServerResponder {
    pub(super) jsonrpc_id: Value,
    pub(super) conversation_id: String,
    pub(super) provider_request_id: String,
    pub(super) owner_generation: u64,
}

pub(super) struct PersistProviderRequest {
    pub(super) jsonrpc_id: Value,
    pub(super) method: String,
    pub(super) params: Value,
    pub(super) route_hints: RouteHints,
    pub(super) status: ChatPendingRequestStatus,
    pub(super) decision: Option<ChatPendingRequestDecision>,
    pub(super) error_message: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) enum CodexStreamEvent {
    ServerRequest {
        id: Value,
        method: String,
        params: Value,
        thread_id: Option<String>,
        route_hints: RouteHints,
    },
    Notification {
        method: String,
        params: Value,
        thread_id: Option<String>,
        route_hints: RouteHints,
    },
    Closed {
        reason: String,
    },
}

pub(super) type CodexAppServerFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub(super) type CodexAppServerConnectionRef = Arc<dyn CodexAppServerConnection>;
pub(super) type CodexAppServerFactory = Arc<
    dyn Fn() -> CodexAppServerFuture<'static, Result<CodexAppServerConnectionRef, ChatServiceError>>
        + Send
        + Sync,
>;

pub(super) trait CodexAppServerConnection: Send + Sync {
    fn request<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> CodexAppServerFuture<'a, Result<Value, ChatServiceError>>;

    fn respond_result<'a>(
        &'a self,
        id: Value,
        result: Value,
    ) -> CodexAppServerFuture<'a, Result<(), ChatServiceError>>;

    fn subscribe(&self) -> broadcast::Receiver<CodexStreamEvent>;

    fn lifecycle_state<'a>(&'a self) -> CodexAppServerFuture<'a, AppServerProcessState>;
}

type PendingResponseTx = oneshot::Sender<Result<Value, ChatServiceError>>;
type PendingResponses = HashMap<u64, PendingResponseTx>;

#[derive(Debug)]
struct CodexAppServerClient {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    next_id: AtomicU64,
    pending: Arc<Mutex<PendingResponses>>,
    stream_events: broadcast::Sender<CodexStreamEvent>,
    lifecycle: Arc<Mutex<AppServerLifecycle>>,
}

impl CodexAppServerClient {
    async fn spawn() -> Result<Arc<Self>, ChatServiceError> {
        let mut initial_lifecycle = AppServerLifecycle::default();
        initial_lifecycle.mark_starting();
        let lifecycle = Arc::new(Mutex::new(initial_lifecycle));
        let mut child = Command::new("codex")
            .args(["app-server", "--listen", "stdio://"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|error| {
                ChatServiceError::new(
                    ChatErrorKind::Internal,
                    format!("failed to start codex app-server: {error}"),
                )
            })?;

        let stdin = child.stdin.take().ok_or_else(|| {
            ChatServiceError::new(
                ChatErrorKind::Internal,
                "codex app-server stdin unavailable",
            )
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            ChatServiceError::new(
                ChatErrorKind::Internal,
                "codex app-server stdout unavailable",
            )
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            ChatServiceError::new(
                ChatErrorKind::Internal,
                "codex app-server stderr unavailable",
            )
        })?;

        let (stream_events, _) = broadcast::channel(256);
        let client = Arc::new(Self {
            stdin: Arc::new(Mutex::new(stdin)),
            child: Arc::new(Mutex::new(child)),
            next_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            stream_events,
            lifecycle,
        });

        Self::spawn_stdout_reader(client.clone(), stdout);
        Self::spawn_stderr_reader(stderr);
        {
            let mut lifecycle = client.lifecycle.lock().await;
            lifecycle.mark_initializing();
        }
        if let Err(error) = client.initialize().await {
            let mut lifecycle = client.lifecycle.lock().await;
            lifecycle.mark_fatal();
            drop(lifecycle);
            client.shutdown().await;
            return Err(error);
        }
        {
            let mut lifecycle = client.lifecycle.lock().await;
            lifecycle.mark_ready();
        }
        Ok(client)
    }

    fn spawn_stdout_reader(client: Arc<Self>, stdout: tokio::process::ChildStdout) {
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            loop {
                match reader.next_line().await {
                    Ok(Some(line)) => {
                        if line.trim().is_empty() {
                            continue;
                        }

                        match protocol::parse_jsonrpc_line(&line) {
                            ParsedLine::ServerRequest {
                                id,
                                method,
                                method_kind,
                                params,
                                thread_id,
                                route_hints,
                            } => {
                                tracing::trace!(
                                    method = method_kind.name(),
                                    thread_id = thread_id.as_deref().unwrap_or(""),
                                    "codex app-server server request"
                                );
                                let _ =
                                    client.stream_events.send(CodexStreamEvent::ServerRequest {
                                        id,
                                        method,
                                        params,
                                        thread_id,
                                        route_hints,
                                    });
                            }
                            ParsedLine::Notification {
                                method,
                                method_kind,
                                params,
                                thread_id,
                                route_hints,
                            } => {
                                tracing::trace!(
                                    method = method_kind.name(),
                                    thread_id = thread_id.as_deref().unwrap_or(""),
                                    "codex app-server notification"
                                );
                                let _ = client.stream_events.send(CodexStreamEvent::Notification {
                                    method,
                                    params,
                                    thread_id,
                                    route_hints,
                                });
                            }
                            ParsedLine::Response {
                                id,
                                result,
                                error_message,
                            } => {
                                let mut pending = client.pending.lock().await;
                                if let Some(reply) = pending.remove(&id) {
                                    let result = if let Some(message) = error_message {
                                        Err(ChatServiceError::new(ChatErrorKind::Upstream, message))
                                    } else {
                                        Ok(result)
                                    };
                                    let _ = reply.send(result);
                                }
                            }
                            ParsedLine::Malformed { reason } => {
                                tracing::warn!(reason, "invalid codex app-server JSON-RPC line");
                            }
                            ParsedLine::Unsupported { reason } => {
                                tracing::warn!(
                                    reason,
                                    "unsupported codex app-server JSON-RPC message"
                                );
                            }
                        }
                    }
                    Ok(None) => {
                        let _ = client.stream_events.send(CodexStreamEvent::Closed {
                            reason: "codex app-server stdout closed".to_string(),
                        });
                        break;
                    }
                    Err(error) => {
                        let _ = client.stream_events.send(CodexStreamEvent::Closed {
                            reason: format!("failed to read codex app-server output: {error}"),
                        });
                        break;
                    }
                }
            }

            let mut pending = client.pending.lock().await;
            for (_, reply) in pending.drain() {
                let _ = reply.send(Err(ChatServiceError::new(
                    ChatErrorKind::Upstream,
                    "codex app-server disconnected",
                )));
            }
        });
    }

    fn spawn_stderr_reader(stderr: tokio::process::ChildStderr) {
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if !line.trim().is_empty() {
                    tracing::debug!("codex app-server stderr: {line}");
                }
            }
        });
    }

    async fn initialize(&self) -> Result<(), ChatServiceError> {
        self.request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "hubris",
                    "title": "Hubris",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": {
                    "experimentalApi": true
                }
            }),
        )
        .await?;
        self.notify("initialized", Value::Null).await
    }

    fn subscribe(&self) -> broadcast::Receiver<CodexStreamEvent> {
        self.stream_events.subscribe()
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, ChatServiceError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let (reply_tx, reply_rx) = oneshot::channel();
        self.pending.lock().await.insert(id, reply_tx);
        self.write_payload(&payload).await?;
        // A wedged app-server that never answers must not hang callers
        // forever — initialize() holds startup_lock, so an unbounded wait
        // here can stall every chat operation behind it.
        match tokio::time::timeout(APP_SERVER_REQUEST_TIMEOUT, reply_rx).await {
            Ok(reply) => reply.map_err(|_| {
                ChatServiceError::new(
                    ChatErrorKind::Upstream,
                    "codex app-server response channel closed",
                )
            })?,
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(ChatServiceError::new(
                    ChatErrorKind::Upstream,
                    format!("codex app-server request timed out: {method}"),
                ))
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), ChatServiceError> {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.write_payload(&payload).await
    }

    async fn respond_result(&self, id: Value, result: Value) -> Result<(), ChatServiceError> {
        self.write_payload(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        }))
        .await
    }

    async fn write_payload(&self, payload: &Value) -> Result<(), ChatServiceError> {
        let encoded = serde_json::to_vec(payload).map_err(|error| {
            ChatServiceError::new(
                ChatErrorKind::Internal,
                format!("failed to encode codex app-server payload: {error}"),
            )
        })?;
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(&encoded).await.map_err(|error| {
            ChatServiceError::new(
                ChatErrorKind::Upstream,
                format!("failed to write to codex app-server: {error}"),
            )
        })?;
        stdin.write_all(b"\n").await.map_err(|error| {
            ChatServiceError::new(
                ChatErrorKind::Upstream,
                format!("failed to write to codex app-server: {error}"),
            )
        })?;
        stdin.flush().await.map_err(|error| {
            ChatServiceError::new(
                ChatErrorKind::Upstream,
                format!("failed to flush codex app-server stdin: {error}"),
            )
        })?;
        Ok(())
    }

    async fn shutdown(&self) {
        let was_fatal = {
            let mut lifecycle = self.lifecycle.lock().await;
            let was_fatal = lifecycle.is_fatal();
            if !was_fatal {
                lifecycle.mark_stopping();
            }
            was_fatal
        };
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
        let _ = child.wait().await;
        if was_fatal {
            return;
        }
        let mut lifecycle = self.lifecycle.lock().await;
        lifecycle.mark_stopped();
    }

    async fn lifecycle_state(&self) -> AppServerProcessState {
        self.lifecycle.lock().await.state()
    }
}

impl CodexAppServerConnection for CodexAppServerClient {
    fn request<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> CodexAppServerFuture<'a, Result<Value, ChatServiceError>> {
        Box::pin(async move { CodexAppServerClient::request(self, method, params).await })
    }

    fn respond_result<'a>(
        &'a self,
        id: Value,
        result: Value,
    ) -> CodexAppServerFuture<'a, Result<(), ChatServiceError>> {
        Box::pin(async move { CodexAppServerClient::respond_result(self, id, result).await })
    }

    fn subscribe(&self) -> broadcast::Receiver<CodexStreamEvent> {
        CodexAppServerClient::subscribe(self)
    }

    fn lifecycle_state<'a>(&'a self) -> CodexAppServerFuture<'a, AppServerProcessState> {
        Box::pin(async move { CodexAppServerClient::lifecycle_state(self).await })
    }
}

pub(super) struct CodexAppServerManager {
    client: Mutex<Option<CodexAppServerConnectionRef>>,
    startup_lock: Mutex<()>,
    lifecycle: Mutex<AppServerLifecycle>,
    last_error: Mutex<Option<String>>,
    factory: CodexAppServerFactory,
}

impl CodexAppServerManager {
    pub(super) fn new() -> Self {
        Self {
            client: Mutex::new(None),
            startup_lock: Mutex::new(()),
            lifecycle: Mutex::new(AppServerLifecycle::default()),
            last_error: Mutex::new(None),
            factory: Arc::new(|| {
                Box::pin(async {
                    CodexAppServerClient::spawn()
                        .await
                        .map(|client| client as CodexAppServerConnectionRef)
                })
            }),
        }
    }

    #[cfg(test)]
    pub(super) fn new_for_tests(factory: CodexAppServerFactory) -> Self {
        Self {
            client: Mutex::new(None),
            startup_lock: Mutex::new(()),
            lifecycle: Mutex::new(AppServerLifecycle::default()),
            last_error: Mutex::new(None),
            factory,
        }
    }

    pub(super) async fn ensure_client(
        &self,
    ) -> Result<CodexAppServerConnectionRef, ChatServiceError> {
        if let Some(existing) = self.client.lock().await.as_ref().cloned() {
            return Ok(existing);
        }

        let _startup_guard = self.startup_lock.lock().await;
        if let Some(existing) = self.client.lock().await.as_ref().cloned() {
            return Ok(existing);
        }

        {
            let mut lifecycle = self.lifecycle.lock().await;
            lifecycle.mark_starting();
        }
        *self.last_error.lock().await = None;

        match (self.factory)().await {
            Ok(next_client) => {
                {
                    let mut lifecycle = self.lifecycle.lock().await;
                    lifecycle.mark_ready();
                }
                *self.client.lock().await = Some(next_client.clone());
                Ok(next_client)
            }
            Err(error) => {
                {
                    let mut lifecycle = self.lifecycle.lock().await;
                    lifecycle.mark_fatal();
                }
                *self.last_error.lock().await = Some(error.message.clone());
                Err(error)
            }
        }
    }

    pub(super) async fn request(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, ChatServiceError> {
        let client = self.ensure_client().await?;
        client.request(method, params).await
    }

    pub(super) async fn respond_result(
        &self,
        id: Value,
        result: Value,
    ) -> Result<(), ChatServiceError> {
        let Some(client) = self.client.lock().await.as_ref().cloned() else {
            return Err(ChatServiceError::new(
                ChatErrorKind::Upstream,
                "codex app-server is not running",
            ));
        };
        client.respond_result(id, result).await
    }

    pub(super) async fn mark_fatal(&self, reason: String) {
        {
            let mut lifecycle = self.lifecycle.lock().await;
            lifecycle.mark_fatal();
        }
        *self.last_error.lock().await = Some(reason);
        *self.client.lock().await = None;
    }

    pub(super) async fn status(&self) -> ChatAppServerStatus {
        let client = self.client.lock().await.as_ref().cloned();
        let lifecycle = if let Some(client) = client {
            chat_app_server_lifecycle_from_process(client.lifecycle_state().await)
        } else {
            chat_app_server_lifecycle_from_process(self.lifecycle.lock().await.state())
        };
        ChatAppServerStatus {
            lifecycle,
            last_error: self.last_error.lock().await.clone(),
            updated_at: now_ms(),
        }
    }
}

fn chat_app_server_lifecycle_from_process(state: AppServerProcessState) -> ChatAppServerLifecycle {
    match state {
        AppServerProcessState::Stopped => ChatAppServerLifecycle::Stopped,
        AppServerProcessState::Starting => ChatAppServerLifecycle::Starting,
        AppServerProcessState::Initializing => ChatAppServerLifecycle::Initializing,
        AppServerProcessState::Ready => ChatAppServerLifecycle::Ready,
        AppServerProcessState::Stopping => ChatAppServerLifecycle::Stopping,
        AppServerProcessState::Fatal => ChatAppServerLifecycle::Fatal,
    }
}

impl ChatService {
    /// List Codex models available to the current app-server installation.
    pub async fn list_models(&self) -> Result<Vec<ChatModelOption>, ChatServiceError> {
        let response = self
            .app_server
            .request("model/list", json!({ "includeHidden": false }))
            .await?;

        let models = response
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(model_option_from_value)
            .collect::<Vec<_>>();
        Ok(models)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::test_support::*;

    #[tokio::test]
    async fn app_server_manager_serializes_injected_startup() {
        let created = Arc::new(AtomicU64::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let factory: CodexAppServerFactory = Arc::new({
            let created = created.clone();
            let requests = requests.clone();
            move || {
                let created = created.clone();
                let requests = requests.clone();
                Box::pin(async move {
                    created.fetch_add(1, Ordering::SeqCst);
                    Ok(Arc::new(FakeCodexConnection::new(requests)) as CodexAppServerConnectionRef)
                })
            }
        });
        let manager = Arc::new(CodexAppServerManager::new_for_tests(factory));

        let (models, thread) = tokio::join!(
            manager.request("model/list", json!({ "includeHidden": false })),
            manager.request("thread/start", json!({ "cwd": "/tmp/worktree" })),
        );

        assert!(models.is_ok());
        assert!(thread.is_ok());
        assert_eq!(created.load(Ordering::SeqCst), 1);

        let requests = requests.lock().await;
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().any(|(method, _)| method == "model/list"));
        assert!(requests.iter().any(|(method, params)| {
            method == "thread/start"
                && params.get("cwd").and_then(Value::as_str) == Some("/tmp/worktree")
        }));
    }
}
