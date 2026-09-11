# Integration tests

Run the real Docker host/container ownership boundary test with:

```sh
bun run test:integration:docker
```

The script starts the MCP server as a host process, calls it from a Bun container, executes a host tool, and verifies the returned host PID, host working directory, caller agent ID, and workspace ID. Set `PASEO_OMP_DOCKER_IMAGE` to override the default `oven/bun:1.4.0` image.

Run the equivalent Windows-host/WSL boundary with:

```sh
bun run test:integration:wsl
```

The WSL script skips when `wsl.exe` or WSL Bun is unavailable. Set `PASEO_OMP_REQUIRE_WSL=1` to make either condition fatal, as CI does. `PASEO_OMP_WSL_BUN` may override the default `$HOME/.bun/bin/bun` path inside WSL.
