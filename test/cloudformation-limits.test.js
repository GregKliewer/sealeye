// What CloudFormation refuses before it changes anything, checked here so it is found in
// a test and not on the pilot: a template's Description, and each output's, is at most
// 1024 characters (Oct 21, 2026: the foundation's grew past it with its endpoints, and
// `aws cloudformation deploy` stopped with "'Description' length is greater than 1024").
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "..");
const templates = ["deploy", "templates"].flatMap(dir =>
  fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith(".yaml")).map(f => path.join(dir, f)));

// CloudFormation's short forms (!Sub, !Ref, ...) read as their plain values: only the words matter here.
const read = file => YAML.parse(fs.readFileSync(path.join(root, file), "utf8").replace(/!(?:Sub|Ref|GetAtt|Join|Select|GetAZs|Cidr|ImportValue|If|Equals|Not|And|Or|Split|FindInMap|Base64|Condition)\b/g, ""));

test("every CloudFormation template's description, and each output's, fits CloudFormation's limit", () => {
  const cloudformation = templates.map(f => [f, read(f)]).filter(([, t]) => t && typeof t === "object" && t.AWSTemplateFormatVersion);
  assert.ok(cloudformation.length >= 5, "found the templates");
  for (const [file, t] of cloudformation) {
    assert.ok(String(t.Description || "").length <= 1024, `${file}: its Description is ${String(t.Description).length} characters, more than CloudFormation's 1024`);
    for (const [name, out] of Object.entries(t.Outputs || {})) {
      assert.ok(String(out?.Description || "").length <= 1024, `${file}: output ${name}'s Description is more than 1024 characters`);
    }
  }
});
