# Contributing to DBTool

Thanks for your interest in DBTool. Bug reports, feature requests and pull requests are all
welcome.

---

## Contributor License Agreement (required)

DBTool is **dual-licensed** — AGPL-3.0 for open source use, and a commercial license for
closed-source use. To be able to offer both, the project needs the rights to your
contribution under both licenses.

**By submitting a pull request you agree to the [Contributor License Agreement](CLA.md).**
Please read it before you start work — it is short. In your first pull request, add the
following line to the description:

```
I have read and agree to the CLA in CLA.md.
```

If you cannot agree to the CLA, you are still very welcome to open issues and take part in
discussions.

---

## Ways to contribute

| | |
|---|---|
| 🐛 **Report a bug** | [Open an issue](https://github.com/achi777/db-tool/issues) — see the checklist below |
| 💡 **Suggest a feature** | Open an issue describing the problem you are trying to solve, not only the solution you have in mind |
| 🗄️ **Add or improve a database engine** | See *Adding a new database engine* in [DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md) |
| 📖 **Improve documentation** | Docs fixes are as welcome as code |
| 🌍 **Test on your platform / engine version** | Confirmed pass or fail reports on versions not yet in [COMPATIBILITY.md](COMPATIBILITY.md) are genuinely useful |

⚠️ **Do not report security vulnerabilities in a public issue.** Follow
[SECURITY.md](SECURITY.md) instead.

---

## Reporting a bug

A good report contains:

1. **DBTool version** and how you installed it (installer / portable / dmg / AppImage /
   built from source)
2. **OS and version** (e.g. Windows 11 24H2, macOS 15.3 arm64, Ubuntu 24.04)
3. **Database engine and version** (e.g. PostgreSQL 16.2, SQL Server 2022, Oracle 19c Thin)
4. **Steps to reproduce** — numbered, starting from a fresh launch
5. **What you expected** vs **what actually happened**
6. **Screenshot** if it is a UI issue, and the error text verbatim if there was one

🔴 **Never paste real credentials, hostnames, connection strings or production data** into an
issue. Redact them or reproduce against a throwaway database.

---

## Development setup

**Prerequisites:** Node.js 20+ and npm. Native modules ship as prebuilt binaries, so a C++
toolchain is normally not required.

```bash
git clone https://github.com/achi777/db-tool.git
cd db-tool
npm install
npm run dev
```

To exercise a change you will need databases to point at. Docker is the easiest route — for
example:

```bash
docker run -d --name pg    -e POSTGRES_PASSWORD=devpw   -p 5432:5432 postgres:16
docker run -d --name mysql -e MYSQL_ROOT_PASSWORD=devpw -p 3306:3306 mysql:8.0
```

SQLite needs no server at all — just point a connection at a new file path.

Full details, including how the IPC layer, the driver interface and packaging work, are in
**[DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md)** and **[ARCHITECTURE.md](ARCHITECTURE.md)**.
Please read both before a non-trivial change.

---

## Pull request checklist

Before you open a PR:

- [ ] `npm run typecheck` passes (both the node and web projects)
- [ ] `npm run build` succeeds
- [ ] The smoke test passes (see *Testing* in the developer guide)
- [ ] You manually verified the change against **every engine it touches**, not only one
- [ ] New source files carry the SPDX header (below)
- [ ] No credentials, absolute local paths, personal machine details or generated files are committed
- [ ] The PR description says what problem it solves and how you tested it
- [ ] First-time contributors: the CLA line is in the description

Keep pull requests focused. One logical change per PR reviews far faster than a large mixed
one; if a change is big, open an issue first so we can agree on the approach before you
invest the time.

---

## Non-negotiable rules

These come from the security model — a PR that breaks one of them cannot be merged:

1. **No database driver, credential or connection object may reach the renderer process.**
   All database work happens in main; the renderer talks only to the whitelisted, typed
   `contextBridge` API in the preload.
2. **Never build SQL by string concatenation from user input.** Every value goes through
   bound parameters; identifiers come from the schema catalog and are quoted per dialect.
3. **Never log, persist or transmit a plaintext password.** Passwords are encrypted at rest
   with Electron `safeStorage` and decrypted only in main, at connect time.
4. **Destructive operations must be confirmed** and must show the exact SQL that will run.
5. **Do not disable** `contextIsolation`, `sandbox`, or the renderer CSP, and do not enable
   `nodeIntegration`.

---

## Code style

- **TypeScript, strict mode**, everywhere — no `any` escapes without a comment explaining why
- Types and IPC channel names shared between processes live in `src/shared/types.ts`
- Match the style of the surrounding file; keep comments to what is not obvious from the code
- No new runtime dependency without a note in the PR explaining why it is worth the bundle
  size and the audit surface
- Commit messages: a short imperative summary line, then detail if needed

Add this header to the top of every new source file:

```ts
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Archil Odishelidze / CodeMake
```

---

## Licensing of contributions

Your contribution is licensed under **AGPL-3.0-only** as part of DBTool, and — under the
[CLA](CLA.md) — may also be included in commercially licensed builds. You retain the
copyright to your work.

## Code of conduct

Be respectful and constructive. Assume good faith, critique the code and not the person, and
keep discussion on the technical merits. Behaviour that makes others unwelcome — harassment,
personal attacks, discriminatory language — is not acceptable and will result in the
contributor being blocked.

Report conduct concerns privately to **archil.odishelidze@gmail.com**.
