use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const TOOL_SET_SCHEMA: &str = "paperclip.runner.authorized-tools.v1";
pub const TOOL_CALL_SCHEMA: &str = "paperclip.prp.semantic_tool.v1";
pub const TOOL_RESULT_COMMAND: &str = "semantic_tool.result";
const MAX_AUTHORIZED_TOOLS: usize = 256;
const MAX_DESCRIPTION_BYTES: usize = 16 * 1024;
const MAX_SCHEMA_BYTES: usize = 512 * 1024;
// Leave room for the authenticated PRP command or event envelope inside the
// default 1 MiB transport frame.
const MAX_TOOL_SET_BYTES: usize = 768 * 1024;
const MAX_TOOL_VALUE_BYTES: usize = 768 * 1024;
const MAX_ACCEPTED_TOOL_VALUE_BYTES: usize = 4 * 1024 * 1024;
const MAX_RETAINED_TOOL_VALUE_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_PENDING_CALLS: usize = 4_096;
const MAX_RETAINED_CALL_RECEIPTS: usize = 32_768;
const MAX_COMPACTED_CALL_RECEIPTS: usize = 4_096;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedTool {
    pub operation_id: String,
    pub version: u64,
    pub description: String,
    pub input_schema: Value,
    pub response_schema: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedToolSet {
    pub schema: String,
    pub schema_version: u64,
    pub catalog_digest: String,
    pub operations: Vec<AuthorizedTool>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingToolCall {
    pub call_id: String,
    pub operation_id: String,
    pub input: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub call_id: String,
    pub operation_id: String,
    pub result: Value,
    #[serde(default)]
    pub is_error: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CompletedToolCall {
    call: PendingToolCall,
    result: ToolResult,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct EvictedToolCall {
    operation_id: String,
    input_digest: String,
    result_digest: String,
    is_error: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderToolBridge {
    authorized: BTreeMap<String, AuthorizedTool>,
    #[serde(default)]
    catalog_operations: Vec<AuthorizedTool>,
    catalog_digest: Option<String>,
    pending: BTreeMap<String, PendingToolCall>,
    completed: BTreeMap<String, CompletedToolCall>,
    #[serde(default)]
    evicted: BTreeMap<String, EvictedToolCall>,
    #[serde(default)]
    compacted_receipts: BTreeSet<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderBridgeError(String);

impl ProviderBridgeError {
    fn invalid(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for ProviderBridgeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for ProviderBridgeError {}

impl ProviderToolBridge {
    pub fn prepare(&mut self, tool_set: AuthorizedToolSet) -> Result<(), ProviderBridgeError> {
        self.prepare_internal(tool_set, false)
    }

    pub fn attach_run(&mut self, tool_set: AuthorizedToolSet) -> Result<(), ProviderBridgeError> {
        if !self.pending.is_empty() {
            return Err(ProviderBridgeError::invalid(
                "cannot attach a new run while provider tool calls are pending",
            ));
        }
        self.prepare_internal(tool_set, true)?;
        self.completed.clear();
        self.evicted.clear();
        self.compacted_receipts.clear();
        Ok(())
    }

    pub fn attach_existing_run(&mut self) -> Result<(), ProviderBridgeError> {
        // Pending calls are durable run state. Re-attaching the same run must
        // preserve them so an interrupted dispatcher can resume or replay the
        // authoritative result. `attach_run` remains the boundary that rejects
        // carrying pending calls into a different run.
        self.validate_recovered()
    }

    fn prepare_internal(
        &mut self,
        tool_set: AuthorizedToolSet,
        allow_catalog_change: bool,
    ) -> Result<(), ProviderBridgeError> {
        if !self.pending.is_empty() {
            return Err(ProviderBridgeError::invalid(
                "cannot change authorized tools while provider calls are pending",
            ));
        }
        if tool_set.schema != TOOL_SET_SCHEMA || tool_set.schema_version != 1 {
            return Err(ProviderBridgeError::invalid(
                "unsupported authorized tool-set contract",
            ));
        }
        if !is_sha256_digest(&tool_set.catalog_digest) {
            return Err(ProviderBridgeError::invalid(
                "authorized tool set requires a canonical sha256 catalog digest",
            ));
        }
        if tool_set.operations.len() > MAX_AUTHORIZED_TOOLS {
            return Err(ProviderBridgeError::invalid(
                "authorized tool set exceeds the operation limit",
            ));
        }
        bounded_json(&tool_set, MAX_TOOL_SET_BYTES, "authorized tool set")?;
        let mut names = BTreeSet::new();
        for tool in &tool_set.operations {
            validate_operation_id(&tool.operation_id)?;
            if tool.version != 1 {
                return Err(ProviderBridgeError::invalid(format!(
                    "unsupported tool version for {}",
                    tool.operation_id
                )));
            }
            if tool.description.trim().is_empty()
                || tool.description.len() > MAX_DESCRIPTION_BYTES
                || tool.description.contains('\0')
                || !tool.input_schema.is_object()
                || !tool.response_schema.is_object()
            {
                return Err(ProviderBridgeError::invalid(format!(
                    "tool {} has an incomplete provider contract",
                    tool.operation_id
                )));
            }
            bounded_json(
                &tool.input_schema,
                MAX_SCHEMA_BYTES,
                "tool input JSON Schema",
            )?;
            bounded_json(
                &tool.response_schema,
                MAX_SCHEMA_BYTES,
                "tool response JSON Schema",
            )?;
            jsonschema::validator_for(&tool.input_schema).map_err(|_| {
                ProviderBridgeError::invalid(format!(
                    "tool {} has an invalid input JSON Schema",
                    tool.operation_id
                ))
            })?;
            jsonschema::validator_for(&tool.response_schema).map_err(|_| {
                ProviderBridgeError::invalid(format!(
                    "tool {} has an invalid response JSON Schema",
                    tool.operation_id
                ))
            })?;
            if !names.insert(tool.operation_id.clone()) {
                return Err(ProviderBridgeError::invalid(
                    "authorized tool names must be unique",
                ));
            }
        }
        let computed_digest = authorized_tool_catalog_digest(&tool_set.operations)?;
        if tool_set.catalog_digest != computed_digest {
            return Err(ProviderBridgeError::invalid(
                "authorized tool catalog digest does not match its operations",
            ));
        }
        if !allow_catalog_change {
            if let Some(existing) = &self.catalog_digest {
                if existing != &tool_set.catalog_digest {
                    return Err(ProviderBridgeError::invalid(
                        "authorized tool set changed across a durable session",
                    ));
                }
            }
        }
        self.catalog_digest = Some(tool_set.catalog_digest);
        self.catalog_operations = tool_set.operations.clone();
        self.authorized = tool_set
            .operations
            .into_iter()
            .map(|tool| (tool.operation_id.clone(), tool))
            .collect();
        Ok(())
    }

    pub fn authorized_tools(&self) -> impl Iterator<Item = &AuthorizedTool> {
        self.catalog_operations.iter()
    }

    pub fn validate_recovered(&self) -> Result<(), ProviderBridgeError> {
        let Some(catalog_digest) = self.catalog_digest.clone() else {
            return if self.authorized.is_empty()
                && self.catalog_operations.is_empty()
                && self.pending.is_empty()
                && self.completed.is_empty()
                && self.evicted.is_empty()
                && self.compacted_receipts.is_empty()
            {
                Ok(())
            } else {
                Err(ProviderBridgeError::invalid(
                    "recovered provider tool bridge omitted its catalog identity",
                ))
            };
        };
        let mut expected = ProviderToolBridge::default();
        expected.prepare(AuthorizedToolSet {
            schema: TOOL_SET_SCHEMA.to_owned(),
            schema_version: 1,
            catalog_digest,
            operations: self.catalog_operations.clone(),
        })?;
        if self.authorized != expected.authorized {
            return Err(ProviderBridgeError::invalid(
                "recovered provider tool bridge changed its authorized catalog",
            ));
        }
        if self.pending.len() > MAX_PENDING_CALLS
            || self
                .pending
                .len()
                .saturating_add(self.completed.len())
                .saturating_add(self.evicted.len())
                > MAX_RETAINED_CALL_RECEIPTS
        {
            return Err(ProviderBridgeError::invalid(
                "recovered provider tool bridge exceeds its call limit",
            ));
        }
        if self.compacted_receipts.len() > MAX_COMPACTED_CALL_RECEIPTS {
            return Err(ProviderBridgeError::invalid(
                "recovered provider tool bridge exceeds its compacted receipt limit",
            ));
        }
        self.validate_retained_value_bytes()?;
        let mut pending_validator = expected.clone();
        for (call_id, call) in &self.pending {
            if call_id != &call.call_id
                || self.completed.contains_key(call_id)
                || self.evicted.contains_key(call_id)
            {
                return Err(ProviderBridgeError::invalid(
                    "recovered provider tool call identity is inconsistent",
                ));
            }
            pending_validator.begin_call(
                call.call_id.clone(),
                call.operation_id.clone(),
                call.input.clone(),
            )?;
        }
        for (call_id, completed) in &self.completed {
            if call_id != &completed.call.call_id
                || call_id != &completed.result.call_id
                || completed.call.operation_id != completed.result.operation_id
                || self.evicted.contains_key(call_id)
            {
                return Err(ProviderBridgeError::invalid(
                    "recovered completed tool call identity is inconsistent",
                ));
            }
            let mut completed_validator = expected.clone();
            completed_validator.begin_call(
                completed.call.call_id.clone(),
                completed.call.operation_id.clone(),
                completed.call.input.clone(),
            )?;
            completed_validator.apply_result(completed.result.clone())?;
        }
        for (call_id, evicted) in &self.evicted {
            validate_stable_id(call_id, "evicted tool call id")?;
            validate_operation_id(&evicted.operation_id)?;
            if self.pending.contains_key(call_id)
                || self.completed.contains_key(call_id)
                || !is_sha256_digest(&evicted.input_digest)
                || !is_sha256_digest(&evicted.result_digest)
            {
                return Err(ProviderBridgeError::invalid(
                    "recovered evicted tool call identity is inconsistent",
                ));
            }
        }
        for call_id in &self.compacted_receipts {
            validate_stable_id(call_id, "compacted tool call id")?;
            if self.pending.contains_key(call_id)
                || self.completed.contains_key(call_id)
                || self.evicted.contains_key(call_id)
            {
                return Err(ProviderBridgeError::invalid(
                    "recovered compacted tool call identity is inconsistent",
                ));
            }
        }
        Ok(())
    }

    pub fn verify_tool_set(&self, tool_set: &AuthorizedToolSet) -> Result<(), ProviderBridgeError> {
        let mut expected = ProviderToolBridge::default();
        expected.prepare(tool_set.clone())?;
        if self.catalog_digest != expected.catalog_digest
            || self.catalog_operations != expected.catalog_operations
            || self.authorized != expected.authorized
        {
            return Err(ProviderBridgeError::invalid(
                "authorized tool set changed across a durable session",
            ));
        }
        Ok(())
    }

    pub fn has_catalog(&self) -> bool {
        self.catalog_digest.is_some()
    }

    pub fn replay_result(
        &self,
        call_id: &str,
        operation_id: &str,
        input: &Value,
    ) -> Result<Option<ToolResult>, ProviderBridgeError> {
        if let Some(completed) = self.completed.get(call_id) {
            if completed.call.operation_id != operation_id || &completed.call.input != input {
                return Err(ProviderBridgeError::invalid(
                    "provider replayed a completed tool call with different input",
                ));
            }
            return Ok(Some(completed.result.clone()));
        }
        let Some(evicted) = self.evicted.get(call_id) else {
            return if self.compacted_receipt_contains(call_id) {
                Ok(Some(evicted_replay_result(call_id, operation_id)))
            } else {
                Ok(None)
            };
        };
        if evicted.operation_id != operation_id
            || evicted.input_digest != semantic_value_digest(input)
        {
            return Err(ProviderBridgeError::invalid(
                "provider replayed an evicted tool call with different input",
            ));
        }
        Ok(Some(evicted_replay_result(call_id, operation_id)))
    }

    pub fn has_completed_call(&self, call_id: &str) -> bool {
        self.completed.contains_key(call_id)
            || self.evicted.contains_key(call_id)
            || self.compacted_receipt_contains(call_id)
    }

    pub fn begin_call(
        &mut self,
        call_id: String,
        operation_id: String,
        input: Value,
    ) -> Result<PendingToolCall, ProviderBridgeError> {
        validate_stable_id(&call_id, "tool call id")?;
        validate_operation_id(&operation_id)?;
        let authorized = self.authorized.get(&operation_id).ok_or_else(|| {
            ProviderBridgeError::invalid(format!(
                "provider requested unauthorized tool {operation_id}"
            ))
        })?;
        let validator = jsonschema::validator_for(&authorized.input_schema).map_err(|_| {
            ProviderBridgeError::invalid(format!(
                "tool {operation_id} has an invalid durable input JSON Schema"
            ))
        })?;
        if !validator.is_valid(&input) {
            return Err(ProviderBridgeError::invalid(format!(
                "provider arguments for {operation_id} failed JSON Schema validation"
            )));
        }
        bounded_json(&input, MAX_TOOL_VALUE_BYTES, "provider tool input")?;
        let call = PendingToolCall {
            call_id: call_id.clone(),
            operation_id,
            input,
        };
        if let Some(existing) = self.pending.get(&call_id) {
            return if existing == &call {
                Ok(existing.clone())
            } else {
                Err(ProviderBridgeError::invalid(
                    "conflicting duplicate provider tool call",
                ))
            };
        }
        if self.completed.contains_key(&call_id)
            || self.evicted.contains_key(&call_id)
            || self.compacted_receipt_contains(&call_id)
        {
            return Err(ProviderBridgeError::invalid(
                "provider reused a completed tool call id",
            ));
        }
        if self.pending.len() >= MAX_PENDING_CALLS {
            return Err(ProviderBridgeError::invalid(
                "concurrent provider tool call limit reached",
            ));
        }
        self.compact_receipts_to_fit()?;
        let input_bytes = json_size(&call.input, "provider tool input")?;
        let pending_bytes = self.pending_value_bytes()?;
        if pending_bytes
            .checked_add(input_bytes)
            .is_none_or(|total| total > MAX_ACCEPTED_TOOL_VALUE_BYTES)
        {
            return Err(ProviderBridgeError::invalid(
                "retained provider tool values exceed the 4 MiB acceptance limit",
            ));
        }
        let result_reserve = self
            .pending
            .len()
            .saturating_add(1)
            .checked_mul(MAX_TOOL_VALUE_BYTES)
            .ok_or_else(|| ProviderBridgeError::invalid("provider tool result reserve overflow"))?;
        if pending_bytes
            .checked_add(input_bytes)
            .and_then(|total| total.checked_add(result_reserve))
            .is_none_or(|total| total > MAX_RETAINED_TOOL_VALUE_BYTES)
        {
            return Err(ProviderBridgeError::invalid(
                "pending provider tool values exceed the aggregate result reserve",
            ));
        }
        self.evict_completed_to_fit(input_bytes.saturating_add(result_reserve))?;
        self.pending.insert(call_id, call.clone());
        Ok(call)
    }

    pub fn apply_result(&mut self, result: ToolResult) -> Result<Value, ProviderBridgeError> {
        validate_stable_id(&result.call_id, "tool result call id")?;
        validate_operation_id(&result.operation_id)?;
        bounded_json(&result.result, MAX_TOOL_VALUE_BYTES, "provider tool result")?;
        if let Some(existing) = self.completed.get(&result.call_id) {
            return if existing.result == result {
                Ok(existing.result.result.clone())
            } else {
                Err(ProviderBridgeError::invalid(
                    "conflicting duplicate tool result",
                ))
            };
        }
        if let Some(existing) = self.evicted.get(&result.call_id) {
            return if existing.operation_id == result.operation_id
                && existing.result_digest == semantic_value_digest(&result.result)
                && existing.is_error == result.is_error
            {
                Ok(result.result)
            } else {
                Err(ProviderBridgeError::invalid(
                    "conflicting duplicate evicted tool result",
                ))
            };
        }
        if self.compacted_receipt_contains(&result.call_id) {
            return Err(ProviderBridgeError::invalid(
                "duplicate tool result refers to a compacted durable receipt",
            ));
        }
        let pending = self.pending.get(&result.call_id).cloned().ok_or_else(|| {
            ProviderBridgeError::invalid("tool result does not match a pending provider call")
        })?;
        if pending.operation_id != result.operation_id {
            return Err(ProviderBridgeError::invalid(
                "tool result operation does not match its call",
            ));
        }
        let authorized = self.authorized.get(&result.operation_id).ok_or_else(|| {
            ProviderBridgeError::invalid("tool result operation is no longer authorized")
        })?;
        let validator = jsonschema::validator_for(&authorized.response_schema).map_err(|_| {
            ProviderBridgeError::invalid(format!(
                "tool {} has an invalid durable response JSON Schema",
                result.operation_id
            ))
        })?;
        let response = semantic_response_value(&result)?;
        if !result.is_error {
            // Paperclip semantic dispatchers return an authoritative envelope;
            // provider contracts describe the operation-specific value inside
            // `result`. Direct values remain valid for compatibility with v1
            // peers that do not wrap their semantic result.
            if let Some(response) = response {
                if !validator.is_valid(response) {
                    return Err(ProviderBridgeError::invalid(format!(
                        "tool result for {} failed JSON Schema validation",
                        result.operation_id
                    )));
                }
            }
        }
        let result_bytes = json_size(&result.result, "provider tool result")?;
        self.evict_completed_to_fit(result_bytes)?;
        let retained_bytes = self.retained_value_bytes()?;
        if retained_bytes
            .checked_add(result_bytes)
            .is_none_or(|total| total > MAX_RETAINED_TOOL_VALUE_BYTES)
        {
            return Err(ProviderBridgeError::invalid(
                "retained provider tool values exceed the 8 MiB aggregate limit",
            ));
        }
        self.pending.remove(&result.call_id);
        self.completed.insert(
            result.call_id.clone(),
            CompletedToolCall {
                call: pending,
                result: result.clone(),
            },
        );
        Ok(result.result)
    }

    pub fn pending_calls(&self) -> impl Iterator<Item = &PendingToolCall> {
        self.pending.values()
    }

    pub fn cancel_pending_calls(
        &mut self,
        code: &str,
    ) -> Result<Vec<ToolResult>, ProviderBridgeError> {
        let mut next = self.clone();
        let results = next.cancel_pending_calls_internal(code)?;
        *self = next;
        Ok(results)
    }

    pub fn settle_turn(&mut self, code: &str) -> Result<Vec<ToolResult>, ProviderBridgeError> {
        validate_stable_id(code, "tool cancellation code")?;
        let results = self
            .pending
            .values()
            .map(|call| cancelled_tool_result(call, code))
            .collect();
        let settled_call_ids = self
            .pending
            .keys()
            .chain(self.completed.keys())
            .chain(self.evicted.keys())
            .cloned()
            .collect::<Vec<_>>();
        // Exact results are turn-scoped, but their IDs remain in the bounded
        // durable filter for the lifetime of the run. A provider retry can
        // therefore never dispatch the same semantic action after settlement.
        for call_id in settled_call_ids {
            self.insert_compacted_receipt(&call_id);
        }
        self.pending.clear();
        self.completed.clear();
        self.evicted.clear();
        Ok(results)
    }

    fn cancel_pending_calls_internal(
        &mut self,
        code: &str,
    ) -> Result<Vec<ToolResult>, ProviderBridgeError> {
        validate_stable_id(code, "tool cancellation code")?;
        let pending = self.pending.values().cloned().collect::<Vec<_>>();
        let mut results = Vec::with_capacity(pending.len());
        for call in pending {
            let result = cancelled_tool_result(&call, code);
            self.apply_result(result.clone())?;
            results.push(result);
        }
        Ok(results)
    }

    fn retained_value_bytes(&self) -> Result<usize, ProviderBridgeError> {
        let pending = self
            .pending
            .values()
            .map(|call| json_size(&call.input, "retained provider tool input"));
        let completed = self.completed.values().flat_map(|entry| {
            [
                json_size(&entry.call.input, "retained provider tool input"),
                json_size(&entry.result.result, "retained provider tool result"),
            ]
        });
        pending.chain(completed).try_fold(0usize, |total, bytes| {
            total.checked_add(bytes?).ok_or_else(|| {
                ProviderBridgeError::invalid("retained provider tool values overflow")
            })
        })
    }

    fn pending_value_bytes(&self) -> Result<usize, ProviderBridgeError> {
        self.pending.values().try_fold(0usize, |total, call| {
            total
                .checked_add(json_size(&call.input, "retained provider tool input")?)
                .ok_or_else(|| {
                    ProviderBridgeError::invalid("retained provider tool values overflow")
                })
        })
    }

    fn evict_completed_to_fit(
        &mut self,
        additional_bytes: usize,
    ) -> Result<(), ProviderBridgeError> {
        loop {
            let retained_bytes = self.retained_value_bytes()?;
            if retained_bytes
                .checked_add(additional_bytes)
                .is_some_and(|total| total <= MAX_RETAINED_TOOL_VALUE_BYTES)
            {
                return Ok(());
            }
            let call_id = self.completed.keys().next().cloned().ok_or_else(|| {
                ProviderBridgeError::invalid(
                    "retained provider tool values exceed the 8 MiB aggregate limit",
                )
            })?;
            let completed = self
                .completed
                .remove(&call_id)
                .expect("selected completed provider tool call remains present");
            self.evicted.insert(
                call_id,
                EvictedToolCall {
                    operation_id: completed.call.operation_id,
                    input_digest: semantic_value_digest(&completed.call.input),
                    result_digest: semantic_value_digest(&completed.result.result),
                    is_error: completed.result.is_error,
                },
            );
        }
    }

    fn compact_receipts_to_fit(&mut self) -> Result<(), ProviderBridgeError> {
        while self
            .pending
            .len()
            .saturating_add(self.completed.len())
            .saturating_add(self.evicted.len())
            >= MAX_RETAINED_CALL_RECEIPTS
        {
            if self.compacted_receipts.len() >= MAX_COMPACTED_CALL_RECEIPTS {
                return Err(ProviderBridgeError::invalid(
                    "provider tool receipt capacity is exhausted for the active turn",
                ));
            }
            let call_id = self
                .evicted
                .keys()
                .next()
                .cloned()
                .or_else(|| self.completed.keys().next().cloned());
            let Some(call_id) = call_id else {
                break;
            };
            self.evicted.remove(&call_id);
            self.completed.remove(&call_id);
            self.compacted_receipts.insert(call_id);
        }
        Ok(())
    }

    fn compacted_receipt_contains(&self, call_id: &str) -> bool {
        self.compacted_receipts.contains(call_id)
    }

    fn validate_retained_value_bytes(&self) -> Result<(), ProviderBridgeError> {
        if self.retained_value_bytes()? > MAX_RETAINED_TOOL_VALUE_BYTES {
            return Err(ProviderBridgeError::invalid(
                "retained provider tool values exceed the 8 MiB aggregate limit",
            ));
        }
        Ok(())
    }
}

fn evicted_replay_result(call_id: &str, operation_id: &str) -> ToolResult {
    ToolResult {
        call_id: call_id.to_owned(),
        operation_id: operation_id.to_owned(),
        result: serde_json::json!({
            "error": {
                "code": "semantic_tool_replay_value_evicted",
                "message": "The exact prior tool result was evicted after its durable receipt was recorded",
                "retryable": false,
            },
        }),
        is_error: true,
    }
}

fn cancelled_tool_result(call: &PendingToolCall, code: &str) -> ToolResult {
    ToolResult {
        call_id: call.call_id.clone(),
        operation_id: call.operation_id.clone(),
        result: serde_json::json!({
            "error": {
                "code": code,
                "message": "The provider turn stopped before this semantic tool completed",
                "retryable": false,
            },
        }),
        is_error: true,
    }
}

pub fn authorized_tool_catalog_digest(
    operations: &[AuthorizedTool],
) -> Result<String, ProviderBridgeError> {
    let value = serde_json::to_value(operations)
        .map_err(|_| ProviderBridgeError::invalid("authorized tool catalog is not serializable"))?;
    let canonical = canonical_json(&value);
    let digest = Sha256::digest(canonical.as_bytes());
    Ok(format!("sha256:{digest:x}"))
}

pub fn semantic_value_digest(value: &Value) -> String {
    let digest = Sha256::digest(canonical_json(value).as_bytes());
    format!("sha256:{digest:x}")
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => canonical_json_number(value),
        Value::String(value) => {
            serde_json::to_string(value).expect("serializing an in-memory JSON string cannot fail")
        }
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key)
                            .expect("serializing an in-memory JSON key cannot fail"),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn canonical_json_number(value: &serde_json::Number) -> String {
    if value.is_i64() || value.is_u64() {
        return value.to_string();
    }
    let Some(float) = value.as_f64() else {
        return value.to_string();
    };
    if float == 0.0 {
        return "0".to_owned();
    }

    // serde_json preserves valid lexical spellings such as `1.0`, whereas
    // JSON.stringify canonicalizes JavaScript numbers. Normalize the shortest
    // serde representation to the ECMAScript decimal/exponent thresholds so
    // the server and runner hash the same schema value.
    let encoded = value.to_string().to_ascii_lowercase();
    let (negative, unsigned) = encoded
        .strip_prefix('-')
        .map_or((false, encoded.as_str()), |rest| (true, rest));
    let (coefficient, explicit_exponent) = unsigned
        .split_once('e')
        .map_or((unsigned, 0_i32), |(coefficient, exponent)| {
            (coefficient, exponent.parse::<i32>().unwrap_or(0))
        });
    let fraction_digits = coefficient
        .split_once('.')
        .map_or(0_i32, |(_, fraction)| fraction.len() as i32);
    let mut digits = coefficient
        .bytes()
        .filter(|byte| *byte != b'.')
        .map(char::from)
        .collect::<String>();
    let mut decimal_position = digits.len() as i32 + explicit_exponent - fraction_digits;

    let leading_zeros = digits.bytes().take_while(|byte| *byte == b'0').count();
    digits.drain(..leading_zeros);
    decimal_position -= leading_zeros as i32;
    while digits.ends_with('0') {
        digits.pop();
    }
    if digits.is_empty() {
        return "0".to_owned();
    }

    let body = if (1e-6..1e21).contains(&float.abs()) {
        if decimal_position <= 0 {
            format!("0.{}{}", "0".repeat((-decimal_position) as usize), digits)
        } else if decimal_position >= digits.len() as i32 {
            format!(
                "{}{}",
                digits,
                "0".repeat((decimal_position - digits.len() as i32) as usize)
            )
        } else {
            let split = decimal_position as usize;
            format!("{}.{}", &digits[..split], &digits[split..])
        }
    } else {
        let exponent = decimal_position - 1;
        let coefficient = if digits.len() == 1 {
            digits
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        format!(
            "{coefficient}e{}{exponent}",
            if exponent >= 0 { "+" } else { "" }
        )
    };
    if negative {
        format!("-{body}")
    } else {
        body
    }
}

fn semantic_response_value(result: &ToolResult) -> Result<Option<&Value>, ProviderBridgeError> {
    let Some(envelope) = result.result.as_object() else {
        return Ok(Some(&result.result));
    };
    let Some(ok) = envelope.get("ok").and_then(Value::as_bool) else {
        return Ok(Some(&result.result));
    };
    if !envelope.contains_key("operationId") && !envelope.contains_key("callId") {
        return Ok(Some(&result.result));
    }
    if envelope.get("operationId").and_then(Value::as_str) != Some(&result.operation_id)
        || envelope.get("callId").and_then(Value::as_str) != Some(&result.call_id)
    {
        return Err(ProviderBridgeError::invalid(
            "semantic result envelope does not match its provider call",
        ));
    }
    if ok {
        envelope
            .get("result")
            .or_else(|| envelope.get("value"))
            .map(Some)
            .ok_or_else(|| ProviderBridgeError::invalid("successful semantic result omitted value"))
    } else if envelope.get("denial").is_some() || envelope.get("error").is_some() {
        Ok(None)
    } else {
        Err(ProviderBridgeError::invalid(
            "failed semantic result omitted denial or error",
        ))
    }
}

fn validate_operation_id(value: &str) -> Result<(), ProviderBridgeError> {
    validate_stable_id(value, "tool operation id")
}

fn validate_stable_id(value: &str, label: &str) -> Result<(), ProviderBridgeError> {
    let mut chars = value.chars();
    let first = chars
        .next()
        .is_some_and(|character| character.is_ascii_alphanumeric());
    let rest = chars.all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | ':')
    });
    if first && rest && value.len() <= 160 {
        Ok(())
    } else {
        Err(ProviderBridgeError::invalid(format!("{label} is invalid")))
    }
}

fn is_sha256_digest(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn bounded_json(
    value: &impl Serialize,
    max_bytes: usize,
    label: &str,
) -> Result<(), ProviderBridgeError> {
    let bytes = json_size(value, label)?;
    if bytes > max_bytes {
        return Err(ProviderBridgeError::invalid(format!(
            "{label} exceeds the {max_bytes} byte limit"
        )));
    }
    Ok(())
}

fn json_size(value: &impl Serialize, label: &str) -> Result<usize, ProviderBridgeError> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|_| ProviderBridgeError::invalid(format!("{label} is not serializable")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compacts_completed_receipts_before_the_exact_limit_blocks_new_calls() {
        let operation = AuthorizedTool {
            operation_id: "get_task_context".to_owned(),
            version: 1,
            description: "Read the active task context.".to_owned(),
            input_schema: json!({"type": "object"}),
            response_schema: json!({"type": "object"}),
        };
        let mut bridge = ProviderToolBridge::default();
        bridge
            .prepare(AuthorizedToolSet {
                schema: TOOL_SET_SCHEMA.to_owned(),
                schema_version: 1,
                catalog_digest: authorized_tool_catalog_digest(std::slice::from_ref(&operation))
                    .unwrap(),
                operations: vec![operation],
            })
            .unwrap();
        for index in 0..MAX_RETAINED_CALL_RECEIPTS {
            bridge.evicted.insert(
                format!("call-{index}"),
                EvictedToolCall {
                    operation_id: "get_task_context".to_owned(),
                    input_digest: semantic_value_digest(&json!({})),
                    result_digest: semantic_value_digest(&json!({"ok": true})),
                    is_error: false,
                },
            );
        }

        bridge
            .begin_call(
                "call-new".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .expect("compacted receipts preserve capacity for later calls");
        assert!(!bridge.compacted_receipts.is_empty());
        assert!(bridge.compacted_receipts.contains("call-0"));
        assert!(!bridge.compacted_receipts.contains("call-new"));
        assert!(bridge
            .replay_result("call-0", "get_task_context", &json!({}))
            .unwrap()
            .is_some());
        assert!(bridge
            .begin_call(
                "call-0".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .is_err());

        let recovered: ProviderToolBridge =
            serde_json::from_str(&serde_json::to_string(&bridge).unwrap()).unwrap();
        recovered.validate_recovered().unwrap();
    }
}
