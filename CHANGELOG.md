# Changelog

All notable changes to Vercio are listed here. Versions follow [semantic versioning](https://semver.org).

## [Unreleased]

## [0.2.1] - 2026-10-19

First public version of Vercio. (Version 0.2.0 was withdrawn: same content, but its release commit was not signed.)

### Deployment

- Compose projects (from a Git repository or pasted) and single-service projects, with several environments each.
- Deploy by branch, by tag or the latest build; images pinned by digest.
- Automatic rollback when a deployment fails, manual rollback in one click.
- Zero-downtime updates through a relay container, per service.
- Webhooks from GitLab, GitHub or any CI, with signature checks and IP allowlists; Vercio can create them on GitLab and GitHub. Webhooks can be turned off for the whole instance.
- Version locking per environment.
- Import of Compose projects started outside Vercio.

### Operations

- Home page with every project, its containers, health, open ports and resource usage.
- Live deployment log followed by container logs; live logs, statistics, inspection and browser terminal for each container.
- Map of traffic between containers, shared networks and ports exposed to the Internet.
- Alerts on repeated CPU or memory saturation, container failures and low disk space.
- Notifications by email, Microsoft Teams and outgoing webhook.
- Activity feed and audit log with CSV export.

### Backups

- Backups of PostgreSQL, MySQL, MariaDB and MongoDB databases and of Docker volumes, to S3 or a folder.
- Optional encryption (AES-256-GCM), schedules, retention, integrity check before any restore.
- Restore from the interface, for projects and for Vercio itself.

### Security

- Local accounts with mandatory two-factor authentication, three roles, optional SSO with Keycloak (OpenID Connect).
- Secrets encrypted at rest, never sent back by the API.
- Content Security Policy, HSTS over HTTPS, `__Host-` session cookie.
