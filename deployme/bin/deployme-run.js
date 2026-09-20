import fs from "fs";
import YAML from "yaml";

const backend = process.argv[2] || "terraform"; // terraform|cloudformation
const planPath = process.argv[3] || "deployme.yaml";

const plan = YAML.parse(fs.readFileSync(planPath, "utf8"));

const res = await fetch("http://localhost:3000/deployments", {
  method: "POST",
  headers: {"Content-Type":"application/json"},
  body: JSON.stringify({ backend, plan })
});

console.log(await res.json());