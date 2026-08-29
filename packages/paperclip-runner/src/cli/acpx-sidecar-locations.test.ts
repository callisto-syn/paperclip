import { describe, expect, it } from "vitest";

import { safeAcpxLocations } from "./acpx-sidecar-locations.js";

describe("ACPX sidecar locations", () => {
  it("preserves valid host-relative display names without admitting escape", () => {
    expect(safeAcpxLocations([
      { path: "src/main.ts", line: 4 },
      { path: "src:main.ts" },
      { path: String.raw`folder\literal` },
      { path: "reports/100%/summary.txt" },
      { path: "../outside.txt" },
      { path: "/etc/passwd" },
      { uri: "https://example.test/private" },
      { path: "bad\0name" },
    ], "/workspace/project")).toEqual([
      {
        path: "src/main.ts",
        line: 4,
        pathBoundary: "paperclip.workspace_relative_display.v1",
      },
      {
        path: "reports/100%/summary.txt",
        line: null,
        pathBoundary: "paperclip.workspace_relative_display.v1",
      },
    ]);
  });

  it("rejects URI and foreign-host syntax before attaching the boundary", () => {
    expect(safeAcpxLocations([
      { path: String.raw`C:\Users\alice\secret.txt` },
      { path: String.raw`\\server\share\secret.txt` },
      { path: String.raw`https:\host\secret` },
      { path: "https://host/secret" },
      { path: "file:secret.txt" },
      { path: "src:/main.ts" },
      { path: String.raw`foo\..\secret.txt` },
    ], "/workspace/project")).toEqual([]);
  });

  it("omits every location until the session working directory is bound", () => {
    expect(safeAcpxLocations([{ path: "src/main.ts" }], undefined)).toEqual([]);
  });
});
