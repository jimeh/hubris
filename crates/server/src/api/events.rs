use std::convert::Infallible;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::Stream;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::state::AppState;

/// GET /api/events — SSE stream of state mutations.
pub async fn events_handler(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>>
{
    let rx = state.events_tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(
        |result| match result {
            Ok(event) => {
                let json =
                    serde_json::to_string(&event)
                        .unwrap();
                Some(Ok(Event::default().data(json)))
            }
            Err(_) => None, // lagged, skip
        },
    );

    Sse::new(stream)
        .keep_alive(KeepAlive::default())
}
