import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { safeAcpxLocations } from "./acpx-sidecar-locations.js";

describe("ACPX sidecar locations", () => {
  it("preserves valid host-relative display names without admitting escape", () => {
    const workspace = mkdtempSync(join(tmpdir(), "paperclip-acpx-locations-"));
    writeFileSync(join(workspace, "src:main.ts"), "");
    mkdirSync(join(workspace, "a:"));
    writeFileSync(join(workspace, "a:", "foo"), "");
    writeFileSync(join(workspace, "custom:payload"), "");
    try {
      expect(
        safeAcpxLocations(
          [
            { path: "src/main.ts", line: 4 },
            { path: "src:main.ts" },
            { path: String.raw`folder\literal` },
            { path: "a:/foo" },
            { path: "custom:payload" },
            { path: String.raw`foo\..\bar` },
            { path: "reports/100%/summary.txt" },
            { path: "../outside.txt" },
            { path: "/etc/passwd" },
            { uri: "https://example.test/private" },
            { path: "bad\0name" },
          ],
          workspace,
        ),
      ).toEqual([
        {
          path: "src/main.ts",
          line: 4,
          pathBoundary: "paperclip.workspace_relative_display.v2",
        },
        {
          path: "src:main.ts",
          line: null,
          pathBoundary: "paperclip.workspace_relative_display.v2",
          pathAttestation: "paperclip.workspace_entry.v1",
        },
        {
          path: String.raw`folder\literal`,
          line: null,
          pathBoundary: "paperclip.workspace_relative_display.v2",
        },
        {
          path: "a:/foo",
          line: null,
          pathBoundary: "paperclip.workspace_relative_display.v2",
          pathAttestation: "paperclip.workspace_entry.v1",
        },
        {
          path: "custom:payload",
          line: null,
          pathBoundary: "paperclip.workspace_relative_display.v2",
          pathAttestation: "paperclip.workspace_entry.v1",
        },
        {
          path: String.raw`foo\..\bar`,
          line: null,
          pathBoundary: "paperclip.workspace_relative_display.v2",
        },
        {
          path: "reports/100%/summary.txt",
          line: null,
          pathBoundary: "paperclip.workspace_relative_display.v2",
        },
      ]);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("rejects URI and foreign-host syntax before attaching the boundary", () => {
    expect(
      safeAcpxLocations(
        [
          { path: String.raw`C:\Users\alice\secret.txt` },
          { path: String.raw`\\server\share\secret.txt` },
          { path: String.raw`https:\host\secret` },
          { path: "https://host/secret" },
          { path: "file:secret.txt" },
          { path: "s3:bucket/key" },
          { path: "custom:payload" },
          { path: "urn:isbn:9780131103627" },
          { path: "tel:+15555550100" },
          { path: String.raw`C:Users\alice\secret.txt` },
          { path: "D:relative.txt" },
        ],
        tmpdir(),
      ),
    ).toEqual([]);
  });

  it("omits every location until the session working directory is bound", () => {
    expect(safeAcpxLocations([{ path: "src/main.ts" }], undefined)).toEqual([]);
  });
});
