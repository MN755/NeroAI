import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import * as esm from "../dist/index.js";

const require = createRequire(import.meta.url);
const cjs = require("../dist/index.cjs");

for (const [format, schemas] of [["ESM", esm], ["CommonJS", cjs]]) {
  describe(`${format} shared schema compatibility`, () => {
    it("accepts the supported permission and grant enums only", () => {
      for (const permission of ["filesystem.read", "filesystem.write", "web.search", "clipboard.read", "clipboard.write", "process.run"]) {
        assert.equal(schemas.permissionTypeSchema.parse(permission), permission);
      }
      for (const scope of ["once", "session", "always"]) {
        assert.equal(schemas.grantScopeSchema.parse(scope), scope);
      }
      assert.equal(schemas.permissionTypeSchema.safeParse("admin").success, false);
      assert.equal(schemas.grantScopeSchema.safeParse("forever").success, false);
    });

    it("preserves model defaults, optional tokens and unknown-field stripping", () => {
      const input = { id: "remote", name: "Remote", baseUrl: "https://model.invalid/v1" };
      assert.deepEqual(schemas.modelSourceSchema.parse({ ...input, unrelated: true }), { ...input, isLocal: false });
      assert.deepEqual(schemas.modelSourceSchema.parse({ ...input, authToken: "test-token", isLocal: true }), { ...input, authToken: "test-token", isLocal: true });
      assert.equal(schemas.modelSourceSchema.safeParse({ ...input, baseUrl: "invalid" }).success, false);
    });

    it("keeps arbitrary string-keyed workflow configuration values", () => {
      const config = { prompt: "Hello", nested: { count: 2 }, list: [1, false], empty: null, optional: undefined, "": "empty key" };
      const steps = ["prompt_agent", "call_tool", "set_variable"].map((type, index) => ({ id: String(index), type, config }));
      assert.deepEqual(schemas.workflowSchema.parse({ id: "flow", name: "Flow", steps }), { id: "flow", name: "Flow", description: "", steps });
    });

    it("rejects malformed workflow records and unsupported step types", () => {
      for (const config of [null, [], "config"]) {
        assert.equal(schemas.workflowStepSchema.safeParse({ id: "step", type: "call_tool", config }).success, false);
      }
      assert.equal(schemas.workflowStepSchema.safeParse({ id: "step", type: "unknown", config: {} }).success, false);
      assert.equal(schemas.workflowStepSchema.safeParse({ id: "step", type: "call_tool" }).success, false);
    });

    it("preserves UI defaults and optional string-keyed bindings", () => {
      const component = { id: "button", type: "button" };
      assert.deepEqual(schemas.uiComponentSchema.parse(component), { ...component, props: {} });
      const props = { text: "Run", enabled: true, data: [1, { value: null }] };
      const binding = { source: "workspace", field: { path: "name" } };
      const components = [{ ...component, props, binding }];
      assert.deepEqual(schemas.uiLayoutSchema.parse({ id: "layout", name: "Layout", components }), { id: "layout", name: "Layout", components });
    });

    it("rejects malformed UI records", () => {
      for (const key of ["props", "binding"]) {
        for (const value of [null, [], "value"]) {
          assert.equal(schemas.uiComponentSchema.safeParse({ id: "text", type: "text", [key]: value }).success, false);
        }
      }
    });
  });
}
