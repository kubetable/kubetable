# KubeTable Community

KubeTable Community is a local-first desktop client for working with databases running inside Kubernetes.

It reads your kubeconfig, discovers database services, opens local port-forwards, and gives you a query workspace without switching between `kubectl port-forward`, terminal tabs, and separate database tools.

## Supported Databases

- PostgreSQL
- MySQL
- Redis
- MongoDB
- CockroachDB

## Features

- Kubernetes service discovery from local kubeconfig files
- Local port-forward lifecycle management
- Query editor with persistent local drafts
- Schema explorer for relational databases and key/collection-style databases
- Result table with filtering, sorting, pagination, row editing, and CSV/JSON export
- SQL formatting, query history, and saved queries
- Read-only connection mode for safer inspection
- Local cluster source management
- Database deploy assistant for test and development clusters
- Test manifests for PostgreSQL, MySQL, Redis, and MongoDB

## Privacy And Security

KubeTable Community is designed to run locally:

- no account required
- no hosted telemetry client
- no external service dependency for the core desktop workflow

The app can still touch sensitive local data: kubeconfigs, cluster metadata, database credentials, SQL text, and query results. Do not put real kubeconfigs, credentials, tokens, private keys, production URLs, query results, screenshots with secrets, or verbose logs in issues or pull requests.

Read [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) before changing code that handles kubeconfigs, credentials, query execution, logging, storage, or network behavior.

## Extension Points

The public app exposes a small plugin host for downstream builds:

```tsx
import App from "./App";

export default function Root() {
  return <App plugins={[]} />;
}
```

Plugins can add app-level integrations such as telemetry adapters, command-palette actions, topbar actions, and cluster-manager sections without changing Community source code. Keep concrete hosted integrations, release infrastructure, and service-specific credentials outside this repository.

## Requirements

- Bun
- Rust stable
- Platform dependencies required by Tauri
- `kubectl` access to any cluster you want to inspect

For Tauri platform setup, use the official Tauri prerequisites for your operating system.

## Quick Start

Install dependencies:

```sh
bun install
```

Run the frontend in development mode:

```sh
bun run dev
```

Run the desktop app:

```sh
bun run tauri dev
```

Build the frontend:

```sh
bun run build
```

Check the Rust backend:

```sh
cd src-tauri
cargo check
```

Build a desktop bundle:

```sh
bun run tauri build
```

## Test Cluster

The `test/` directory contains a small Kubernetes test environment with sample PostgreSQL, MySQL, Redis, and MongoDB services.

Apply it to your current cluster:

```sh
kubectl apply -f test/kubetable-test.yaml
```

Remove it again:

```sh
kubectl delete -f test/kubetable-test.yaml
```

There is also a helper script:

```sh
./test/kubetable-test.sh up
./test/kubetable-test.sh status
./test/kubetable-test.sh down
```

Use only local or disposable clusters for test data.

## Repository Layout

```txt
src/                         React desktop UI
src/App.tsx                  App shell and plugin host
src/lib/plugins.ts           Neutral plugin interfaces
src/lib/tauri.ts             Frontend bindings for Tauri commands
src-tauri/                   Tauri app and Rust backend
src-tauri/src/discovery/     Kubernetes discovery and credential detection
src-tauri/src/portforward/   Local tunnel management
src-tauri/src/adapters/      Database adapters
test/                        Kubernetes test environment
docs/                        Security model and release notes
```

## Development Notes

Keep Community local-first. Pull requests should not add secrets, hidden endpoints, real credentials, or service integrations that require external infrastructure for the desktop workflow.

Before opening a pull request:

```sh
bun run build
cd src-tauri
cargo check
```

If your change affects kubeconfig parsing, credential detection, query execution, local storage, logs, or network behavior, include a short security note in the pull request.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

Security reports should follow [SECURITY.md](SECURITY.md). Please do not disclose vulnerabilities in public issues before maintainers have had a chance to review them.

## License

KubeTable Community is licensed under Apache-2.0. See [LICENSE](LICENSE).
