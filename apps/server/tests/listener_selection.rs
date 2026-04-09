use hubris_server::select_listener;
use tokio::net::TcpListener;

#[tokio::test]
async fn test_prefers_inherited_listener_when_present() {
    let inherited = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let inherited_port = inherited.local_addr().unwrap().port();

    let listener = select_listener(Some(inherited), "127.0.0.1", 3001, true, 100, 10)
        .await
        .unwrap();

    assert_eq!(listener.local_addr().unwrap().port(), inherited_port);
}

#[tokio::test]
async fn test_dev_fallback_uses_offset_and_increments() {
    let _blocker = TcpListener::bind("127.0.0.1:25100").await.unwrap();

    let listener = select_listener(None, "127.0.0.1", 25000, true, 100, 3)
        .await
        .unwrap();

    assert_eq!(listener.local_addr().unwrap().port(), 25101);
}

#[tokio::test]
async fn test_non_dev_binds_exact_base_port() {
    let listener = select_listener(None, "127.0.0.1", 25200, false, 100, 10)
        .await
        .unwrap();

    assert_eq!(listener.local_addr().unwrap().port(), 25200);
}
