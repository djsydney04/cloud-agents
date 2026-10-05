use crate::{engine::Engine, model::NewJob};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

type ApiResult<T> = Result<T, ApiError>;
pub struct ApiError(StatusCode, String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    }
}
fn not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "Run not found".into())
}

async fn auth(State(e): State<Engine>, req: Request, next: Next) -> Response {
    let supplied = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    let a = Sha256::digest(supplied.as_bytes());
    let b = Sha256::digest(e.token.as_bytes());
    if !bool::from(a.ct_eq(&b)) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"Host token required"})),
        )
            .into_response();
    }
    next.run(req).await
}
async fn security(req: Request, next: Next) -> Response {
    let mut r = next.run(req).await;
    for (k, v) in [
        (
            "content-security-policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
        ),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("cache-control", "no-store"),
    ] {
        r.headers_mut().insert(
            header::HeaderName::from_static(k),
            header::HeaderValue::from_static(v),
        );
    }
    r
}
pub fn router(e: Engine) -> Router {
    let api = Router::new()
        .route("/host", get(host))
        .route("/jobs", get(list).post(create))
        .route("/jobs/{id}", get(detail).delete(delete))
        .route("/jobs/{id}/cancel", post(cancel))
        .route("/jobs/{id}/logs", get(logs))
        .route("/jobs/{id}/archive", get(archive))
        .route_layer(middleware::from_fn_with_state(e.clone(), auth));
    Router::new()
        .nest("/api", api)
        .route(
            "/",
            get(|| async { Html(include_str!("../ui/index.html")) }),
        )
        .route(
            "/app.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript")],
                    include_str!("../ui/app.js"),
                )
            }),
        )
        .route(
            "/style.css",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/css")],
                    include_str!("../ui/style.css"),
                )
            }),
        )
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(middleware::from_fn(security))
        .with_state(e)
}
async fn host(State(e): State<Engine>) -> Json<serde_json::Value> {
    let jobs = e.store.lock().unwrap().list().unwrap_or_default();
    let health = e.health.lock().unwrap().clone();
    Json(
        json!({"version":env!("CARGO_PKG_VERSION"),"name":std::env::var("HOSTNAME").unwrap_or_else(|_|"Your host".into()),"cpus":e.config.cpus,"memory_mb":e.config.memory_mb,"max_jobs":e.config.max_jobs,"active_jobs":jobs.iter().filter(|j|j.active()).count(),"used_cpus":jobs.iter().filter(|j|j.active()).map(|j|j.request.cpus).sum::<u32>(),"used_memory_mb":jobs.iter().filter(|j|j.active()).map(|j|j.request.memory_mb).sum::<u32>(),"health":health,"credentials":{"codex":e.has_credential(&crate::model::Provider::Codex),"claude":e.has_credential(&crate::model::Provider::Claude),"github":e.config.data_dir.join("credentials/github-token").exists()}}),
    )
}
async fn list(State(e): State<Engine>) -> ApiResult<Json<Vec<crate::model::Job>>> {
    Ok(Json(e.store.lock().unwrap().list()?))
}
async fn detail(
    State(e): State<Engine>,
    Path(id): Path<String>,
) -> ApiResult<Json<crate::model::Job>> {
    Ok(Json(
        e.store.lock().unwrap().get(&id).map_err(|_| not_found())?,
    ))
}
async fn create(State(e): State<Engine>, Json(r): Json<NewJob>) -> ApiResult<impl IntoResponse> {
    r.validate(e.config.cpus, e.config.memory_mb)
        .map_err(|v| ApiError(StatusCode::BAD_REQUEST, v.to_string()))?;
    if !e.has_credential(&r.provider) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Import provider credentials on the host first. See Settings → Credentials.".into(),
        ));
    }
    let s = e.store.lock().unwrap();
    if s.list()?.len() >= 1000 {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Run history is full (1000). Delete older runs to reclaim storage.".into(),
        ));
    }
    Ok((StatusCode::CREATED, Json(s.insert(r)?)))
}
async fn cancel(
    State(e): State<Engine>,
    Path(id): Path<String>,
) -> ApiResult<Json<crate::model::Job>> {
    let s = e.store.lock().unwrap();
    let mut j = s.get(&id).map_err(|_| not_found())?;
    if j.status == "queued" {
        j.status = "cancelled".into();
        j.finished_at = Some(crate::model::now());
    } else if j.active() {
        j.status = "cancelling".into();
    }
    s.save(&j)?;
    Ok(Json(j))
}
async fn logs(
    State(e): State<Engine>,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let j = e.store.lock().unwrap().get(&id).map_err(|_| not_found())?;
    let output = e.logs(&j).await.unwrap_or_else(|_| {
        j.error
            .clone()
            .unwrap_or_else(|| "Output is unavailable for this run.".into())
    });
    Ok(Json(json!({"output":output})))
}
async fn delete(State(e): State<Engine>, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let j = e.store.lock().unwrap().get(&id).map_err(|_| not_found())?;
    if j.active() || j.status == "queued" {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Cancel the run before deleting it".into(),
        ));
    }
    e.remove_container(&j).await?;
    let root = e.job_dir(&id);
    if root.exists() {
        std::fs::remove_dir_all(root).map_err(anyhow::Error::from)?;
    }
    e.store.lock().unwrap().delete(&id)?;
    Ok(StatusCode::NO_CONTENT)
}
async fn archive(State(e): State<Engine>, Path(id): Path<String>) -> ApiResult<Response> {
    let j = e.store.lock().unwrap().get(&id).map_err(|_| not_found())?;
    if j.active() || j.status == "queued" {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Wait for the run to stop before exporting".into(),
        ));
    }
    let dir = e.job_dir(&id).join("workspace");
    if !dir.is_dir() {
        return Err(not_found());
    }
    let mut child = tokio::process::Command::new("tar")
        .args(["-czf", "-", "-C"])
        .arg(dir)
        .arg(".")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(anyhow::Error::from)?;
    let stdout = child.stdout.take().unwrap();
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    Ok((
        [
            (header::CONTENT_TYPE, "application/gzip".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=cloud-agents-{id}.tar.gz"),
            ),
        ],
        axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(stdout)),
    )
        .into_response())
}
#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use clap::Parser;
    use tower::ServiceExt;
    #[derive(Parser)]
    struct Opt {
        #[command(flatten)]
        config: crate::config::Config,
    }
    fn setup() -> (tempfile::TempDir, Engine) {
        let d = tempfile::tempdir().unwrap();
        let mut c = Opt::parse_from(["t", "--data-dir", d.path().to_str().unwrap()]).config;
        c.init().unwrap();
        let e = Engine::new(c).unwrap();
        (d, e)
    }
    #[tokio::test]
    async fn requires_auth_and_enforces_validation() {
        let (_d, e) = setup();
        let app = router(e.clone());
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/jobs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 401);
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/jobs")
                    .method("POST")
                    .header("authorization", format!("Bearer {}", e.token))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"provider":"smoke","prompt":"test","repository":"file:///etc"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 400);
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/jobs")
                    .method("POST")
                    .header("authorization", format!("Bearer {}", e.token))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"provider":"smoke","prompt":"test"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), 201);
        let j: crate::model::Job =
            serde_json::from_slice(&to_bytes(res.into_body(), 10000).await.unwrap()).unwrap();
        assert_eq!(j.status, "queued");
    }
    #[tokio::test]
    async fn cancellation_is_idempotent() {
        let (_d, e) = setup();
        let j = e
            .store
            .lock()
            .unwrap()
            .insert(serde_json::from_str(r#"{"provider":"smoke","prompt":"hi"}"#).unwrap())
            .unwrap();
        for _ in 0..2 {
            let Json(j) = cancel(State(e.clone()), Path(j.id.clone()))
                .await
                .unwrap_or_else(|_| panic!("cancel failed"));
            assert_eq!(j.status, "cancelled");
        }
    }
}
