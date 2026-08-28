use paperclip_runner_core::question_response::validate_question_response;
use serde_json::{json, Value};

fn question_set() -> Value {
    json!({
        "schema":"paperclip.question_set.v1",
        "questions":[
            {
                "id":"target",
                "prompt":"Which target?",
                "required":true,
                "answerMode":"single_select",
                "options":[{"id":"first","label":"First"},{"id":"second","label":"Second"}],
                "customAnswer":{"enabled":true}
            },
            {
                "id":"regions",
                "prompt":"Which regions?",
                "required":false,
                "answerMode":"multi_select",
                "options":[{"id":"east","label":"East"},{"id":"west","label":"West"}]
            },
            {
                "id":"notes",
                "prompt":"Add notes",
                "required":true,
                "answerMode":"text",
                "textValidation":{"minLength":2,"maxLength":5,"pattern":"^[A-Z]+$"}
            },
            {
                "id":"count",
                "prompt":"How many?",
                "required":false,
                "answerMode":"text",
                "textValidation":{"inputType":"integer","minimum":1,"maximum":3}
            }
        ]
    })
}

fn valid_response() -> Value {
    json!({
        "schema":"paperclip.question_response.v1",
        "answers":{
            "target":{"selectedOptionIds":["first"]},
            "regions":{"selectedOptionIds":["east","west"]},
            "notes":{"text":"YES"},
            "count":{"text":"2"}
        }
    })
}

#[test]
fn accepts_answers_that_match_the_exact_question_set() {
    validate_question_response(&question_set(), &valid_response()).unwrap();

    let mut custom = valid_response();
    custom["answers"]["target"] = json!({"customText":"another"});
    validate_question_response(&question_set(), &custom).unwrap();

    let mut javascript_numeric_syntax = valid_response();
    javascript_numeric_syntax["answers"]["count"] = json!({"text":"0x2"});
    validate_question_response(&question_set(), &javascript_numeric_syntax).unwrap();
}

#[test]
fn rejects_cross_document_and_answer_mode_mismatches() {
    let cases = [
        ("missing required", {
            let mut value = valid_response();
            value["answers"].as_object_mut().unwrap().remove("target");
            value
        }),
        ("unknown question", {
            let mut value = valid_response();
            value["answers"]["other"] = json!({"text":"x"});
            value
        }),
        ("unknown option", {
            let mut value = valid_response();
            value["answers"]["target"] = json!({"selectedOptionIds":["other"]});
            value
        }),
        ("multiple single selections", {
            let mut value = valid_response();
            value["answers"]["target"] = json!({"selectedOptionIds":["first","second"]});
            value
        }),
        ("combined single selection", {
            let mut value = valid_response();
            value["answers"]["target"] =
                json!({"selectedOptionIds":["first"],"customText":"other"});
            value
        }),
        ("selection on text", {
            let mut value = valid_response();
            value["answers"]["notes"] = json!({"selectedOptionIds":["first"]});
            value
        }),
        ("pattern mismatch", {
            let mut value = valid_response();
            value["answers"]["notes"] = json!({"text":"no"});
            value
        }),
        ("numeric mismatch", {
            let mut value = valid_response();
            value["answers"]["count"] = json!({"text":"4"});
            value
        }),
        ("invalid numeric syntax", {
            let mut value = valid_response();
            value["answers"]["count"] = json!({"text":"0xGG"});
            value
        }),
    ];
    for (label, response) in cases {
        assert!(
            validate_question_response(&question_set(), &response).is_err(),
            "{label} unexpectedly passed"
        );
    }
}

#[test]
fn rejects_malformed_or_oversized_response_envelopes() {
    assert!(validate_question_response(
        &question_set(),
        &json!({"schema":"paperclip.question_response.v2","answers":{}})
    )
    .is_err());
    assert!(validate_question_response(
        &question_set(),
        &json!({
            "schema":"paperclip.question_response.v1",
            "answers":{"notes":{"text":"x".repeat(800_000)}}
        })
    )
    .is_err());
}
