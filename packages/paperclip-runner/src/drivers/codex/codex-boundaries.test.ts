import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  boundedCodexPayload,
  codexToolAcceptsDisposition,
  isCodexSemanticTool,
  isRetainableCodexPayload,
  redactCodexValue,
  validateCodexWorkingDirectory,
} from "./codex-boundaries.js";

describe("Codex value and workspace boundaries", () => {
  it("accepts only an assigned non-root workspace that does not contain host state", () => {
    const workspaceRoot = resolve("/paperclip/workspaces");
    expect(validateCodexWorkingDirectory("/paperclip/workspaces/run-1", {
      HOME: "/host/home",
      CODEX_HOME: "/host/codex",
      PAPERCLIP_WORKSPACE_CWD: workspaceRoot,
    })).toBe(resolve("/paperclip/workspaces/run-1"));

    expect(() => validateCodexWorkingDirectory("/", {})).toThrow("filesystem root");
    expect(() => validateCodexWorkingDirectory("/host", {
      HOME: "/host/home",
    })).toThrow("cannot contain the host HOME");
    expect(() => validateCodexWorkingDirectory("/other/run", {
      PAPERCLIP_WORKSPACE_CWD: workspaceRoot,
    })).toThrow("outside the assigned workspace");
    expect(() => validateCodexWorkingDirectory("/host/codex/run", {
      CODEX_HOME: "/host/codex",
    })).toThrow("cannot overlap host CODEX_HOME");
  });

  it("bounds retained values and redacts protected diagnostics", () => {
    const bounded = boundedCodexPayload({
      short: "ok",
      long: "x".repeat(40_000),
      many: Array.from({ length: 140 }, (_, index) => index),
    });
    expect(String(bounded.long)).toContain("[truncated]");
    expect(bounded.many).toHaveLength(129);
    expect(isRetainableCodexPayload({ value: "x".repeat(70_000) })).toBe(false);

    expect(redactCodexValue({
      token: "sensitive",
      message: "Authorization: Bearer abcdefghijklmnop",
    })).toEqual({
      token: "[REDACTED]",
      message: "Authorization: Bearer [REDACTED]",
    });
  });

  it("keeps completion and block dispositions distinct", () => {
    expect(isCodexSemanticTool("paperclip_finish")).toBe(true);
    expect(isCodexSemanticTool("paperclip_block")).toBe(true);
    expect(isCodexSemanticTool("shell")).toBe(false);
    expect(codexToolAcceptsDisposition("paperclip_finish", "done")).toBe(true);
    expect(codexToolAcceptsDisposition("paperclip_finish", "blocked")).toBe(false);
    expect(codexToolAcceptsDisposition("paperclip_block", "blocked")).toBe(true);
  });
});
