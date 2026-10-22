# Changelog

All notable changes to Vercio are listed here. Versions follow [semantic versioning](https://semver.org).

## [Unreleased]

## [0.2.2] - 2026-10-22

### Added

- A project with a site address and a single open port shows the full route (address → server port → service) in its « Ports ouverts » card.
- Settings → « Pour les nerds »: version, uptime, Node.js, Vercio database (server, connection, latency, size, migrations), Docker, Vercio container and mounts, with a JSON copy for support requests.
- Vercio backup card: status at a glance (protected or not, last and next backup, destination), settings behind a « Réglages » button.
- Deployment history: past deployments of the latest build show the commit (or version tag) they deployed; the current one shows the followed tag (`prod`) with its commit.
- New versions are announced at the bottom of the sidebar; administrators update Vercio in one click (backup first, automatic return to the previous version if the new one does not start).
- Several authenticator apps per account: list, add and remove them from the account menu (at least one is kept; the current password is asked).
- Project page: the main buttons follow the environment state (Deploy, Start, Update, Restart, Stop).
- « Connect to another project »: a service of another project (its database, for example) becomes reachable by name in one step; running containers are connected at once.
- Open ports to the outside from the project page (« Ports ouverts »): server port → service port, TCP or UDP, applied at the next deployment, with conflict checks between environments.
- « Site temporarily unavailable » page instead of a 502 while a service restarts: optional on ports opened from Vercio (a small nginx relay keeps the port), and always on zero-downtime relays.
- Version picker: when the CI does not push the expected tags, Vercio suggests the right tag convention and applies it in one click.
- Terminal: when the connection is refused, the actual cause is shown (role, PUBLIC_URL mismatch, reverse proxy without WebSockets).

### Fixed

- Restoring a Vercio backup made by an older version works: the database is emptied first (in the same transaction), then upgraded at restart. The manual restore steps are updated the same way.
- Version choices are no longer served from cache right after the tag convention changes.
- Pages refresh by themselves: after any action, the data shown everywhere is reloaded, as well as when coming back to the tab; project pages and backup lists also pick up what happens in the background.
- Folder backup destinations show where they are on the server, with a warning when the folder is only inside the Vercio container.
- The deployment history of a project is refreshed when a deployment starts and ends, and picks up deployments started elsewhere (webhook).
- Compose files using YAML merge keys (`<<: *common`) are read like Docker Compose does: a service whose image comes from an anchor is no longer reported as having no image.
- `OIDC_ROLES_CLAIMS` is now passed to the container by `docker-compose.yml`.
- README: installation without curl, missing settings, custom certificate authority for SSO.

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
