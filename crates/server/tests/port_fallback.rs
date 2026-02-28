use hubris_server::bind_with_port_fallback;
use tokio::net::TcpListener;

#[tokio::test]
async fn test_binds_default_port() {
    let listener =
        bind_with_port_fallback("127.0.0.1", 14001, 10)
            .await
            .unwrap();
    assert_eq!(
        listener.local_addr().unwrap().port(),
        14001
    );
}

#[tokio::test]
async fn test_falls_back_when_port_in_use() {
    let _blocker =
        TcpListener::bind("127.0.0.1:14101")
            .await
            .unwrap();
    let listener =
        bind_with_port_fallback("127.0.0.1", 14101, 10)
            .await
            .unwrap();
    assert_eq!(
        listener.local_addr().unwrap().port(),
        14102
    );
}

#[tokio::test]
async fn test_skips_multiple_occupied_ports() {
    let _b1 =
        TcpListener::bind("127.0.0.1:14201")
            .await
            .unwrap();
    let _b2 =
        TcpListener::bind("127.0.0.1:14202")
            .await
            .unwrap();
    let _b3 =
        TcpListener::bind("127.0.0.1:14203")
            .await
            .unwrap();
    let listener =
        bind_with_port_fallback("127.0.0.1", 14201, 10)
            .await
            .unwrap();
    assert_eq!(
        listener.local_addr().unwrap().port(),
        14204
    );
}

#[tokio::test]
async fn test_fails_when_all_ports_exhausted() {
    let mut blockers = vec![];
    for port in 14301..14304 {
        blockers.push(
            TcpListener::bind(
                format!("127.0.0.1:{port}"),
            )
            .await
            .unwrap(),
        );
    }
    let result =
        bind_with_port_fallback("127.0.0.1", 14301, 3)
            .await;
    assert!(result.is_err());
}
