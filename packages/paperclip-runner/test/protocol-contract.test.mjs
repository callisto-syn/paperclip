import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildProtocolManifest } from "../scripts/generate-protocol-manifest.mjs";
import {
  assertCodexQuestionFixture,
  assertConformanceFixturePair,
  assertQuestionAdapterFixture,
  assertReplayFixtureCompatibility,
  assertSchemaInstance,
  compileProtocolValidators,
  loadSchemaCatalog,
  readJson,
} from "../scripts/protocol-contract.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const protocolRoot = resolve(packageRoot, "protocol");

async function fixture(relativePath) {
  return (await readJson(resolve(protocolRoot, "fixtures", relativePath))).value;
}

test("all schema IDs are unique and all external references resolve", async () => {
  const schemas = await loadSchemaCatalog(resolve(protocolRoot, "schemas"));
  assert.equal(schemas.length, 20);
  assert.doesNotThrow(() => compileProtocolValidators(schemas));
});

test("the generated manifest matches all checked-in schemas and fixtures", async () => {
  const expected = `${JSON.stringify(await buildProtocolManifest(), null, 2)}\n`;
  const actual = await readFile(resolve(protocolRoot, "manifest.json"), "utf8");
  assert.equal(actual, expected);
});

test("canonical replay fixtures use supported required versions", async () => {
  for (const name of [
    "duplicate-event.json",
    "failed-run.json",
    "happy-path.json",
    "interrupted-run.json",
    "source-gap.json",
  ]) {
    assert.equal(assertReplayFixtureCompatibility(await fixture(`replay/${name}`)).protocolVersion, 1);
  }
});

test("unknown additive fields remain compatible with PRP v1", async () => {
  const value = await fixture("replay/unknown-optional-fields.json");
  assert.equal(value.futureFixtureHint.producerVersion, "1.1-preview");
  assert.doesNotThrow(() => assertReplayFixtureCompatibility(value));
});

test("unknown required versions and schemas fail closed", async () => {
  const unsupported = await fixture("replay/unsupported-required-version.json");
  assert.throws(
    () => assertReplayFixtureCompatibility(unsupported),
    /unsupported_required_version: protocolVersion=2; supported=1/,
  );

  const eventVersion = structuredClone(await fixture("replay/happy-path.json"));
  eventVersion.events[0].schemaVersion = 2;
  assert.throws(() => assertReplayFixtureCompatibility(eventVersion), /unsupported_required_version/);

  const commandSchema = structuredClone(await fixture("replay/happy-path.json"));
  commandSchema.commands[0].schema = "paperclip.prp.command.v2";
  assert.throws(() => assertReplayFixtureCompatibility(commandSchema), /unsupported_required_schema/);
});

test("accepted fixtures satisfy the complete JSON Schemas", async () => {
  const schemas = await loadSchemaCatalog(resolve(protocolRoot, "schemas"));
  const validators = compileProtocolValidators(schemas);
  const happyPath = await fixture("replay/happy-path.json");
  assert.doesNotThrow(() => assertSchemaInstance(validators.fixture, happyPath, "happy-path"));

  const missingRequiredField = structuredClone(happyPath);
  delete missingRequiredField.commands[0].commandId;
  assert.throws(
    () => assertSchemaInstance(validators.fixture, missingRequiredField, "missing-command-id"),
    /schema_validation_failed: missing-command-id must be accepted: \/commands\/0 must have required property 'commandId'/,
  );

  const unsupported = await fixture("replay/unsupported-required-version.json");
  assert.doesNotThrow(() => assertSchemaInstance(validators.fixture, unsupported, "required-v2", false));
});

test("provider descriptors require coherent provider, driver, and execution combinations", async () => {
  const schemas = await loadSchemaCatalog(resolve(protocolRoot, "schemas"));
  const validators = compileProtocolValidators(schemas);
  const codex = {
    provider: "codex",
    driver: "codex_app_server",
    model: "gpt-5.3-codex",
    executionKind: "local_process",
    providerVersion: "1",
  };
  assert.doesNotThrow(() => assertSchemaInstance(validators.providerDescriptor, codex, "codex-provider"));
  assert.throws(
    () => assertSchemaInstance(
      validators.providerDescriptor,
      { ...codex, driver: "opencode_server" },
      "mismatched-provider",
    ),
    /schema_validation_failed: mismatched-provider must be accepted/,
  );
});

test("the Codex question fixture uses stable provider-neutral IDs", async () => {
  const value = await fixture("questions/codex.json");
  assert.doesNotThrow(() => assertCodexQuestionFixture(value));
  assert.deepEqual(Object.keys(value.canonicalResponse.answers), ["environment"]);
});

test("every question adapter fixture satisfies its declared schema", async () => {
  const schemas = await loadSchemaCatalog(resolve(protocolRoot, "schemas"));
  const validators = compileProtocolValidators(schemas);
  for (const adapter of ["codex", "acpx"]) {
    const value = await fixture(`questions/${adapter}.json`);
    assert.doesNotThrow(() =>
      assertSchemaInstance(
        validators.questionAdapterFixture,
        value,
        `${adapter}-question-fixture`,
      ),
    );
    assert.doesNotThrow(() => assertQuestionAdapterFixture(value));
  }

  const malformed = structuredClone(await fixture("questions/acpx.json"));
  delete malformed.canonicalQuestionSet.schema;
  assert.throws(
    () =>
      assertSchemaInstance(
        validators.questionAdapterFixture,
        malformed,
        "malformed-acpx-question-fixture",
      ),
    /schema_validation_failed/,
  );

  const unknownQuestion = structuredClone(await fixture("questions/acpx.json"));
  unknownQuestion.canonicalResponse.answers = {
    "unknown-question": { selectedOptionIds: ["option-1"] },
  };
  assert.throws(
    () => assertQuestionAdapterFixture(unknownQuestion),
    /answer has unknown question ID unknown-question/,
  );

  const unknownOption = structuredClone(await fixture("questions/acpx.json"));
  const [questionId] = Object.keys(unknownOption.canonicalResponse.answers);
  unknownOption.canonicalResponse.answers[questionId].selectedOptionIds = [
    "unknown-option",
  ];
  assert.throws(
    () => assertQuestionAdapterFixture(unknownOption),
    /answer has unknown option ID unknown-option/,
  );

  const canonical = await fixture("questions/acpx.json");
  const [requiredQuestion] = canonical.canonicalQuestionSet.questions;
  const requiredQuestionId = requiredQuestion.id;
  const malformedAnswers = [
    {
      label: "missing required answer",
      answer: undefined,
      pattern: /required question .* is missing/,
    },
    {
      label: "empty required answer",
      answer: {},
      pattern: /required question .* is empty/,
    },
    {
      label: "multiple single-select values",
      answer: { selectedOptionIds: requiredQuestion.options.map((option) => option.id) },
      pattern: /single-select answer .* chooses more than one option/,
    },
    {
      label: "text on a select question",
      answer: { text: "staging" },
      pattern: /select answer .* carries text/,
    },
    {
      label: "disabled custom answer",
      answer: { customText: "canary" },
      pattern: /custom answer .* is not enabled/,
    },
  ];
  for (const malformedAnswer of malformedAnswers) {
    const malformedResponse = structuredClone(canonical);
    malformedResponse.canonicalResponse.answers = malformedAnswer.answer === undefined
      ? {}
      : { [requiredQuestionId]: malformedAnswer.answer };
    assert.throws(
      () => assertQuestionAdapterFixture(malformedResponse),
      malformedAnswer.pattern,
      malformedAnswer.label,
    );
  }

  const textModeMismatch = structuredClone(canonical);
  textModeMismatch.canonicalQuestionSet.questions[0] = {
    ...requiredQuestion,
    answerMode: "text",
    options: [],
  };
  textModeMismatch.canonicalResponse.answers[requiredQuestionId] = {
    customText: "select-only custom value",
  };
  assert.throws(
    () => assertQuestionAdapterFixture(textModeMismatch),
    /text answer .* carries select-only fields/,
  );

  const invalidTextAnswers = [
    {
      label: "minimum text length",
      validation: { minLength: 4 },
      text: "abc",
      pattern: /must contain at least 4 characters/,
    },
    {
      label: "maximum text length",
      validation: { maxLength: 2 },
      text: "abc",
      pattern: /must contain at most 2 characters/,
    },
    {
      label: "text pattern",
      validation: { pattern: "^z+$" },
      text: "abc",
      pattern: /does not match the required format/,
    },
    {
      label: "numeric input",
      validation: { inputType: "number" },
      text: "not-a-number",
      pattern: /must be a valid number/,
    },
    {
      label: "integer input",
      validation: { inputType: "integer" },
      text: "1.5",
      pattern: /must be a valid integer/,
    },
    {
      label: "numeric minimum",
      validation: { inputType: "number", minimum: 2 },
      text: "1",
      pattern: /must be at least 2/,
    },
    {
      label: "numeric maximum",
      validation: { inputType: "number", maximum: 2 },
      text: "3",
      pattern: /must be at most 2/,
    },
  ];
  for (const invalid of invalidTextAnswers) {
    const malformedResponse = structuredClone(canonical);
    malformedResponse.canonicalQuestionSet.questions[0] = {
      ...requiredQuestion,
      answerMode: "text",
      options: [],
      textValidation: invalid.validation,
    };
    malformedResponse.canonicalResponse.answers[requiredQuestionId] = {
      text: invalid.text,
    };
    assert.throws(
      () => assertQuestionAdapterFixture(malformedResponse),
      invalid.pattern,
      invalid.label,
    );
  }

  const invalidCustomText = structuredClone(canonical);
  invalidCustomText.canonicalQuestionSet.questions[0] = {
    ...requiredQuestion,
    customAnswer: { enabled: true },
    textValidation: { minLength: 2, inputType: "text" },
  };
  invalidCustomText.canonicalResponse.answers[requiredQuestionId] = {
    customText: "x",
  };
  assert.throws(
    () => assertQuestionAdapterFixture(invalidCustomText),
    /must contain at least 2 characters/,
    "select custom text validation",
  );
});

test("the cross-language conformance input and output have one stable identity", async () => {
  const input = await fixture("conformance-minimal-run.json");
  const output = await fixture("conformance-expected-output.json");
  const schemas = await loadSchemaCatalog(resolve(protocolRoot, "schemas"));
  const validators = compileProtocolValidators(schemas);
  assert.doesNotThrow(() => assertSchemaInstance(validators.conformanceFixture, input, "conformance-input"));
  assert.doesNotThrow(() => assertSchemaInstance(validators.conformanceOutput, output, "conformance-output"));
  assert.doesNotThrow(() => assertConformanceFixturePair(input, output));
  assert.equal(input.result.summary, output.result.summary);

  const missingSessionId = structuredClone(output);
  delete missingSessionId.runIdentity.sessionId;
  assert.throws(
    () => assertSchemaInstance(validators.conformanceOutput, missingSessionId, "missing-session-id"),
    /schema_validation_failed: missing-session-id must be accepted: \/runIdentity must have required property 'sessionId'/,
  );
});
