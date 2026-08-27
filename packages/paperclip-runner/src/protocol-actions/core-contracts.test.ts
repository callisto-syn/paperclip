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

      const projection = action.live ?? action.scenario;
      expect(projection).not.toBeNull();
      expect(
        ajv.validate(projection!.descriptor.inputSchema, action.examples.call.input),
        JSON.stringify(ajv.errors),
      ).toBe(true);
      expect(
        ajv.validate(projection!.descriptor.outputSchema, action.examples.success.result),
        JSON.stringify(ajv.errors),
      ).toBe(true);
    },
  );
});
