use std::path::PathBuf;
use std::time::Duration;

use paperclip_runner_core::acpx_provider_session::{
    AcpxPermissionMode, AcpxProviderSession, AcpxProviderSessionConfig,
};
use paperclip_runner_core::acpx_provider_state::AcpxProviderStateEvent;
use paperclip_runner_core::acpx_sidecar_transport::AcpxSidecarTransportConfig;
use paperclip_runner_core::provider_bridge::{
    authorized_tool_catalog_digest, AuthorizedTool, AuthorizedToolSet,
};
use serde_json::json;

fn tool_set() -> AuthorizedToolSet {
    let operations = vec![AuthorizedTool {
        operation_id: "issues.read".to_owned(),
        version: 1,
        description: "Read an issue.".to_owned(),
        input_schema: json!({"type":"object"}),
        response_schema: json!({"type":"object"}),
    }];
    AuthorizedToolSet {
        schema: "paperclip.runner.authorized-tools.v1".to_owned(),
        schema_version: 1,
        catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
        operations,
    }
}

fn config(mode: &str) -> AcpxProviderSessionConfig {
    AcpxProviderSessionConfig {
        transport: AcpxSidecarTransportConfig {
            command: PathBuf::from(env!("CARGO_BIN_EXE_fake-acpx-sidecar")),
            args: vec!["--mode".to_owned(), mode.to_owned()],
            request_timeout: Duration::from_secs(1),
            shutdown_grace: Duration::from_millis(100),
        },
        agent: "codex".to_owned(),
        model: "gpt-5.6-sol".to_owned(),
        run_id: "run-1".to_owned(),
        catalog_revision: 1,
        runtime_directory: std::env::temp_dir(),
        normalized_session_id: "session-1".to_owned(),
        working_directory: std::env::temp_dir(),
        permission_mode: AcpxPermissionMode::ApproveReads,
        permission_mode_pinned: true,
        system_instructions: "Complete the supplied task.".to_owned(),
        tool_set: tool_set(),
        expected_identity: None,
    }
}

#[test]
fn starts_interrupts_and_settles_one_scoped_turn() {
    let mut session = AcpxProviderSession::start(&config("turns")).unwrap();
    assert!(session
        .poll_event(Duration::from_millis(1))
        .unwrap()
        .is_none());
    let response = session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    assert_eq!(response["turnId"], "turn-1");
    assert_eq!(session.state().active_turn_id(), Some("turn-1"));

    let activity = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        &activity[0],
        AcpxProviderStateEvent::Activity(event)
            if event.event_type == "item.delta" && event.payload["text"] == "hello"
    ));
    session
        .interrupt_turn("turn-1", "Paperclip interruption")
        .unwrap();
    assert_eq!(session.state().active_turn_id(), Some("turn-1"));
    let terminal = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        terminal.last().unwrap(),
        AcpxProviderStateEvent::TurnTerminal { turn_id, .. } if turn_id == "turn-1"
    ));
    assert_eq!(session.state().active_turn_id(), None);
    session.shutdown("test complete").unwrap();
}

#[test]
fn rejects_invalid_turn_inputs_without_mutating_the_session() {
    let mut session = AcpxProviderSession::start(&config("turns")).unwrap();
    let other_directory = std::env::current_dir().unwrap();
    assert!(session
        .start_turn("turn-1", "Please help", &other_directory)
        .unwrap_err()
        .to_string()
        .contains("immutable session workspace"));
    assert!(session
        .start_turn("turn-1", "bad\0message", &std::env::temp_dir())
        .unwrap_err()
        .to_string()
        .contains("bounded contract"));
    assert_eq!(session.state().active_turn_id(), None);
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    session.shutdown("test complete").unwrap();
}

#[test]
fn fails_closed_when_turn_start_acknowledges_another_turn() {
    let mut session = AcpxProviderSession::start(&config("turns-wrong-turn")).unwrap();
    let error = session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap_err()
        .to_string();
    assert!(error.contains("confirm the requested turn"), "{error}");
    assert!(session.shutdown("already closed").is_ok());
}

#[test]
fn fails_closed_when_cancellation_is_not_confirmed() {
    let mut session = AcpxProviderSession::start(&config("turns-wrong-cancel")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    let error = session
        .interrupt_turn("turn-1", "stop")
        .unwrap_err()
        .to_string();
    assert!(error.contains("confirm turn cancellation"), "{error}");
    assert!(session.shutdown("already closed").is_ok());
}

#[test]
fn fails_closed_when_a_polled_event_violates_run_scope() {
    let mut session = AcpxProviderSession::start(&config("turns-wrong-scope")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    let error = session
        .poll_event(Duration::from_secs(1))
        .unwrap_err()
        .to_string();
    assert!(error.contains("stale run"), "{error}");
    assert!(session.shutdown("already closed").is_ok());
}

#[test]
fn admits_only_catalog_authorized_tool_calls() {
    let mut session = AcpxProviderSession::start(&config("turns-tool")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    let events = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        &events[0],
        AcpxProviderStateEvent::ToolCall { operation_id, .. }
            if operation_id == "issues.read"
    ));
    assert_eq!(
        session.state().pending_tool("call-1").unwrap().operation_id,
        "issues.read"
    );
    session.shutdown("test complete").unwrap();
}

#[test]
fn fails_closed_before_returning_an_unauthorized_tool_call() {
    let mut session = AcpxProviderSession::start(&config("turns-unauthorized-tool")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    let error = session
        .poll_event(Duration::from_secs(1))
        .unwrap_err()
        .to_string();
    assert!(error.contains("unauthorized tool issues.delete"), "{error}");
    assert!(session.shutdown("already closed").is_ok());
}
