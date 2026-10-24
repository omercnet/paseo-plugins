/**
 * Paseo ships the OMP provider switched off. The image ships omp, so the sandbox daemon turns the
 * provider on in its own config and reloads it. Idempotent, and it never touches other keys.
 */
export const ENABLE_OMP = [
  "node",
  "-e",
  `const fs = require("fs");
const path = process.env.PASEO_HOME + "/config.json";
const config = JSON.parse(fs.readFileSync(path, "utf8"));
const providers = ((config.agents ??= {}).providers ??= {});
(providers.omp ??= {}).enabled = true;
fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\\n");`,
] as const;
