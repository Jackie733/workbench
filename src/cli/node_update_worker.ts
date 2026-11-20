import { createNodeServiceManager } from "./node_service.ts";
import { applyNodeUpdate } from "./node_update.ts";

const [hubDir, id, revision, runningRevision] = process.argv.slice(2);
try {
  if (!hubDir || !id || !revision || !runningRevision) throw new Error("Expected namespace, update ID, target and running revision");
  const installation = createNodeServiceManager({ hubDir }).readInstallation();
  if (!installation) throw new Error("Managed node is not installed");
  await applyNodeUpdate(installation, id, revision, runningRevision);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
