# Security Policy

DBTool is a desktop database client. It handles **database credentials** and executes
**arbitrary SQL** against systems you own. Security issues in it are taken seriously.

---

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, pull requests
or discussions.**

Report privately by email to:

> **archil.odishelidze@gmail.com**
>
> Subject: `[DBTool Security] <short description>`

If [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
is enabled on the repository, you may use that instead — it is equally private and keeps
everything in one place.

### What to include

The more of this you can provide, the faster the fix:

- The **type of issue** (e.g. SQL injection, credential exposure, insecure IPC, RCE via a
  crafted schema object, path traversal on import/export)
- **Affected version** and platform (Windows / macOS / Linux)
- **Full paths of the source files** involved, if you have them
- **Step-by-step reproduction instructions**, including any special configuration
- **Proof-of-concept** code, a crafted file, or a schema/DDL snippet, if one exists
- The **impact**: what an attacker gains, and what access they need to start with

🔴 Please redact real credentials, hostnames and production data from your report.

### What to expect

DBTool is maintained by a single developer, so response is best-effort rather than
contractual:

| Stage | Target |
|---|---|
| Acknowledgement that the report was received | within **3 business days** |
| Initial assessment (valid / not valid, rough severity) | within **10 business days** |
| Fix released, or a status update with a timeline | depends on severity and complexity |

You will be kept informed as the report progresses. If you do not hear back within
10 business days, please send a follow-up — the mail may have been missed.

### Coordinated disclosure

Please give a reasonable window to ship a fix before disclosing publicly — **90 days** is the
default expectation, shorter if a fix ships sooner, longer only by mutual agreement.

Reporters are **credited by name in the release notes and the advisory** unless they ask to
remain anonymous. There is no bug bounty programme.

---

## Supported versions

Only the **[latest release](https://github.com/achi777/db-tool/releases/latest)** receives
security fixes, on all three platforms. Older releases receive no backported fixes — please
upgrade before reporting an issue you found on an older build.

---

## Security model

Understanding these boundaries helps distinguish a real vulnerability from intended
behaviour.

### Process isolation

- **All** database drivers, connections, queries and credentials live in the **main
  process**. The renderer never imports `pg`, `mysql2`, `better-sqlite3`, `oracledb` or
  `mssql`, and never receives a raw password.
- Renderer ⇄ main communication goes **only** through a small, whitelisted, typed
  `contextBridge` API exposed in the preload. There is no raw `ipcRenderer` in the UI.
- The application window runs with `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, and a strict Content Security Policy on the renderer HTML.

### Credential storage

- Saved connections are stored as JSON in Electron's `userData` directory — **never in the
  repository**.
- Non-secret fields (host, port, user, database, options) are stored in plaintext.
- **Passwords are encrypted at rest with Electron `safeStorage`**, which is backed by the
  operating system keychain: **DPAPI** on Windows, **Keychain** on macOS,
  **libsecret/kwallet** on Linux.
- The plaintext password is decrypted **only in the main process**, at connect time. It is
  never written to disk, never sent to the renderer, and never logged.
- If `safeStorage.isEncryptionAvailable()` returns false, the app **does not silently fall
  back to plaintext** — it warns in the connection form and does not persist the password.

### SQL safety

- Every user-supplied **value** — in filters, grid edits, inserts, deletes and pagination —
  is passed as a **bound parameter**. SQL is not assembled by string concatenation from user
  input.
- **Identifiers** come from the schema catalog and are quoted per dialect
  (`"pg"`, `` `mysql` ``, `[mssql]`).
- `LIKE` wildcards (`%`, `_`) in filter values are escaped so they match literally.
- Views saved by the visual builder inline literals with proper escaping (`O'Brien` →
  `'O''Brien'`).

### Data that stays local

- **Query history** stores the SQL text and metadata (time, connection, engine, ok/error,
  row count, duration) in a local SQLite file in `userData` — **never result data**.
- **Open query tabs** persist their SQL text and chosen connection — **never result rows**.
- There is **no telemetry, no analytics, no account and no cloud sync**. DBTool makes no
  network connections other than to the databases you configure.

---

## Out of scope

The following are known, intended, or not treated as vulnerabilities in DBTool:

- **You can run destructive SQL.** DBTool is a database client; executing `DROP TABLE`
  because you typed it is the product working as designed. Destructive operations initiated
  from the UI are confirmed and show the exact SQL first.
- **An attacker with your unlocked user session can read your saved connections.**
  `safeStorage` protects data at rest against other users and offline access to the disk, not
  against code already running as you.
- **Windows builds are unsigned.** This is a known, documented limitation (no code-signing
  certificate), not a vulnerability. macOS builds are signed and notarized.
- **Weak or plaintext transport configured by the user** — e.g. connecting with
  `trustServerCertificate: true`, or without TLS. DBTool exposes these switches; choosing an
  insecure setting is the operator's decision.
- **Vulnerabilities in the database servers themselves**, or in Electron/Chromium — report
  those upstream. Reports of an outdated bundled Electron version are, however, welcome.
- Findings from automated scanners with **no demonstrated exploit path** in DBTool.

---

## For users: reducing your own risk

- Connect with a **least-privilege database account**; do not use a superuser for routine
  browsing.
- Prefer **TLS** and leave certificate validation on.
- Download DBTool **only from the [official releases page](https://github.com/achi777/db-tool/releases)**.
- Keep in mind that anyone with access to your unlocked OS session can use your saved
  connections. Lock your machine.
- When sharing screenshots, logs or bug reports, **redact hostnames, usernames and data**.

---

*Thank you for helping keep DBTool and its users safe.*
