use std::{
    collections::{HashMap, HashSet},
    net::{IpAddr, Ipv6Addr, SocketAddr},
    time::Duration,
};

use base64::{Engine, engine::general_purpose::STANDARD};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full};
use hyper::{Request, body::Incoming, client::conn::http1};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};
use tokio_tungstenite::{
    WebSocketStream, client_async,
    tungstenite::{Message, client::IntoClientRequest},
};
use url::Url;

const MAX_MESSAGE: usize = 1024 * 1024;
const MAX_BODY: usize = 16 * 1024 * 1024;
const MAX_FRAME: usize = 1024 * 1024;
const ALLOWED_METHODS: [&str; 6] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const ALLOWED_HEADERS: [&str; 13] = [
    "accept",
    "authorization",
    "content-type",
    "git-protocol",
    "range",
    "if-range",
    "if-match",
    "if-none-match",
    "if-modified-since",
    "if-unmodified-since",
    "last-event-id",
    "x-flightdeck-pg-app-npub",
    "x-request-id",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    id: String,
    method: String,
    context: Context,
    #[serde(default)]
    params: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Context {
    document_id: String,
    origin: String,
}

#[derive(Serialize)]
struct Reply<'a> {
    id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ProtocolError>,
}

#[derive(Serialize)]
struct ProtocolError {
    code: &'static str,
    message: String,
}

#[derive(Clone)]
struct Grant {
    document: String,
    endpoint: String,
    _peer_npub: String,
    _purpose: String,
    address: SocketAddr,
}

struct PendingRequest {
    document: String,
    grant_id: String,
    url: Url,
    method: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}
struct ActiveResponse {
    document: String,
    grant_id: String,
    body: Incoming,
}
struct ActiveSocket {
    document: String,
    grant_id: String,
    socket: WebSocketStream<TcpStream>,
}

#[derive(Default)]
struct Host {
    sequence: u64,
    grants: HashMap<String, Grant>,
    documents: HashMap<String, HashSet<String>>,
    pending: HashMap<String, PendingRequest>,
    responses: HashMap<String, ActiveResponse>,
    sockets: HashMap<String, ActiveSocket>,
}

impl Host {
    fn capability(&mut self, prefix: &str) -> String {
        self.sequence += 1;
        format!("{prefix}-{}-{}", std::process::id(), self.sequence)
    }

    async fn dispatch(&mut self, request: &Envelope) -> Result<Value, String> {
        if !request.context.origin.starts_with("https://") {
            return Err("Only HTTPS page origins are permitted".into());
        }
        match request.method.as_str() {
            "grant.connect" => self.connect(request),
            "grant.disconnect" => self.disconnect_grant(request),
            "document.disconnect" => {
                self.disconnect_document(&request.context.document_id);
                Ok(Value::Null)
            }
            "request.open" => self.open_request(request),
            "request.write" => self.write_request(request),
            "request.finish" => self.finish_request(request).await,
            "request.pull" => self.pull_request(request).await,
            "request.cancel" => {
                self.cancel_request(request);
                Ok(Value::Null)
            }
            "socket.open" => self.open_socket(request).await,
            "socket.send" => self.send_socket(request).await,
            "socket.next" => self.next_socket(request).await,
            "socket.close" => {
                self.close_socket(request).await;
                Ok(Value::Null)
            }
            _ => Err("Unknown operation".into()),
        }
    }

    fn connect(&mut self, request: &Envelope) -> Result<Value, String> {
        let endpoint = string_param(&request.params, "endpoint")?;
        let supplied_peer = string_param(&request.params, "peerNpub")?;
        let purpose = string_param(&request.params, "purpose")?;
        if !["service", "tower", "autopilot", "git", "drive"].contains(&purpose.as_str()) {
            return Err("Unsupported purpose".into());
        }
        let (canonical, peer, address) = validate_endpoint(&endpoint)?;
        if supplied_peer.to_lowercase() != peer {
            return Err("Pinned peer does not match endpoint".into());
        }
        let document_grants = self
            .documents
            .entry(request.context.document_id.clone())
            .or_default();
        if document_grants.len() >= 8 {
            return Err("Grant limit reached".into());
        }
        self.sequence += 1;
        let grant_id = format!("grant-{}-{}", std::process::id(), self.sequence);
        document_grants.insert(grant_id.clone());
        self.grants.insert(
            grant_id.clone(),
            Grant {
                document: request.context.document_id.clone(),
                endpoint: canonical.clone(),
                _peer_npub: peer.clone(),
                _purpose: purpose.clone(),
                address,
            },
        );
        Ok(
            json!({"version":2,"grantId":grant_id,"endpoint":canonical,"peerNpub":peer,"purpose":purpose}),
        )
    }

    fn disconnect_grant(&mut self, request: &Envelope) -> Result<Value, String> {
        let id = string_param(&request.params, "grantId")?;
        self.assert_grant(&request.context.document_id, &id)?;
        self.remove_grant(&id);
        Ok(Value::Null)
    }

    fn disconnect_document(&mut self, document: &str) {
        let ids: Vec<_> = self
            .documents
            .remove(document)
            .unwrap_or_default()
            .into_iter()
            .collect();
        for id in ids {
            self.remove_grant(&id);
        }
    }

    fn remove_grant(&mut self, id: &str) {
        if let Some(grant) = self.grants.remove(id)
            && let Some(set) = self.documents.get_mut(&grant.document)
        {
            set.remove(id);
        }
        self.pending.retain(|_, value| value.grant_id != id);
        self.responses.retain(|_, value| value.grant_id != id);
        self.sockets.retain(|_, value| value.grant_id != id);
    }

    fn assert_grant(&self, document: &str, id: &str) -> Result<&Grant, String> {
        self.grants
            .get(id)
            .filter(|grant| grant.document == document)
            .ok_or_else(|| "Unknown or foreign grant".into())
    }

    fn open_request(&mut self, request: &Envelope) -> Result<Value, String> {
        if self.pending.len() + self.responses.len() + self.sockets.len() >= 32 {
            return Err("Resource limit reached".into());
        }
        let grant_id = string_param(&request.params, "grantId")?;
        let grant = self.assert_grant(&request.context.document_id, &grant_id)?;
        let url = validate_target(grant, &string_param(&request.params, "url")?, false)?;
        let method = string_param(&request.params, "method")?.to_uppercase();
        if !ALLOWED_METHODS.contains(&method.as_str()) {
            return Err("Method not allowed".into());
        }
        let headers = request
            .params
            .get("headers")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter_map(|(name, value)| {
                let lower = name.to_lowercase();
                (ALLOWED_HEADERS.contains(&lower.as_str()))
                    .then(|| (lower, value.as_str().unwrap_or_default().to_string()))
            })
            .collect();
        let id = self.capability("request");
        self.pending.insert(
            id.clone(),
            PendingRequest {
                document: request.context.document_id.clone(),
                grant_id,
                url,
                method,
                headers,
                body: vec![],
            },
        );
        Ok(Value::String(id))
    }

    fn write_request(&mut self, request: &Envelope) -> Result<Value, String> {
        let id = string_param(&request.params, "requestId")?;
        let chunk = STANDARD
            .decode(string_param(&request.params, "chunk")?)
            .map_err(|_| "Invalid base64 body")?;
        if chunk.len() > 65536 {
            return Err("Upload chunk too large".into());
        }
        let state = self
            .pending
            .get_mut(&id)
            .filter(|state| state.document == request.context.document_id)
            .ok_or("Unknown request")?;
        if state.body.len() + chunk.len() > MAX_BODY {
            return Err("Upload body limit reached".into());
        }
        state.body.extend_from_slice(&chunk);
        Ok(Value::Null)
    }

    async fn finish_request(&mut self, request: &Envelope) -> Result<Value, String> {
        let id = string_param(&request.params, "requestId")?;
        let state = self
            .pending
            .remove(&id)
            .filter(|state| state.document == request.context.document_id)
            .ok_or("Unknown request")?;
        let grant = self.assert_grant(&state.document, &state.grant_id)?.clone();
        let stream = direct_connect(grant.address).await?;
        let (mut sender, connection) = http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|error| format!("HTTP handshake failed: {error}"))?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let path = match state.url.query() {
            Some(query) => format!("{}?{}", state.url.path(), query),
            None => state.url.path().to_string(),
        };
        let mut builder = Request::builder()
            .method(state.method.as_str())
            .uri(path)
            .header("host", state.url.authority());
        for (name, value) in state.headers {
            builder = builder.header(name, value);
        }
        let outgoing = builder
            .body(Full::new(Bytes::from(state.body)))
            .map_err(|error| format!("Invalid request: {error}"))?;
        let response = timeout(Duration::from_secs(30), sender.send_request(outgoing))
            .await
            .map_err(|_| "HTTP response timed out")?
            .map_err(|error| format!("HTTP request failed: {error}"))?;
        if (300..400).contains(&response.status().as_u16()) && response.status().as_u16() != 304 {
            return Err("Redirects forbidden".into());
        }
        let status = response.status().as_u16();
        let headers: HashMap<String, String> = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                let lower = name.as_str();
                (![
                    "set-cookie",
                    "set-cookie2",
                    "connection",
                    "transfer-encoding",
                    "location",
                ]
                .contains(&lower))
                .then(|| {
                    (
                        lower.to_string(),
                        value.to_str().unwrap_or_default().to_string(),
                    )
                })
            })
            .collect();
        self.responses.insert(
            id,
            ActiveResponse {
                document: state.document,
                grant_id: state.grant_id,
                body: response.into_body(),
            },
        );
        Ok(json!({"status":status,"headers":headers}))
    }

    async fn pull_request(&mut self, request: &Envelope) -> Result<Value, String> {
        let id = string_param(&request.params, "requestId")?;
        let state = self
            .responses
            .get_mut(&id)
            .filter(|state| state.document == request.context.document_id)
            .ok_or("Unknown response")?;
        loop {
            match timeout(Duration::from_millis(100), state.body.frame()).await {
                Err(_) => return Ok(json!({"idle":true})),
                Ok(frame) => match frame {
                    Some(Ok(frame)) => {
                        if let Ok(data) = frame.into_data() {
                            return Ok(json!({"done":false,"chunk":STANDARD.encode(data)}));
                        }
                    }
                    Some(Err(error)) => {
                        self.responses.remove(&id);
                        return Err(format!("Response stream failed: {error}"));
                    }
                    None => {
                        self.responses.remove(&id);
                        return Ok(json!({"done":true}));
                    }
                },
            }
        }
    }

    fn cancel_request(&mut self, request: &Envelope) {
        if let Ok(id) = string_param(&request.params, "requestId") {
            if self
                .pending
                .get(&id)
                .is_some_and(|state| state.document == request.context.document_id)
            {
                self.pending.remove(&id);
            }
            if self
                .responses
                .get(&id)
                .is_some_and(|state| state.document == request.context.document_id)
            {
                self.responses.remove(&id);
            }
        }
    }

    async fn open_socket(&mut self, request: &Envelope) -> Result<Value, String> {
        let grant_id = string_param(&request.params, "grantId")?;
        let grant = self
            .assert_grant(&request.context.document_id, &grant_id)?
            .clone();
        let url = validate_target(&grant, &string_param(&request.params, "url")?, true)?;
        let stream = direct_connect(grant.address).await?;
        let websocket_request = url
            .as_str()
            .into_client_request()
            .map_err(|error| format!("Invalid WebSocket: {error}"))?;
        let (socket, response) = timeout(
            Duration::from_secs(15),
            client_async(websocket_request, stream),
        )
        .await
        .map_err(|_| "WebSocket timed out")?
        .map_err(|error| format!("WebSocket failed: {error}"))?;
        if response.status().as_u16() != 101 {
            return Err("WebSocket upgrade rejected".into());
        }
        let id = self.capability("socket");
        self.sockets.insert(
            id.clone(),
            ActiveSocket {
                document: request.context.document_id.clone(),
                grant_id,
                socket,
            },
        );
        Ok(Value::String(id))
    }

    async fn send_socket(&mut self, request: &Envelope) -> Result<Value, String> {
        let id = string_param(&request.params, "requestId")?;
        let text = request
            .params
            .get("text")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let data = string_param(&request.params, "data")?;
        let message = if text {
            if data.len() > MAX_FRAME {
                return Err("Frame too large".into());
            }
            Message::Text(data.into())
        } else {
            let bytes = STANDARD
                .decode(data)
                .map_err(|_| "Invalid frame encoding")?;
            if bytes.len() > MAX_FRAME {
                return Err("Frame too large".into());
            }
            Message::Binary(bytes.into())
        };
        let state = self
            .sockets
            .get_mut(&id)
            .filter(|state| state.document == request.context.document_id)
            .ok_or("Unknown socket")?;
        state
            .socket
            .send(message)
            .await
            .map_err(|error| format!("WebSocket send failed: {error}"))?;
        Ok(Value::Null)
    }

    async fn next_socket(&mut self, request: &Envelope) -> Result<Value, String> {
        let id = string_param(&request.params, "requestId")?;
        let state = self
            .sockets
            .get_mut(&id)
            .filter(|state| state.document == request.context.document_id)
            .ok_or("Unknown socket")?;
        loop {
            match timeout(Duration::from_millis(100), state.socket.next()).await {
                Err(_) => return Ok(json!({"idle":true})),
                Ok(message) => match message {
                    Some(Ok(Message::Text(value))) => {
                        return Ok(json!({"done":false,"text":true,"data":value.as_str()}));
                    }
                    Some(Ok(Message::Binary(value))) => {
                        return Ok(
                            json!({"done":false,"text":false,"data":STANDARD.encode(value)}),
                        );
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let result = json!({"done":true,"code":frame.as_ref().map(|f| u16::from(f.code)).unwrap_or(1000),"reason":frame.as_ref().map(|f| f.reason.as_ref()).unwrap_or("")});
                        self.sockets.remove(&id);
                        return Ok(result);
                    }
                    Some(Ok(_)) => continue,
                    Some(Err(error)) => {
                        self.sockets.remove(&id);
                        return Err(format!("WebSocket receive failed: {error}"));
                    }
                    None => {
                        self.sockets.remove(&id);
                        return Ok(json!({"done":true,"code":1006,"reason":""}));
                    }
                },
            }
        }
    }

    async fn close_socket(&mut self, request: &Envelope) {
        if let Ok(id) = string_param(&request.params, "requestId")
            && let Some(mut state) = self
                .sockets
                .remove(&id)
                .filter(|state| state.document == request.context.document_id)
        {
            let _ = state.socket.close(None).await;
        }
    }
}

fn string_param(params: &Value, name: &str) -> Result<String, String> {
    params
        .get(name)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("Missing {name}"))
}

fn validate_endpoint(value: &str) -> Result<(String, String, SocketAddr), String> {
    if value
        .chars()
        .any(|character| character.is_control() || character.is_whitespace() || character == '\\')
    {
        return Err("Invalid endpoint".into());
    }
    let url = Url::parse(value).map_err(|_| "Invalid endpoint")?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Use an exact FIPS HTTP origin".into());
    }
    let host = url.host_str().ok_or("Missing FIPS host")?.to_lowercase();
    let peer = host
        .strip_suffix(".fips")
        .ok_or("FIPS host required")?
        .to_string();
    if !peer.starts_with("npub1") {
        return Err("FIPS npub required".into());
    }
    let port = url.port().ok_or("Explicit port required")?;
    let address = SocketAddr::new(IpAddr::V6(mesh_address(&peer)?), port);
    Ok((format!("http://{host}:{port}"), peer, address))
}

fn validate_target(grant: &Grant, value: &str, websocket: bool) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Invalid target URL")?;
    let endpoint = Url::parse(&grant.endpoint).map_err(|_| "Invalid grant")?;
    let expected_scheme = if websocket { "ws" } else { "http" };
    if url.scheme() != expected_scheme
        || url.host_str() != endpoint.host_str()
        || url.port() != endpoint.port()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Target is outside approved grant".into());
    }
    Ok(url)
}

fn mesh_address(npub: &str) -> Result<Ipv6Addr, String> {
    let (hrp, bytes) = bech32::decode(npub).map_err(|_| "Invalid npub")?;
    if hrp.as_str() != "npub" || bytes.len() != 32 {
        return Err("Invalid npub".into());
    }
    let digest = Sha256::digest(bytes);
    let mut address = [0u8; 16];
    address[0] = 0xfd;
    address[1..].copy_from_slice(&digest[..15]);
    Ok(Ipv6Addr::from(address))
}

async fn direct_connect(address: SocketAddr) -> Result<TcpStream, String> {
    timeout(Duration::from_secs(15), TcpStream::connect(address))
        .await
        .map_err(|_| "Direct FIPS connection timed out")?
        .map_err(|error| format!("Direct FIPS connection failed: {error}"))
}

async fn read_message() -> Result<Option<Vec<u8>>, String> {
    let mut stdin = tokio::io::stdin();
    let mut length = [0u8; 4];
    match stdin.read_exact(&mut length).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.to_string()),
    }
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_MESSAGE {
        return Err("Native message length rejected".into());
    }
    let mut data = vec![0; length];
    stdin
        .read_exact(&mut data)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Some(data))
}

async fn write_reply(reply: &Reply<'_>) -> Result<(), String> {
    let data = serde_json::to_vec(reply).map_err(|error| error.to_string())?;
    let mut stdout = tokio::io::stdout();
    stdout
        .write_all(&(data.len() as u32).to_le_bytes())
        .await
        .map_err(|error| error.to_string())?;
    stdout
        .write_all(&data)
        .await
        .map_err(|error| error.to_string())?;
    stdout.flush().await.map_err(|error| error.to_string())
}

#[tokio::main]
async fn main() {
    let mut host = Host::default();
    loop {
        let data = match read_message().await {
            Ok(Some(data)) => data,
            Ok(None) => break,
            Err(_) => break,
        };
        let request: Envelope = match serde_json::from_slice(&data) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let outcome = host.dispatch(&request).await;
        let reply = match outcome {
            Ok(result) => Reply {
                id: &request.id,
                result: Some(result),
                error: None,
            },
            Err(message) => Reply {
                id: &request.id,
                result: None,
                error: Some(ProtocolError {
                    code: "transport_error",
                    message,
                }),
            },
        };
        if write_reply(&reply).await.is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_npub() -> String {
        bech32::encode::<bech32::Bech32>(bech32::Hrp::parse("npub").unwrap(), &[0u8; 32]).unwrap()
    }
    #[test]
    fn endpoint_requires_exact_npub_origin() {
        assert!(validate_endpoint("https://npub1abc.fips:80").is_err());
        assert!(validate_endpoint("http://example.fips:80").is_err());
        assert!(validate_endpoint("http://npub1abc.fips").is_err());
    }
    #[test]
    fn known_npub_mesh_derivation_is_stable() {
        let npub = test_npub();
        assert_eq!(mesh_address(&npub).unwrap().octets()[0], 0xfd);
        assert_eq!(mesh_address(&npub).unwrap(), mesh_address(&npub).unwrap());
    }
    #[test]
    fn target_cannot_retarget_grant() {
        let npub = test_npub();
        let (_, peer, address) = validate_endpoint(&format!("http://{npub}.fips:8787")).unwrap();
        let grant = Grant {
            document: "d".into(),
            endpoint: format!("http://{peer}.fips:8787"),
            _peer_npub: peer,
            _purpose: "service".into(),
            address,
        };
        assert!(validate_target(&grant, "http://example.com:8787/", false).is_err());
        assert!(validate_target(&grant, &format!("{}/ok", grant.endpoint), false).is_ok());
    }
}
