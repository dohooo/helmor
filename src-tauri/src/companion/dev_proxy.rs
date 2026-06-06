//! Development-only frontend proxy for the mobile companion.
//!
//! In release the companion serves the embedded Tauri frontend bundle. In dev,
//! `HELMOR_COMPANION_DEV_PROXY=1` points the companion's frontend fallback at
//! Vite so a phone browser gets real HMR while IPC stays same-origin.

use anyhow::{anyhow, Result};
use axum::{
    body::{Body, Bytes},
    extract::ws::{CloseFrame as AxumCloseFrame, Message as AxumMessage, WebSocket},
    http::{
        header::{
            AUTHORIZATION, CACHE_CONTROL, CONNECTION, CONTENT_ENCODING, CONTENT_LENGTH,
            CONTENT_TYPE, COOKIE, HOST, ORIGIN, PROXY_AUTHENTICATE, PROXY_AUTHORIZATION,
            SEC_WEBSOCKET_PROTOCOL, TE, TRAILER, TRANSFER_ENCODING, UPGRADE,
        },
        HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri,
    },
    response::{IntoResponse, Response},
};
use futures::{SinkExt, StreamExt};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        protocol::{
            frame::coding::CloseCode as TungsteniteCloseCode, CloseFrame as TungsteniteCloseFrame,
            Message as TungsteniteMessage,
        },
    },
};
use url::Url;

use super::server::inject_companion_marker;

const DEV_PROXY_ENV: &str = "HELMOR_COMPANION_DEV_PROXY";

#[derive(Clone)]
pub struct DevFrontendProxy {
    origin: Url,
    client: reqwest::Client,
}

impl DevFrontendProxy {
    pub fn from_config(dev_url: Option<Url>) -> Option<Self> {
        if !cfg!(debug_assertions) || std::env::var(DEV_PROXY_ENV).as_deref() != Ok("1") {
            return None;
        }
        dev_url.map(Self::new)
    }

    pub fn new(origin: Url) -> Self {
        Self {
            origin,
            client: reqwest::Client::new(),
        }
    }

    pub async fn proxy_http(
        &self,
        method: Method,
        uri: Uri,
        headers: HeaderMap,
        body: Bytes,
    ) -> Response {
        match self.try_proxy_http(method, uri, headers, body).await {
            Ok(response) => response,
            Err(error) => {
                tracing::warn!(error = %format!("{error:#}"), "companion dev frontend proxy failed");
                (
                    StatusCode::BAD_GATEWAY,
                    format!("dev frontend proxy failed: {error}"),
                )
                    .into_response()
            }
        }
    }

    async fn try_proxy_http(
        &self,
        method: Method,
        uri: Uri,
        headers: HeaderMap,
        body: Bytes,
    ) -> Result<Response> {
        let upstream = self.upstream_http_url(&uri)?;
        let mut request = self.client.request(method, upstream);
        let mut forwarded = HeaderMap::new();
        for (name, value) in &headers {
            if should_forward_request_header(name) {
                forwarded.append(name.clone(), value.clone());
            }
        }
        request = request.headers(forwarded);
        if !body.is_empty() {
            request = request.body(body.to_vec());
        }

        let upstream_response = request.send().await?;
        let status = upstream_response.status();
        let is_html = upstream_response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/html"));
        let response_headers = upstream_response.headers().clone();
        let mut bytes = upstream_response.bytes().await?.to_vec();
        if is_html {
            bytes = inject_companion_marker(bytes);
        }

        let mut builder = Response::builder().status(status);
        let Some(headers_mut) = builder.headers_mut() else {
            return Err(anyhow!("failed to build proxy response"));
        };
        copy_response_headers(&response_headers, headers_mut, is_html);
        if is_html {
            headers_mut.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        }
        builder
            .body(Body::from(bytes))
            .map_err(|error| anyhow!("failed to build proxy response: {error}"))
    }

    pub fn proxy_websocket_response(
        self,
        ws: axum::extract::ws::WebSocketUpgrade,
        uri: Uri,
        requested_protocol: Option<String>,
    ) -> Response {
        ws.protocols(["vite-hmr", "vite-ping"])
            .on_upgrade(move |socket| async move {
                if let Err(error) = self.proxy_websocket(socket, uri, requested_protocol).await {
                    tracing::warn!(
                        error = %format!("{error:#}"),
                        "companion dev websocket proxy failed",
                    );
                }
            })
    }

    async fn proxy_websocket(
        &self,
        client_socket: WebSocket,
        uri: Uri,
        requested_protocol: Option<String>,
    ) -> Result<()> {
        let upstream = self.upstream_ws_url(&uri)?;
        let mut request = upstream.into_client_request()?;
        if let Some(protocol) = requested_protocol {
            request.headers_mut().insert(
                SEC_WEBSOCKET_PROTOCOL,
                HeaderValue::from_str(&protocol)
                    .map_err(|error| anyhow!("invalid websocket protocol header: {error}"))?,
            );
        }

        let (upstream_socket, _) = connect_async(request).await?;
        let (mut client_sender, mut client_receiver) = client_socket.split();
        let (mut upstream_sender, mut upstream_receiver) = upstream_socket.split();

        let client_to_upstream = async {
            while let Some(message) = client_receiver.next().await {
                let message = message?;
                let should_close = matches!(message, AxumMessage::Close(_));
                upstream_sender.send(to_tungstenite(message)).await?;
                if should_close {
                    break;
                }
            }
            Ok::<(), anyhow::Error>(())
        };

        let upstream_to_client = async {
            while let Some(message) = upstream_receiver.next().await {
                let Some(message) = to_axum(message?) else {
                    continue;
                };
                let should_close = matches!(message, AxumMessage::Close(_));
                client_sender.send(message).await?;
                if should_close {
                    break;
                }
            }
            Ok::<(), anyhow::Error>(())
        };

        tokio::select! {
            result = client_to_upstream => result?,
            result = upstream_to_client => result?,
        }
        Ok(())
    }

    fn upstream_http_url(&self, uri: &Uri) -> Result<Url> {
        let suffix = uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/");
        self.origin
            .join(suffix.trim_start_matches('/'))
            .map_err(|error| anyhow!("invalid upstream URL: {error}"))
    }

    fn upstream_ws_url(&self, uri: &Uri) -> Result<String> {
        let mut url = self.upstream_http_url(uri)?;
        let scheme = match url.scheme() {
            "http" => "ws",
            "https" => "wss",
            other => return Err(anyhow!("unsupported dev frontend scheme: {other}")),
        };
        url.set_scheme(scheme)
            .map_err(|_| anyhow!("failed to set websocket scheme"))?;
        Ok(url.to_string())
    }
}

fn should_forward_request_header(name: &HeaderName) -> bool {
    !is_header(
        name,
        &[
            &HOST,
            &CONNECTION,
            &KEEP_ALIVE,
            &PROXY_AUTHENTICATE,
            &PROXY_AUTHORIZATION,
            &TE,
            &TRAILER,
            &TRANSFER_ENCODING,
            &UPGRADE,
            &COOKIE,
            &AUTHORIZATION,
            &ORIGIN,
            &CONTENT_LENGTH,
        ],
    )
}

fn should_forward_response_header(name: &HeaderName, is_html: bool) -> bool {
    if is_html && (name == CONTENT_LENGTH || name == CONTENT_ENCODING) {
        return false;
    }
    !is_header(
        name,
        &[
            &CONNECTION,
            &KEEP_ALIVE,
            &PROXY_AUTHENTICATE,
            &PROXY_AUTHORIZATION,
            &TE,
            &TRAILER,
            &TRANSFER_ENCODING,
            &UPGRADE,
            &CONTENT_LENGTH,
        ],
    )
}

fn copy_response_headers(source: &HeaderMap, target: &mut HeaderMap, is_html: bool) {
    for (name, value) in source {
        if should_forward_response_header(name, is_html) {
            target.append(name.clone(), value.clone());
        }
    }
}

fn to_tungstenite(message: AxumMessage) -> TungsteniteMessage {
    match message {
        AxumMessage::Text(text) => TungsteniteMessage::Text(text.as_str().to_owned().into()),
        AxumMessage::Binary(binary) => TungsteniteMessage::Binary(binary),
        AxumMessage::Ping(ping) => TungsteniteMessage::Ping(ping),
        AxumMessage::Pong(pong) => TungsteniteMessage::Pong(pong),
        AxumMessage::Close(Some(close)) => TungsteniteMessage::Close(Some(TungsteniteCloseFrame {
            code: TungsteniteCloseCode::from(close.code),
            reason: close.reason.as_str().to_owned().into(),
        })),
        AxumMessage::Close(None) => TungsteniteMessage::Close(None),
    }
}

fn to_axum(message: TungsteniteMessage) -> Option<AxumMessage> {
    match message {
        TungsteniteMessage::Text(text) => Some(AxumMessage::Text(text.to_string().into())),
        TungsteniteMessage::Binary(binary) => Some(AxumMessage::Binary(binary)),
        TungsteniteMessage::Ping(ping) => Some(AxumMessage::Ping(ping)),
        TungsteniteMessage::Pong(pong) => Some(AxumMessage::Pong(pong)),
        TungsteniteMessage::Close(Some(close)) => Some(AxumMessage::Close(Some(AxumCloseFrame {
            code: close.code.into(),
            reason: close.reason.to_string().into(),
        }))),
        TungsteniteMessage::Close(None) => Some(AxumMessage::Close(None)),
        TungsteniteMessage::Frame(_) => None,
    }
}

const KEEP_ALIVE: HeaderName = HeaderName::from_static("keep-alive");

fn is_header(name: &HeaderName, candidates: &[&HeaderName]) -> bool {
    candidates.contains(&name)
}

#[cfg(test)]
mod tests {
    use std::{
        net::SocketAddr,
        sync::{Arc, Mutex},
    };

    use axum::{
        extract::{ws::WebSocketUpgrade, State},
        http::{header::AUTHORIZATION, HeaderMap, Uri},
        response::{Html, Response},
        routing::get,
        Router,
    };
    use futures::FutureExt;
    use serde_json::Value;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::{
        client::IntoClientRequest, http::HeaderValue, Message as ClientMessage,
    };

    use super::*;
    use crate::{
        companion::server::{router, AppState, Dispatcher, EventStreamStarter, StreamStarter},
        error::CommandError,
    };

    type SeenHttpRequests = Arc<Mutex<Vec<(String, HeaderMap)>>>;
    type SeenWebSocketRequest = Arc<Mutex<Option<(String, Option<String>)>>>;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn http_proxy_injects_marker_and_strips_credentials() {
        let seen = Arc::new(Mutex::new(Vec::<(String, HeaderMap)>::new()));
        let upstream = spawn_router(fake_vite_http_router(seen.clone())).await;
        let companion = spawn_router(companion_router(upstream)).await;
        let client = reqwest::Client::new();

        let html = client
            .get(format!("http://{companion}/"))
            .header(AUTHORIZATION, "Bearer hlm_secret")
            .header(COOKIE, "helmor_companion_pat=hlm_secret")
            .header(ORIGIN, "https://remote-test.helmor.ai")
            .send()
            .await
            .expect("proxy html")
            .text()
            .await
            .expect("html body");
        assert!(html.contains("window.__HELMOR_COMPANION__={}"));
        assert!(html.contains("<script type=\"module\" src=\"/src/main.tsx\"></script>"));

        let module = client
            .get(format!("http://{companion}/src/main.tsx?import&v=1"))
            .send()
            .await
            .expect("proxy module")
            .text()
            .await
            .expect("module body");
        assert_eq!(module, "path=/src/main.tsx query=Some(\"import&v=1\")");

        {
            let seen = seen.lock().expect("seen headers");
            assert_eq!(seen.len(), 2);
            assert_eq!(seen[0].0, "/");
            assert!(!seen[0].1.contains_key(AUTHORIZATION));
            assert!(!seen[0].1.contains_key(COOKIE));
            assert!(!seen[0].1.contains_key(ORIGIN));
        }

        let rpc = client
            .post(format!("http://{companion}/rpc/list_workspace_groups"))
            .send()
            .await
            .expect("rpc request");
        assert_eq!(rpc.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn websocket_proxy_forwards_hmr_messages() {
        let seen = Arc::new(Mutex::new(None::<(String, Option<String>)>));
        let upstream = spawn_router(fake_vite_ws_router(seen.clone())).await;
        let companion = spawn_router(companion_router(upstream)).await;

        let mut request = format!("ws://{companion}/__vite_hmr?token=test")
            .into_client_request()
            .expect("client request");
        request
            .headers_mut()
            .insert(SEC_WEBSOCKET_PROTOCOL, HeaderValue::from_static("vite-hmr"));
        let (mut socket, response) = tokio_tungstenite::connect_async(request)
            .await
            .expect("connect websocket");

        assert_eq!(
            response.headers().get(SEC_WEBSOCKET_PROTOCOL),
            Some(&HeaderValue::from_static("vite-hmr")),
        );

        socket
            .send(ClientMessage::Text("hello".into()))
            .await
            .expect("send message");
        let received = socket
            .next()
            .await
            .expect("message available")
            .expect("message ok");
        assert_eq!(received, ClientMessage::Text("echo:hello".into()));

        let seen = seen.lock().expect("seen ws");
        let (path_and_query, protocol) = seen.as_ref().expect("upstream connected");
        assert_eq!(path_and_query, "/__vite_hmr?token=test");
        assert_eq!(protocol.as_deref(), Some("vite-hmr"));
    }

    async fn spawn_router(router: Router) -> SocketAddr {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind test router");
        let addr = listener.local_addr().expect("test router addr");
        tokio::spawn(async move {
            axum::serve(listener, router).await.expect("test router");
        });
        addr
    }

    fn companion_router(upstream: SocketAddr) -> Router {
        let streamer: StreamStarter = Arc::new(|_cmd, _args, _tx| Ok(()));
        let dispatcher: Dispatcher = Arc::new(|_cmd: String, _args: Value| {
            async move { Ok::<Value, CommandError>(Value::Null) }.boxed()
        });
        let event_starter: EventStreamStarter = Arc::new(|_tx, _watch| {});
        router(AppState {
            token: Arc::new("hlm_dev_token".to_string()),
            assets: Arc::new(|_| None),
            dev_frontend: Some(DevFrontendProxy::new(
                Url::parse(&format!("http://{upstream}/")).expect("upstream url"),
            )),
            streamer,
            dispatcher,
            verifier: Arc::new(|_| false),
            event_starter,
        })
    }

    fn fake_vite_http_router(seen: SeenHttpRequests) -> Router {
        async fn html(
            State(seen): State<SeenHttpRequests>,
            headers: HeaderMap,
        ) -> Html<&'static str> {
            seen.lock()
                .expect("seen headers")
                .push(("/".to_string(), headers));
            Html(
                r#"<html><head></head><body><script type="module" src="/src/main.tsx"></script></body></html>"#,
            )
        }

        async fn module(
            State(seen): State<SeenHttpRequests>,
            headers: HeaderMap,
            uri: Uri,
        ) -> String {
            seen.lock()
                .expect("seen headers")
                .push(("/src/main.tsx".to_string(), headers));
            format!("path={} query={:?}", uri.path(), uri.query())
        }

        Router::new()
            .route("/", get(html))
            .route("/src/main.tsx", get(module))
            .with_state(seen)
    }

    fn fake_vite_ws_router(seen: SeenWebSocketRequest) -> Router {
        async fn hmr(
            State(seen): State<SeenWebSocketRequest>,
            headers: HeaderMap,
            uri: Uri,
            ws: WebSocketUpgrade,
        ) -> Response {
            let protocol = headers
                .get(SEC_WEBSOCKET_PROTOCOL)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            *seen.lock().expect("seen ws") =
                Some((uri.path_and_query().unwrap().as_str().to_string(), protocol));
            ws.protocols(["vite-hmr"])
                .on_upgrade(|mut socket| async move {
                    if let Some(Ok(AxumMessage::Text(message))) = socket.recv().await {
                        socket
                            .send(AxumMessage::Text(format!("echo:{message}").into()))
                            .await
                            .expect("send echo");
                    }
                })
        }

        Router::new()
            .route("/__vite_hmr", get(hmr))
            .with_state(seen)
    }
}
