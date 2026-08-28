use paperclip_runner_core::provider_bridge::{
    AuthorizedTool, AuthorizedToolSet, ProviderToolBridge, ToolResult, TOOL_SET_SCHEMA,
};
use serde_json::json;

fn tools(digest: &str) -> AuthorizedToolSet {
    AuthorizedToolSet {
        schema: TOOL_SET_SCHEMA.to_owned(),
        schema_version: 1,
        catalog_digest: digest.to_owned(),
        operations: vec![AuthorizedTool {
            operation_id: "get_task_context".to_owned(),
            version: 1,
            description: "Read the active task context.".to_owned(),
            input_schema: json!({"type": "object"}),
            response_schema: json!({"type": "object"}),
        }],
    }
}

fn digest(suffix: char) -> String {
    format!("sha256:{}", suffix.to_string().repeat(64))
}

#[test]
fn forwards_only_authorized_calls_and_correlates_results() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools(&digest('a'))).unwrap();
    let call = bridge
        .begin_call(
            "call-1".to_owned(),
            "get_task_context".to_owned(),
            json!({}),
        )
        .unwrap();
    assert_eq!(call.operation_id, "get_task_context");
    let value = bridge
        .apply_result(ToolResult {
            call_id: "call-1".to_owned(),
            operation_id: "get_task_context".to_owned(),
            result: json!({"ok": true}),
            is_error: false,
        })
        .unwrap();
    assert_eq!(value, json!({"ok": true}));
    assert_eq!(bridge.pending_calls().count(), 0);
}

#[test]
fn rejects_unknown_tools_and_conflicting_duplicate_results() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools(&digest('a'))).unwrap();
    assert!(bridge
        .begin_call("call-x".to_owned(), "not_authorized".to_owned(), json!({}))
        .is_err());
    bridge
        .begin_call(
            "call-1".to_owned(),
            "get_task_context".to_owned(),
            json!({}),
        )
        .unwrap();
    let result = ToolResult {
        call_id: "call-1".to_owned(),
        operation_id: "get_task_context".to_owned(),
        result: json!({"ok": true}),
        is_error: false,
    };
    bridge.apply_result(result.clone()).unwrap();
    bridge.apply_result(result).unwrap();
    assert!(bridge
        .apply_result(ToolResult {
            call_id: "call-1".to_owned(),
            operation_id: "get_task_context".to_owned(),
            result: json!({"ok": false}),
            is_error: false,
        })
        .is_err());
}

#[test]
fn durable_session_refuses_catalog_drift() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools(&digest('a'))).unwrap();
    assert!(bridge.prepare(tools(&digest('b'))).is_err());
    let encoded = serde_json::to_string(&bridge).unwrap();
    let recovered: ProviderToolBridge = serde_json::from_str(&encoded).unwrap();
    assert_eq!(recovered, bridge);
}

#[test]
fn validates_the_operation_value_inside_a_semantic_dispatch_envelope() {
    let mut set = tools("sha256:catalog-a");
    set.operations[0].response_schema = json!({
        "type": "object",
        "properties": { "value": { "type": "string" } },
        "required": ["value"],
        "additionalProperties": false
    });
    let mut bridge = ProviderToolBridge::default();
    set.catalog_digest = digest('a');
    bridge.prepare(set).unwrap();
    bridge
        .begin_call("call-1".into(), "get_task_context".into(), json!({}))
        .unwrap();
    bridge
        .apply_result(ToolResult {
            call_id: "call-1".into(),
            operation_id: "get_task_context".into(),
            result: json!({
                "ok": true,
                "operationId": "get_task_context",
                "callId": "call-1",
                "result": { "value": "accepted" },
                "stateRevision": 2
            }),
            is_error: false,
        })
        .unwrap();
    assert_eq!(bridge.pending_calls().count(), 0);
}

#[test]
fn rejects_noncanonical_digests_and_oversized_contract_values() {
    let mut bridge = ProviderToolBridge::default();
    assert!(bridge.prepare(tools("sha256:catalog-a")).is_err());

    let mut set = tools(&digest('a'));
    set.operations[0].description = "x".repeat(16 * 1024 + 1);
    assert!(bridge.prepare(set).is_err());

    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools(&digest('a'))).unwrap();
    assert!(bridge
        .begin_call(
            "call-large".into(),
            "get_task_context".into(),
            json!({ "value": "x".repeat(1024 * 1024) }),
        )
        .is_err());
}

#[test]
fn keeps_pending_calls_when_a_result_envelope_has_wrong_identity() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools(&digest('a'))).unwrap();
    bridge
        .begin_call("call-1".into(), "get_task_context".into(), json!({}))
        .unwrap();

    assert!(bridge
        .apply_result(ToolResult {
            call_id: "call-1".into(),
            operation_id: "get_task_context".into(),
            result: json!({
                "ok": false,
                "operationId": "get_task_context",
                "callId": "another-call",
                "error": { "message": "denied" }
            }),
            is_error: true,
        })
        .is_err());
    assert_eq!(bridge.pending_calls().count(), 1);
}
