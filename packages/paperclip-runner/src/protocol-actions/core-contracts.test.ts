import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { PAPERCLIP_CORE_PROTOCOL_ACTIONS } from "./core.js";

describe("core Paperclip protocol action contracts", () => {
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: false });

  it.each(PAPERCLIP_CORE_PROTOCOL_ACTIONS.map((action) => [action.id, action] as const))(
    "%s has immutable metadata and schema-valid examples",
    (operationId, action) => {
      expect(action.canonical.operationId).toBe(operationId);
      expect(action.canonical.placement).toBe("always_agent_tool");
      expect(action.examples.call.operationId).toBe(operationId);
      expect(action.examples.success.operationId).toBe(operationId);
      expect(Object.isFrozen(action)).toBe(true);
      expect(Object.isFrozen(action.canonical)).toBe(true);

      expect(action.live !== null || action.scenario !== null).toBe(true);

      if (action.live !== null) {
        expect(
          ajv.validate(action.live.descriptor.inputSchema, action.examples.call.input),
          JSON.stringify(ajv.errors),
        ).toBe(true);
        expect(
          ajv.validate(action.live.descriptor.outputSchema, action.examples.success.result),
          JSON.stringify(ajv.errors),
        ).toBe(true);
      }

      if (action.scenario !== null) {
        const scenarioProperties = action.scenario.descriptor.inputSchema.properties ?? {};
        const scenarioInput = Object.fromEntries(
          Object.entries(action.examples.call.input).filter(([key]) => key in scenarioProperties),
        );
        const scenarioOutput = {
          schema: "paperclip.capability.tool-result.v1",
          ok: true,
          operationId,
          operationResultId: "example-result",
          value: action.examples.success.result,
          commandResult: null,
          authorization: {},
        };

        expect(
          ajv.validate(action.scenario.descriptor.inputSchema, scenarioInput),
          JSON.stringify(ajv.errors),
        ).toBe(true);
        expect(
          ajv.validate(action.scenario.descriptor.outputSchema, scenarioOutput),
          JSON.stringify(ajv.errors),
        ).toBe(true);
      }
    },
  );
});
