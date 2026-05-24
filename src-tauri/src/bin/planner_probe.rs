//! Planner self-validation probe.
//!
//! Bypasses Tauri + WebRTC + rt. Sends a synthetic user transcript
//! through the same `voice_planner::run_turn` code path the live voice
//! agent uses, captures every `PlannerEvent` on a stub channel, and
//! prints a clean timeline. Use this to iterate on the planner system
//! prompt without speaking into a microphone — and to spot-check that
//! `say` + `final` cadence matches the target UX before users hear it.
//!
//! Make sure the helmor dev app has been launched at least once so the
//! settings DB exists at `~/helmor-dev/helmor.db`, and that your OpenAI
//! API key is configured under Settings → Voice.
//!
//! Usage:
//!
//! ```bash
//! cargo run --bin planner_probe -- "你能帮我看看最近的任务吗"
//! cargo run --bin planner_probe                 # runs the built-in scenarios
//! ```

use std::env;

use anyhow::{Context, Result};
use helmor_lib::voice_planner::{
    events::PlannerEvent, fabricate_turn_id, load_planner_api_key, run_turn,
    tools::StubPlannerTools, ManagedPlanner,
};
use tauri::ipc::{Channel, InvokeResponseBody};

#[tokio::main]
async fn main() -> Result<()> {
    // Install a tracing subscriber so `planner::stream` warns/info land
    // on stderr while the probe runs. Honors `RUST_LOG` if set; default
    // shows planner::* at info and everything else at warn.
    let env_filter = std::env::var("RUST_LOG").unwrap_or_else(|_| "warn,planner=info".to_string());
    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_target(true)
        .with_writer(std::io::stderr)
        .init();

    let args: Vec<String> = env::args().skip(1).collect();
    let scenarios: Vec<String> = if args.is_empty() {
        vec![
            "你能帮我介绍一下当前项目的 Rust 代码占比吗".to_string(),
            "什么是 Rust 的所有权？一句话讲完".to_string(),
            "讲个短笑话".to_string(),
            "1 加 1 等于几".to_string(),
        ]
    } else {
        args.into_iter().filter(|a| !a.trim().is_empty()).collect()
    };

    // The probe uses a stub dispatcher — any Helmor tool call from the
    // planner returns an error envelope. This isolates prompt /
    // cadence behavior from live tool execution. To exercise the full
    // agent loop, run the dev app and use voice mode.
    let planner_tools = StubPlannerTools;

    let planner = ManagedPlanner::new();

    let api_key = load_planner_api_key()
        .context("load OpenAI key — launch helmor once and set Settings → Voice → API key")?;

    for (idx, transcript) in scenarios.iter().enumerate() {
        println!("\n========================================");
        println!("Scenario {} : {transcript}", idx + 1);
        println!("========================================");

        let turn_id = fabricate_turn_id();
        let scenario_start = std::time::Instant::now();

        let channel: Channel<PlannerEvent> = Channel::new(move |body: InvokeResponseBody| {
            let raw = match &body {
                InvokeResponseBody::Json(s) => s.clone(),
                _ => panic!("unexpected non-JSON channel body"),
            };
            let event: PlannerEvent = serde_json::from_str(&raw)
                .unwrap_or_else(|e| panic!("malformed PlannerEvent JSON ({e}): {raw}"));
            let elapsed = scenario_start.elapsed().as_millis();
            match event {
                PlannerEvent::Started { turn_id } => {
                    println!("  [{elapsed:>5}ms] started        turn={turn_id}");
                }
                PlannerEvent::Say { text, .. } => {
                    println!("  [{elapsed:>5}ms] say            {text}");
                }
                PlannerEvent::Final { text, .. } => {
                    println!("  [{elapsed:>5}ms] final          {text}");
                }
                PlannerEvent::Status { note, .. } => {
                    println!("  [{elapsed:>5}ms] status         {note}");
                }
                PlannerEvent::Error { message, .. } => {
                    println!("  [{elapsed:>5}ms] ERROR          {message}");
                }
                PlannerEvent::Done { .. } => {
                    println!("  [{elapsed:>5}ms] done");
                }
                PlannerEvent::ToolCallStarted {
                    name, args_preview, ..
                } => {
                    println!("  [{elapsed:>5}ms] tool ▶         {name}({args_preview})");
                }
                PlannerEvent::ToolCallCompleted {
                    name,
                    ok,
                    duration_ms,
                    result_preview,
                    ..
                } => {
                    let badge = if ok { "✓" } else { "✗" };
                    println!(
                        "  [{elapsed:>5}ms] tool {badge}        {name} ({duration_ms}ms) → {result_preview}"
                    );
                }
                PlannerEvent::Invalidate { kinds, .. } => {
                    println!("  [{elapsed:>5}ms] invalidate     {kinds:?}");
                }
                PlannerEvent::NavigateToWorkspace { workspace_id, .. } => {
                    println!("  [{elapsed:>5}ms] navigate       workspace={workspace_id}");
                }
                PlannerEvent::EndSession { .. } => {
                    println!("  [{elapsed:>5}ms] end-session    (dispatcher will tear down)");
                }
                PlannerEvent::CaptureImage {
                    width,
                    height,
                    caption,
                    ..
                } => {
                    println!("  [{elapsed:>5}ms] capture-image  {width}x{height} ({caption})");
                }
            }
            Ok(())
        });

        if let Err(e) = run_turn(
            &planner_tools,
            &planner,
            api_key.clone(),
            turn_id.clone(),
            transcript.clone(),
            channel,
        )
        .await
        {
            eprintln!("  run_turn failed: {e:#}");
        }
        println!(
            "  (total elapsed: {:.2}s)",
            scenario_start.elapsed().as_secs_f32()
        );
    }

    Ok(())
}
