# Six database engines, one GUI: everything that quietly disagrees

*Notes from building [DBTool](https://github.com/achi777/db-tool), a desktop client for
PostgreSQL, MySQL, MariaDB, SQLite, Oracle and SQL Server.*

---

I spent the last few months building a desktop database client that speaks
PostgreSQL, MySQL, MariaDB, SQLite, Oracle and SQL Server. I expected the hard
part to be the UI. It was not. The hard part was that these six engines agree on
far less than the shared "SQL" label suggests, and almost every disagreement is
silent — the query runs, returns rows, and gives you the wrong ones.

Here is the list I wish I had at the start.

## 1. Identifier case folding will find you eventually

Write `SELECT * FROM Users` and each engine hears something different:

- **PostgreSQL** folds unquoted identifiers to **lower**case → `users`
- **Oracle** folds to **UPPER**case → `USERS`
- **MySQL** depends on `lower_case_table_names`, which depends on the filesystem —
  case-sensitive on Linux, insensitive on macOS and Windows by default
- **SQL Server** depends on the database collation

This matters the moment a client stores an identifier as the user typed it. You
read a table name out of `information_schema` as `USERS`, the user typed `Users`,
you build `SELECT * FROM "Users"` with quotes to be safe — and now the query
cannot find a table that is sitting right there.

The rule that worked: **never store a display name and a query name in the same
field.** Read identifiers from the catalog, keep them exactly as the catalog
returns them, and quote them on every generated statement. What you show in the
tree can be prettified; what you put in a query cannot.

## 2. `LIMIT`/`OFFSET` is not portable, and pagination depends on it

If you want real server-side pagination — and you do, because loading a 40M-row
table into a grid is not a strategy — you write this four separate times:

```sql
-- PostgreSQL, MySQL, MariaDB, SQLite
SELECT * FROM orders ORDER BY id LIMIT 100 OFFSET 200;

-- SQL Server 2012+
SELECT * FROM orders ORDER BY id OFFSET 200 ROWS FETCH NEXT 100 ROWS ONLY;

-- Oracle 12c+
SELECT * FROM orders ORDER BY id OFFSET 200 ROWS FETCH FIRST 100 ROWS ONLY;

-- Oracle 11g and earlier
SELECT * FROM (
  SELECT t.*, ROWNUM rn FROM (
    SELECT * FROM orders ORDER BY id
  ) t WHERE ROWNUM <= 300
) WHERE rn > 200;
```

Two things bite here. First, **SQL Server and Oracle both require `ORDER BY`** for
`OFFSET` — there is no unordered paging. So a client that lets you page an
unsorted table has to invent an ordering, and the only defensible one is the
primary key. Second, that Oracle 11g nested form is not equivalent under
concurrent writes: it materializes differently, and rows can appear twice across
pages. Worth knowing before you promise stable pagination.

## 3. NULL sort order splits the field in half

```sql
SELECT * FROM users ORDER BY last_login ASC;
```

- **PostgreSQL, Oracle:** NULLs **last**
- **MySQL, MariaDB, SQLite, SQL Server:** NULLs **first**

Same query, same data, different first row. `NULLS FIRST`/`NULLS LAST` fixes it —
on PostgreSQL, Oracle and SQLite 3.30+. MySQL and SQL Server do not have the
syntax at all, so you emulate it:

```sql
-- MySQL: NULLs last on an ascending sort
ORDER BY (last_login IS NULL), last_login ASC;

-- SQL Server
ORDER BY CASE WHEN last_login IS NULL THEN 1 ELSE 0 END, last_login ASC;
```

If your GUI clicks a column header and sorts, it has already made this decision on
your behalf. Most do not tell you which way.

## 4. Editing a stored routine is three different operations

- **PostgreSQL:** `CREATE OR REPLACE FUNCTION` — atomic, done
- **SQL Server:** `CREATE OR ALTER PROCEDURE` (2016 SP1+) — atomic, done
- **MySQL, MariaDB:** neither exists. Editing means `DROP` then `CREATE`

That last one is a genuine hazard. If the `CREATE` fails on a syntax error, the
old routine is already gone and anything calling it starts failing in production.
The only safe form wraps both in a transaction — and you have to know in advance
that MySQL DDL is not transactional in the way you might hope, so you also keep
the old definition in memory to restore from.

This is exactly the kind of thing a GUI should absorb so you never think about it.

## 5. Foreign keys are not the same feature

**Oracle has no `ON UPDATE` clause.** Not "it behaves differently" — the syntax
does not exist. A generic schema designer that offers an `ON UPDATE CASCADE`
dropdown for every engine will happily generate DDL that Oracle rejects.

Meanwhile SQLite enforces foreign keys **only if** `PRAGMA foreign_keys = ON`,
which defaults to **off** for backwards compatibility, and is per-connection, not
per-database. A schema full of foreign key constraints that silently enforces none
of them is a very common surprise.

## 6. Type systems diverge more than the docs admit

| Concept | PostgreSQL | MySQL | Oracle | SQL Server |
|---|---|---|---|---|
| Boolean | `boolean` | `TINYINT(1)` | `NUMBER(1)` | `BIT` |
| Auto-increment | `SERIAL` / `IDENTITY` | `AUTO_INCREMENT` | `IDENTITY` (12c+) / sequence | `IDENTITY` |
| Text, unbounded | `text` | `LONGTEXT` | `CLOB` | `VARCHAR(MAX)` |
| Timestamp + zone | `timestamptz` | ⚠️ none | `TIMESTAMP WITH TIME ZONE` | `DATETIMEOFFSET` |
| Array | `int[]` | ⚠️ none | ⚠️ VARRAY (not comparable) | ⚠️ none |
| JSON | `jsonb` (indexed) | `JSON` | `JSON` (21c+) | `NVARCHAR` + functions |

The one that causes real data loss is **MySQL's lack of a timezone-aware type**.
`TIMESTAMP` stores UTC and converts using the *session* timezone; `DATETIME`
stores no zone at all. Move a table from Postgres `timestamptz` to MySQL and the
zone information is gone — not converted, gone. A cross-engine transfer feature
has to say this out loud rather than quietly picking one.

## 7. `information_schema` is a suggestion

Everyone claims to implement it. In practice:

- **Oracle does not have it at all.** You query `ALL_TABLES`, `ALL_TAB_COLUMNS`,
  `ALL_CONSTRAINTS` — a completely separate dictionary with different column names
- **SQLite** has no catalog views either; you use `PRAGMA table_info(t)`,
  `PRAGMA foreign_key_list(t)` and parse `sqlite_master`
- **PostgreSQL** has it, but anything interesting — index types, extensions,
  materialized views — lives in `pg_catalog` instead
- **MySQL and SQL Server** implement it most faithfully, and still disagree on
  what `information_schema.columns.column_default` returns for an expression
  default

So "just use `information_schema`" gets you about a third of the way, and the
remaining two thirds is per-engine code. There is no shortcut here.

## 8. What this adds up to

An abstraction layer over six engines is mostly not abstraction. It is a
per-engine dialect module with a shared interface, plus a compatibility matrix you
maintain by hand, plus a discipline of **never generating SQL you have not tested
against that specific engine version**.

I ended up writing all of this down as a `COMPATIBILITY.md` — a feature × engine ×
version table with the caveats attached — because the knowledge does not survive in
your head. If you are building anything cross-engine, write that document on day
one, not day ninety.

---

The client is **DBTool** — free, open source (AGPL-3.0), and running on Windows,
macOS and Linux. It covers PostgreSQL, MySQL, MariaDB, SQLite, Oracle and SQL
Server, with server-side pagination, a drag-to-join visual query builder, a visual
table designer with live DDL, and ER diagrams. No account, no telemetry, nothing
leaves your machine.

**Repo:** https://github.com/achi777/db-tool
**Downloads:** https://codemake.co/software

If you know a cross-engine divergence I have not hit yet, I would genuinely like
to hear it — that list is never finished.
