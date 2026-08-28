use crate::acpx_sidecar_transport::AcpxSidecarEvent;
use crate::generated_acpx_sidecar_contract::GeneratedAcpxSidecarEventType;
use crate::local_runner::LocalRunnerError;

const MAX_SCOPE_ID_CHARS: usize = 160;

/// Holds the run and turn authority used to admit ACPX sidecar events.
///
/// The sidecar transport validates framing and sequence identity. This scope
/// validates that a well-formed event still belongs to the run and turn that
/// runnerd is currently executing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcpxEventScope {
    run_id: String,
    active_turn_id: Option<String>,
}

impl AcpxEventScope {
    pub fn new(run_id: impl Into<String>) -> Result<Self, LocalRunnerError> {
        let run_id = run_id.into();
        validate_scope_id(&run_id, "run")?;
        Ok(Self {
            run_id,
            active_turn_id: None,
        })
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn active_turn_id(&self) -> Option<&str> {
        self.active_turn_id.as_deref()
    }

    pub fn bind_turn(&mut self, turn_id: impl Into<String>) -> Result<(), LocalRunnerError> {
        let turn_id = turn_id.into();
        validate_scope_id(&turn_id, "turn")?;
        match self.active_turn_id.as_deref() {
            Some(active_turn_id) if active_turn_id == turn_id.as_str() => Ok(()),
            Some(_) => Err(LocalRunnerError::invalid(
                "ACPX event scope already has a different active turn",
            )),
            None => {
                self.active_turn_id = Some(turn_id);
                Ok(())
            }
        }
    }

    pub fn clear_turn(&mut self, turn_id: &str) -> Result<(), LocalRunnerError> {
        validate_scope_id(turn_id, "turn")?;
        if self.active_turn_id.as_deref() != Some(turn_id) {
            return Err(LocalRunnerError::invalid(
                "ACPX event scope cannot clear a stale turn",
            ));
        }
        self.active_turn_id = None;
        Ok(())
    }

    pub fn validate_event(&self, event: &AcpxSidecarEvent) -> Result<(), LocalRunnerError> {
        if let Some(run_id) = event.run_id.as_deref() {
            validate_scope_id(run_id, "event run")?;
        }
        if let Some(turn_id) = event.turn_id.as_deref() {
            validate_scope_id(turn_id, "event turn")?;
        }
        let global_event = matches!(
            event.event_type,
            GeneratedAcpxSidecarEventType::RuntimeProcess
                | GeneratedAcpxSidecarEventType::RuntimeDiagnostic
        );

        match event.run_id.as_deref() {
            Some(run_id) if run_id != self.run_id => {
                return Err(LocalRunnerError::invalid(
                    "ACPX sidecar event named a stale run",
                ));
            }
            Some(_) => {}
            None if !global_event => {
                return Err(LocalRunnerError::invalid(
                    "ACPX sidecar event omitted its run binding",
                ));
            }
            None => {}
        }

        if global_event && event.turn_id.is_none() {
            return Ok(());
        }
        if global_event && event.run_id.is_none() {
            return Err(LocalRunnerError::invalid(
                "ACPX sidecar event named a turn without a run binding",
            ));
        }

        let turn_id = event.turn_id.as_deref().ok_or_else(|| {
            LocalRunnerError::invalid("ACPX sidecar event omitted its turn binding")
        })?;
        match self.active_turn_id.as_deref() {
            Some(active_turn_id) if active_turn_id == turn_id => Ok(()),
            Some(_) => Err(LocalRunnerError::invalid(
                "ACPX sidecar event named a stale turn",
            )),
            None => Err(LocalRunnerError::invalid(
                "ACPX sidecar event requires an active turn",
            )),
        }
    }
}

fn validate_scope_id(value: &str, label: &str) -> Result<(), LocalRunnerError> {
    if value.is_empty()
        || value.chars().count() > MAX_SCOPE_ID_CHARS
        || value.chars().any(char::is_control)
    {
        return Err(LocalRunnerError::invalid(format!(
            "ACPX event scope {label} id is invalid"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn event(
        event_type: GeneratedAcpxSidecarEventType,
        run_id: Option<&str>,
        turn_id: Option<&str>,
    ) -> AcpxSidecarEvent {
        AcpxSidecarEvent {
            sequence: 1,
            event_type,
            run_id: run_id.map(str::to_owned),
            turn_id: turn_id.map(str::to_owned),
            payload: json!({}),
        }
    }

    #[test]
    fn admits_every_turn_scoped_event_only_for_the_active_run_and_turn() {
        let mut scope = AcpxEventScope::new("run-1").unwrap();
        scope.bind_turn("turn-1").unwrap();
        for event_type in [
            GeneratedAcpxSidecarEventType::RuntimeEvent,
            GeneratedAcpxSidecarEventType::RuntimePermissionRequested,
            GeneratedAcpxSidecarEventType::RuntimeInputRequested,
            GeneratedAcpxSidecarEventType::RuntimeToolCalled,
            GeneratedAcpxSidecarEventType::RuntimeTurnTerminal,
        ] {
            scope
                .validate_event(&event(event_type, Some("run-1"), Some("turn-1")))
                .unwrap();
        }
    }

    #[test]
    fn rejects_missing_and_cross_run_turn_bindings() {
        let mut scope = AcpxEventScope::new("run-1").unwrap();
        scope.bind_turn("turn-1").unwrap();
        for (run_id, turn_id, message) in [
            (None, Some("turn-1"), "omitted its run binding"),
            (Some("run-2"), Some("turn-1"), "stale run"),
            (Some("run-1"), None, "omitted its turn binding"),
            (Some("run-1"), Some("turn-2"), "stale turn"),
        ] {
            let error = scope
                .validate_event(&event(
                    GeneratedAcpxSidecarEventType::RuntimeToolCalled,
                    run_id,
                    turn_id,
                ))
                .unwrap_err();
            assert!(error.to_string().contains(message), "{error}");
        }

        scope.clear_turn("turn-1").unwrap();
        let error = scope
            .validate_event(&event(
                GeneratedAcpxSidecarEventType::RuntimeToolCalled,
                Some("run-1"),
                Some("turn-1"),
            ))
            .unwrap_err();
        assert!(error.to_string().contains("requires an active turn"));
    }

    #[test]
    fn admits_unbound_process_and_diagnostic_events() {
        let scope = AcpxEventScope::new("run-1").unwrap();
        for event_type in [
            GeneratedAcpxSidecarEventType::RuntimeProcess,
            GeneratedAcpxSidecarEventType::RuntimeDiagnostic,
        ] {
            scope
                .validate_event(&event(event_type, None, None))
                .unwrap();
            scope
                .validate_event(&event(event_type, Some("run-1"), None))
                .unwrap();
        }
    }

    #[test]
    fn validates_optional_scope_on_process_and_diagnostic_events() {
        let mut scope = AcpxEventScope::new("run-1").unwrap();
        scope.bind_turn("turn-1").unwrap();
        let wrong_run = scope
            .validate_event(&event(
                GeneratedAcpxSidecarEventType::RuntimeProcess,
                Some("run-2"),
                None,
            ))
            .unwrap_err();
        assert!(wrong_run.to_string().contains("stale run"));

        let missing_run = scope
            .validate_event(&event(
                GeneratedAcpxSidecarEventType::RuntimeDiagnostic,
                None,
                Some("turn-1"),
            ))
            .unwrap_err();
        assert!(missing_run.to_string().contains("without a run binding"));

        let wrong_turn = scope
            .validate_event(&event(
                GeneratedAcpxSidecarEventType::RuntimeDiagnostic,
                Some("run-1"),
                Some("turn-2"),
            ))
            .unwrap_err();
        assert!(wrong_turn.to_string().contains("stale turn"));

        scope
            .validate_event(&event(
                GeneratedAcpxSidecarEventType::RuntimeProcess,
                Some("run-1"),
                Some("turn-1"),
            ))
            .unwrap();
    }

    #[test]
    fn binds_and_clears_one_turn_idempotently() {
        let mut scope = AcpxEventScope::new("run-1").unwrap();
        scope.bind_turn("turn-1").unwrap();
        scope.bind_turn("turn-1").unwrap();
        assert_eq!(scope.active_turn_id(), Some("turn-1"));
        assert!(scope.bind_turn("turn-2").is_err());
        scope.clear_turn("turn-1").unwrap();
        assert_eq!(scope.active_turn_id(), None);
        assert!(scope.clear_turn("turn-1").is_err());
    }

    #[test]
    fn rejects_invalid_scope_identifiers() {
        assert!(AcpxEventScope::new("").is_err());
        assert!(AcpxEventScope::new("run\n1").is_err());
        let mut scope = AcpxEventScope::new("run-1").unwrap();
        assert!(scope.bind_turn("t".repeat(161)).is_err());
        let oversized_run_id = "r".repeat(161);
        assert!(scope
            .validate_event(&event(
                GeneratedAcpxSidecarEventType::RuntimeDiagnostic,
                Some(&oversized_run_id),
                None,
            ))
            .is_err());
    }
}
