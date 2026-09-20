// src/store.js
const deployments = new Map();

export function putDeployment(dep) {
  deployments.set(dep.deploymentId, dep);
  return dep;
}

export function getDeployment(id) {
  return deployments.get(id);
}
