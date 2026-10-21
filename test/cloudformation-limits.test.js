// What CloudFormation refuses before it changes anything, checked here so it is found in
// a test and not on the pilot: a template's Description, and each output's, is at most
// 1024 characters (Oct 21, 2026: the foundation's grew past it with its endpoints, and
// `aws cloudformation deploy` stopped with "'Description' length is greater than 1024");
// and a security group's description is under 256 characters from a short set, with no
// apostrophe (Oct 21, the endpoints stack's group: "Invalid security group description").
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

// The characters EC2 takes in a security group's description, as its error lists them.
const GROUP_DESCRIPTION = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]{0,255}$/;

test("every security group's description is one EC2 takes", () => {
  let groups = 0;
  for (const file of templates) {
    const t = read(file);
    for (const [name, r] of Object.entries(t?.Resources || {})) {
      if (r?.Type !== "AWS::EC2::SecurityGroup") continue;
      groups += 1;
      const d = String(r.Properties?.GroupDescription ?? "");
      assert.match(d, GROUP_DESCRIPTION, `${file}: ${name}'s description has a character EC2 refuses, or is too long: ${JSON.stringify(d)}`);
    }
  }
  assert.ok(groups >= 5, "found the security groups");
});

