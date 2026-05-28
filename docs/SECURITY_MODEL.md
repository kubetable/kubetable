# Security Model

KubeTable Community is a local desktop app. It is useful because it can reach sensitive systems:
Kubernetes clusters and the databases running inside them. The public repository should make that
boundary obvious.

## Local Data

The app may read:

- kubeconfig files selected by the user
- Kubernetes Services, Pods, Secrets, and ConfigMaps needed for database discovery
- database credentials entered by the user or detected from cluster resources
- SQL and database command text entered by the user
- query results returned from local port-forwards

The app stores local UI state, saved queries, query history, and cluster source metadata on the
user's machine. It does not require a hosted account.

## Network Behavior

Community features should be local-first:

- no hosted account requirement
- no hosted telemetry endpoint
- no external service dependency for the core desktop workflow

The app opens local port-forwards to Kubernetes services through the user's kubeconfig and RBAC
permissions. Any new network call should be treated as security-sensitive and documented in the pull
request that introduces it.

## Kubeconfig Handling

Kubeconfigs can contain credentials and executable auth plugins. Do not add real kubeconfigs to the
repository, issues, pull requests, screenshots, or test fixtures.

When changing kubeconfig parsing or storage:

- reject unexpected executable behavior where possible
- avoid logging raw kubeconfig content
- avoid persisting credentials unless the user explicitly chooses that behavior
- keep test fixtures synthetic

## Database Access

Database credentials and query results are sensitive. Do not log passwords, connection strings, query
results, or full error payloads that may contain secrets.

When changing query execution or result rendering:

- keep credential values out of React state where possible
- redact secrets from errors before displaying or logging them
- avoid sending query text or results to any remote service from Community code

## Public Repository Boundary

The following do not belong in this public repo:

- hosted account clients
- telemetry clients
- hidden service URLs
- real cluster credentials
- production environment variable names
- private release or signing infrastructure

Downstream builds can compose integrations through the plugin host without adding those concrete
services to this repository.
