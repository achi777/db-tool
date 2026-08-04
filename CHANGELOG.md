# Changelog

All notable changes to DBTool are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Changed

- **Project restructured into a single cross-platform repository.** DBTool was previously
  published as three per-platform repositories (`sqlTools`, `sqlTools-mac`,
  `sqlTools-linux`) whose `src/` trees were byte-identical. They are merged into
  [`achi777/db-tool`](https://github.com/achi777/db-tool), with one `electron-builder`
  configuration covering Windows, macOS and Linux.
- Project moved to the repository root — it was previously nested under `db-tool/`.
- `package.json` version aligned to `0.3.0` (it had lagged at `0.1.0`), and
  `repository`, `bugs` and `keywords` metadata added.
- **Application icon replaced.** The generated placeholder is gone; `build/icon.png`
  (1024×1024) and `build/icon.ico` (16 · 24 · 32 · 48 · 64 · 128 · 256) now carry a
  properly rendered stacked-disk mark on a rounded-square gradient. `build/make_icon.py`
  regenerates both (requires Pillow).

### Added

- User-facing `README.md` with screenshots, downloads, a feature overview, the supported
  database matrix, and build instructions.
- `CONTRIBUTING.md` — contribution workflow, the CLA requirement, PR checklist, and the
  non-negotiable rules derived from the security model.
- `SECURITY.md` — private vulnerability disclosure process, the security model, and an
  explicit out-of-scope list.
- `CHANGELOG.md` — this file.

---

## [1.0.0] — 2026-08-05

### Changed

- Consolidated the three per-platform repositories into a single cross-platform repository
- Releases for Windows, macOS and Linux are now built and published from one tag

---

## [0.3.0] — 2026-07-23

**First public release.** Binaries for all three platforms are published on the
[legacy per-platform release pages](https://github.com/achi777/db-tool#-download);
future releases will be published on this repository.

### Added

**Engines**

- **Microsoft SQL Server** as a first-class engine (`node-mssql`) — tree, browsing,
  pagination, autocomplete, all filter modes, grid CRUD by `IDENTITY` primary key, indexes,
  triggers (`AFTER`/`INSTEAD OF`), functions & procedures (`CREATE OR ALTER`), import/export
  with `IDENTITY_INSERT` / `N''` unicode / `GO` batching, and ER diagrams. SQL or Windows
  Authentication, plus `encrypt` / `trustServerCertificate` toggles.
- **Oracle** as a first-class engine (`node-oracledb`, Thin and Thick with Instant Client
  detection) — sequences (with a detail view), triggers, indexes, functions, procedures and
  packages, views, SQL export with real Oracle types and `TO_TIMESTAMP` dates, FK
  introspection and ER diagrams, and all schemas visible in the tree.
- **MariaDB** as a first-class engine, reusing the MySQL driver and adding standalone
  sequences.
- **PostgreSQL advanced objects** — materialized views (create / refresh incl.
  `CONCURRENTLY` / browse / drop), user-defined types and enums (create, add and rename
  values, drop), extensions (list installed and available, create / update / drop), and
  advanced indexes (`btree` / `hash` / `gin` / `gist` / `brin`, partial `WHERE`,
  expression). User-defined types are also selectable in the table designer.

**Features**

- **Cross-engine data transfer** — copy tables from any supported engine to any other.
- **Saved filters** — name and reuse a filter per table, keyed by `engine::schema::table`
  and persisted across restarts.
- **Dark / light theme** with a manual toggle, persisted and applied everywhere (tree, grid,
  editor, ER diagram, dialogs).
- **Keyboard shortcuts** across the app, with an **F1** reference modal.
- **Native application menu bar.**
- **Database dump / restore** to and from SQL files, wired into the context menus.
- **About dialog** and app-wide icons; icon-only grid toolbar and connection dialog buttons
  with tooltips.
- **Multi-version compatibility testing** against PostgreSQL 13–16 and MySQL 5.7 / 8.0,
  documented in `COMPATIBILITY.md`.

### Changed

- **Filter UX overhaul** — consolidated to exactly two filter surfaces (structured
  per-column filters combined with the funnel builder tree, and an exclusive Custom `WHERE`
  mode), removing the earlier duplicate "Quick"/"Builder" buttons and the separate
  "Edit builder…" modal with no loss of capability.
- Connection form: SQL Server certificate and encryption labels shortened, with the
  explanation moved into a tooltip.

### Fixed

- **Refresh schema** now genuinely reloads both the object tree and the autocomplete
  catalog, and auto-refreshes after a drop or a data transfer.
- Data transfer: binary and timezone-aware timestamp handling corrected.
- Oracle date import and a MySQL `CALL` crash in the import/export path.
- View builder: node dragging and connection handles fixed via `applyNodeChanges`.
- View builder alias handling and filter-panel display quoting.

### Security

- **Connection passwords are now encrypted at rest** with Electron `safeStorage`, backed by
  the OS keychain (DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux). The
  plaintext password is decrypted only in the main process at connect time; it is never
  written to disk, never sent to the renderer, and never logged.
  - Legacy plaintext passwords are migrated in place on first launch. The connections file
    is backed up first (`connections.json.bak-<timestamp>`) and the migration is idempotent.
  - If `safeStorage.isEncryptionAvailable()` is false, the app does **not** silently store
    plaintext — it warns in the connection form and does not persist the password.

### Known issues

- The published `v0.3.0` binaries are named `DBTool-0.1.0-*` because `package.json` still
  carried version `0.1.0` when they were built. The version has since been corrected; the
  next release will be named consistently.
- `build/icon.ico` is a generated placeholder rather than a designed application icon.
- Windows builds are unsigned — SmartScreen may warn on first launch. macOS builds are
  signed and notarized.

---

## Earlier development

Versions `0.1.0` and `0.2.0` were never published; development between **2026-07-21** and
**2026-07-23** built the foundation that `0.3.0` was cut from:

- Electron + React + TypeScript shell with a single `DbDriver` interface behind which every
  engine sits, and a strict main/renderer process split
- PostgreSQL, MySQL and SQLite engines
- Object tree, multi-tab SQL editor with schema-aware autocomplete, and query history
- Server-side pagination with click-to-sort, per-column filters, and a nested AND/OR visual
  filter builder
- Full in-grid CRUD applied in a single transaction
- Visual table designer with a live DDL preview and a per-engine type system
- Views, functions and procedures management
- Drag-and-drop visual view builder, ER diagrams
- Import / export (CSV, JSON, Excel, SQL)
- Packaging with electron-builder for all three platforms

---

[Unreleased]: https://github.com/achi777/db-tool/commits/main
[0.3.0]: https://github.com/achi777/sqlTools/releases/tag/v0.3.0
