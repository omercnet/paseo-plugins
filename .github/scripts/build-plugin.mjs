import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const pluginRoot = process.cwd();
const require = createRequire(join(pluginRoot, "package.json"));
const serverEntry = require.resolve("@getpaseo/server");
const compilerUrl = pathToFileURL(join(dirname(serverEntry), "plugins", "compiler.js")).href;
const { compilePlugin } = await import(compilerUrl);

function findEntry(name) {
  for (const extension of ["tsx", "ts"]) {
    const candidate = join(pluginRoot, `${name}.${extension}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const client = findEntry("index.client");
const server = findEntry("index.server");
if (!client && !server) {
  throw new Error(`No plugin entrypoints found in ${pluginRoot}`);
}

const bundles = await compilePlugin({ client, server });
if (client && !bundles.clientBundle) {
  throw new Error("Paseo compiler produced no client bundle");
}
if (server && !bundles.serverBundle) {
  throw new Error("Paseo compiler produced no server bundle");
}

console.log(
  `Compiled ${[client && "client", server && "server"].filter(Boolean).join(" and ")} plugin bundles`,
);
