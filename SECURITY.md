# Security

KubeTable Community handles local kubeconfigs, Kubernetes metadata, database credentials, SQL queries,
and query results. Treat security issues as sensitive.

## Supported Versions

Security fixes are accepted for the current `main` branch and the latest published Community release.

## Reporting A Vulnerability

Please do not open a public issue for a vulnerability.

Use GitHub private vulnerability reporting if it is enabled for this repository. If it is not enabled yet,
contact the maintainers privately before publishing details.

Useful reports include:

- affected version or commit
- operating system
- reproduction steps
- expected and actual behavior
- impact assessment
- any relevant logs with secrets removed

## Secret Handling

Never include real kubeconfigs, database passwords, cloud tokens, private keys, or production URLs in issues,
pull requests, screenshots, logs, or test fixtures.

See [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) for the project security boundary.
