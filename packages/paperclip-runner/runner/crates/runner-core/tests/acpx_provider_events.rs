use paperclip_runner_core::acpx_event_payload::AcpxRuntimeEventKind;
use paperclip_runner_core::durable::EventPriority;
use paperclip_runner_core::provider_events::normalize_acpx_runtime_event;
use serde_json::json;

fn normalize(
    kind: AcpxRuntimeEventKind,
    payload: serde_json::Value,
) -> Vec<paperclip_runner_core::provider_events::NormalizedProviderEvent> {
    normalize_acpx_runtime_event(kind, &payload, "event-7", "turn-1", 3)
}

#[test]
fn maps_text_and_thinking_without_exposing_reasoning() {
    let text = normalize(
        AcpxRuntimeEventKind::TextDelta,
        json!({"type":"text_delta","messageId":"message-1","text":"Working"}),
    );
    assert_eq!(text[0].event_type, "item.delta");
    assert_eq!(text[0].payload["itemId"], "message-1");
    assert_eq!(text[0].payload["text"], "Working");
    assert_eq!(text[0].priority, EventPriority::P2);

    let thinking = normalize(
        AcpxRuntimeEventKind::Thinking,
        json!({"type":"thinking","text":"private chain of thought"}),
    );
    assert_eq!(thinking[0].event_type, "item.started");
    assert_eq!(thinking[0].payload["kind"], "reasoning");
    assert_eq!(thinking[0].payload["text"], serde_json::Value::Null);
    assert!(!thinking[0].payload.to_string().contains("private chain"));
}

#[test]
fn maps_bounded_plan_and_completion_state() {
    let events = normalize(
        AcpxRuntimeEventKind::Plan,
        json!({
            "type":"plan",
            "entries":[
                {"content":"Inspect", "status":"in_progress"},
                {"content":"Ship", "status":"completed"}
            ]
        }),
    );
    assert_eq!(events[0].event_type, "plan.updated");
    assert_eq!(events[0].payload["planId"], "turn-1");
    assert_eq!(events[0].payload["steps"][0]["status"], "in_progress");
    assert_eq!(events[0].payload["complete"], false);
    assert_eq!(events[0].priority, EventPriority::P1);
}

#[test]
fn maps_usage_and_review_status_but_ignores_inventory_updates() {
    let usage = normalize(
        AcpxRuntimeEventKind::Status,
        json!({
            "type":"status",
            "tag":"usage_update",
            "breakdown":{"inputTokens":12,"outputTokens":4,"cachedReadTokens":2},
            "cost":{"amount":0.25}
        }),
    );
    assert_eq!(usage[0].event_type, "usage.reported");
    assert_eq!(usage[0].payload["cumulative"]["inputTokens"], 12);
    assert_eq!(usage[0].payload["cumulative"]["requests"], 3);
    assert_eq!(usage[0].priority, EventPriority::P0);

    let review = normalize(
        AcpxRuntimeEventKind::Status,
        json!({"type":"status","tag":"current_mode_update","text":"review mode"}),
    );
    assert_eq!(review[0].event_type, "review.mode.changed");
    assert_eq!(review[0].payload["state"], "entered");

    assert!(normalize(
        AcpxRuntimeEventKind::Status,
        json!({"type":"status","tag":"available_commands_update"}),
    )
    .is_empty());
}

#[test]
fn maps_tool_lifecycle_and_rejects_unsafe_display_paths() {
    let started = normalize(
        AcpxRuntimeEventKind::ToolCall,
        json!({
            "type":"tool_call",
            "tag":"tool_call",
            "toolCallId":"tool-1",
            "kind":"read",
            "title":"Read file",
            "status":"pending",
            "locations":[{"path":"src/main.rs"}],
            "text":"Opening"
        }),
    );
    assert_eq!(started[0].event_type, "tool.execution.started");
    assert_eq!(started[0].payload["operation"], "read");
    assert_eq!(started[0].payload["target"], "src/main.rs");
    assert_eq!(started[0].payload["readOnly"], true);

    let completed = normalize(
        AcpxRuntimeEventKind::ToolCall,
        json!({
            "type":"tool_call",
            "tag":"tool_call_update",
            "toolCallId":"tool-1",
            "kind":"read",
            "status":"completed",
            "locations":[{"path":"../../secret"}],
            "rawOutput":"Authorization: Bearer top-secret"
        }),
    );
    assert_eq!(completed[0].event_type, "tool.execution.completed");
    assert_eq!(completed[0].payload["target"], serde_json::Value::Null);
    assert_eq!(completed[0].payload["outputTruncated"], true);
    assert!(!completed[0].payload.to_string().contains("top-secret"));

    let windows_absolute = normalize(
        AcpxRuntimeEventKind::ToolCall,
        json!({
            "type":"tool_call",
            "tag":"tool_call_update",
            "toolCallId":"tool-2",
            "kind":"read",
            "status":"completed",
            "locations":[{"path":"C:\\Users\\alice\\repo\\src\\main.rs"}]
        }),
    );
    assert_eq!(
        windows_absolute[0].payload["target"],
        serde_json::Value::Null
    );

    let windows_drive_relative = normalize(
        AcpxRuntimeEventKind::ToolCall,
        json!({
            "type":"tool_call",
            "tag":"tool_call_update",
            "toolCallId":"tool-3",
            "kind":"read",
            "status":"completed",
            "locations":[{"path":"C:Users\\alice\\repo\\src\\main.rs"}]
        }),
    );
    assert_eq!(
        windows_drive_relative[0].payload["target"],
        serde_json::Value::Null
    );
}

#[test]
fn maps_provider_notices_and_errors_with_stable_fields() {
    let notice = normalize(
        AcpxRuntimeEventKind::ProviderNotice,
        json!({
            "type":"provider_notice",
            "severity":"warning",
            "category":"rate limit",
            "summary":"Retrying"
        }),
    );
    assert_eq!(notice[0].event_type, "provider.notice.recorded");
    assert_eq!(notice[0].payload["severity"], "warning");
    assert_eq!(notice[0].payload["category"], "rate-limit");

    let error = normalize(
        AcpxRuntimeEventKind::Error,
        json!({"type":"error","code":"provider/failure","message":"Stopped"}),
    );
    assert_eq!(error[0].payload["severity"], "error");
    assert_eq!(error[0].payload["userActionable"], true);
    assert_eq!(error[0].priority, EventPriority::P0);
}

#[test]
fn leaves_operational_semantic_and_terminal_events_to_the_adapter() {
    assert!(normalize(
        AcpxRuntimeEventKind::SemanticResult,
        json!({"type":"semantic_result","callId":"call-1","result":{}}),
    )
    .is_empty());
    assert!(normalize(AcpxRuntimeEventKind::Done, json!({"type":"done"})).is_empty());
}
