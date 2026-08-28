import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

const schema = JSON.parse(
  await readFile(
    new URL(
      "../protocol/provider-schemas/acpx-sidecar.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

const messages = [
  {
    protocolVersion: 2,
    id: 1,
    command: "initialize",
    params: {},
  },
  {
    protocolVersion: 2,
    id: 1,
    ok: true,
    result: {},
  },
  {
    protocolVersion: 2,
    sequence: 1,
    eventType: "runtime.event",
    runId: "run-1",
    turnId: "turn-1",
    payload: {},
  },
];

test("the ACPX sidecar schema accepts each versioned message family", () => {
  for (const message of messages) {
    assert.equal(validate(message), true, JSON.stringify(validate.errors));
  }
});

test("the ACPX sidecar schema fails closed on drift", () => {
  for (const message of [
    { ...messages[0], protocolVersion: 3 },
    { ...messages[0], command: "session.destroy" },
    { ...messages[2], unexpected: true },
  ]) {
    assert.equal(validate(message), false);
  }
});
