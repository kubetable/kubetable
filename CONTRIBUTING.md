# Contributing To KubeTable Community

## Scope

This repository is for the local-first Community desktop app:

- desktop UI
- Tauri/Rust local backend
- Kubernetes discovery
- local port-forwarding
- database adapters
- local history and saved queries
- test manifests

Hosted auth, billing, telemetry, cloud sync, team features, and private release infrastructure are outside
the scope of this public repository.

Before changing kubeconfig, credential, query execution, logging, or network behavior, read
[docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md).

## Development

Install dependencies:

```sh
bun install
```

Run checks before opening a pull request:

```sh
bun run build
cd src-tauri
cargo check
```

## Pull Requests

- Keep changes focused.
- Include a clear description of behavior changes.
- Add or update tests when touching shared logic.
- Do not include secrets, kubeconfigs, tokens, private endpoints, or paid-service implementation details.
- Keep hosted Pro functionality behind the edition provider boundary.

By contributing, you agree that your contribution is licensed under the Apache-2.0 license used by this project.
