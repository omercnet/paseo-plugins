import { createRuntimeOwner } from "./runtime-owner";
import { runStandaloneSupervisor } from "./supervisor";

void createRuntimeOwner()
  .then(runStandaloneSupervisor)
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
