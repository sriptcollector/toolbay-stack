---
name: setup-browser-cookies
version: 0.1.0
description: Import a logged-in session out of your real Chromium browser and into a headless one, and prove it landed. Every row is censused by encryption scheme, the domain match covers the leading-dot and subdomain forms Chromium actually stores, and a run that recovers zero cookies exits non-zero with a named cause instead of printing "Imported 0 cookies". Use before QA testing anything behind a login, or when an authenticated check is silently seeing the logged-out page.
triggers:
  - import browser cookies
  - import my cookies
  - use my logged in session
  - log the browser in
  - authenticate the browser
  - setup authenticated session
  - qa the logged in page
  - it keeps showing the login page
  - why am i logged out
provides:
  - browser-cookie-import
  - session-auth-verification
  - cookie-encryption-diagnosis
platforms:
  - win32
  - darwin
  - linux
cost: low
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

# setup-browser-cookies

Toolbay Stack, Copyright (c) 2026 Toolbay. MIT.

DERIVED WORK. The command and its contract come from `setup-browser-cookies`
and `browse/src/cookie-import-browser.ts` in
[gstack](https://github.com/garrytan/gstack) by Garry Tan (MIT, Copyright (c)
2026 Garry Tan): the command name, importing a real Chromium session into a
headless one, the browser registry and its aliases, the `--domain` / `--profile`
option semantics, the Chromium decryption pipeline, and the idea of falling back
to CDP when App-Bound Encryption blocks the database. All of that is kept.
Not affiliated with or endorsed by Garry Tan. See NOTICE.

What is new is that the number is checked. Upstream, an import that recovers
nothing prints `Imported 0 cookies for <domain> from <browser>` and exits 0.
Here, zero is an error with a named cause, and a success line is only printed
after the artifact has been written, re-read from disk, re-parsed, and every
entry re-checked against the domain you asked for.

---

## Do it

```bash
node ~/.claude/skills/setup-browser-cookies/scripts/tb-cookies.mjs browsers
node ~/.claude/skills/setup-browser-cookies/scripts/tb-cookies.mjs scan   --browser chrome --domain toolbay.ai
node ~/.claude/skills/setup-browser-cookies/scripts/tb-cookies.mjs import --browser chrome --domain toolbay.ai --out ./.toolbay/cookies/toolbay.json
```

`import` prints exactly one headline, and it is a count taken off the file:

```
13 cookies for domain perplexity.ai imported
  route:    db
  hosts:    .perplexity.ai, .www.perplexity.ai, www.perplexity.ai
  names:    cf_clearance, comet_browser, pplx.edge-vid, ... +7 more
  file:     ...\pplx.json
  verified: re-read from disk, 13 entries, every one non-empty and matching ...
```

Then load it into the headless session:

```bash
browse cookie-import "./.toolbay/cookies/toolbay.json"
```

**Never report a page as tested-while-logged-in unless `import` exited 0.**
If it exited non-zero, nothing was written, and the headless session is
anonymous. Say that instead of describing the page.

## Run `scan` first when you do not know what you are dealing with

`scan` counts **every** row by encryption scheme and tells you which route can
read them. It is the difference between "there are no cookies" and "you cannot
read these cookies", which are opposite answers that look identical downstream.

```
Chrome / Default   C:\Users\...\Default\Network\Cookies
  1293 cookies across 397 hosts
  encryption (every row, not a sample): v20=1293

  host_key = "netlify.com", ".netlify.com", or any subdomain of "netlify.com"
    matched 13 rows across 3 hosts: v20=13
    host_key "netlify.com": 0 rows
    host_key ".netlify.com": 8 rows
    NOTE: an exact host_key match on "netlify.com" would return 0 rows here.

  route: cdp
```

## The three things this fixes

**1. Chromium stores domain cookies with a leading dot, and the upstream CLI
matches the host exactly.** `cookie-import-browser.ts:267` builds
`WHERE host_key IN (?)` with one exact string. On this machine 211 of 397 hosts
in Chrome start with `.`. Measured against the same two real profiles:

```
Comet  --domain perplexity.ai   (97 cookies in the profile)
  gstack  WHERE host_key IN ('perplexity.ai')  -> 0 rows
  TBS     host-only | dotted | subdomain       -> 19 rows

Chrome --domain netlify.com     (1293 cookies in the profile)
  gstack  WHERE host_key IN ('netlify.com')    -> 0 rows
  TBS     host-only | dotted | subdomain       -> 13 rows
```

Use `--exact` if you want host-only plus dotted and no subdomains.

**2. Zero rows switches off the App-Bound-Encryption fallback, so the failure
is silent.** `write-commands.ts:709` gates the CDP fallback on
`result.cookies.length === 0 && result.failed > 0`. `failed` only counts rows
that were fetched and then failed to decrypt, so a query that matched nothing
has `failed === 0` and the fallback never runs. The command returns
`Imported 0 cookies for netlify.com from chrome` and exits 0. Here, zero exits 1
and prints which rows matched, what scheme they use, and what to do next.

**3. The v20 detector samples ten rows in insertion order.**
`cookie-import-browser.ts:1034` is `SELECT encrypted_value FROM cookies LIMIT 10`
with no `ORDER BY`, which is oldest-first. A profile that predates Chrome 127
has v10 rows at the front, so it reports "no v20" on a database full of it. The
selftest builds that exact database and asserts both answers.

## What cannot be done, said plainly

Chrome 127+ on Windows encrypts cookies with **App-Bound Encryption (v20)**. The
key is wrapped in a SYSTEM-level DPAPI layer. No unelevated same-user process
can unwrap it, so v20 rows are unreadable from the database by anything this
skill could ship, and it does not pretend otherwise: it counts them, names them,
and exits 1.

The CDP route exists because the browser can decrypt its own cookies. Measured
on Chrome 151.0.7922.138, Windows 11, 2026-08-13, it is now blocked too:

- launching with `--remote-debugging-port` against the default profile gets
  `DevTools remote debugging requires a non-default data directory`, and the
  port never opens (gstack reports this as a bare 15-second timeout);
- mirroring the profile to a scratch directory opens the port fine and then
  returns **0 of 1293 cookies**, because the App-Bound key does not validate
  outside its original path.

Both were tried. Neither is offered as a route, because a route that returns an
empty list is indistinguishable from a profile with no cookies.

So on a current Chrome profile the honest options are:

- import from a browser whose profile is still v10 (`doctor` will tell you which
  ones those are: on this machine Comet is `v10=97`, Chrome and Edge are v20),
- or drive the real browser directly over a debug port you started yourself,
  instead of copying its cookies at all.

## Everything it can tell you about this machine

```bash
node ~/.claude/skills/setup-browser-cookies/scripts/tb-cookies.mjs doctor
```

```
  node:sqlite            available
  WebSocket (for CDP)    available
  powershell (for DPAPI) available

  Chrome    1 profile(s)   exe: C:\Program Files\Google\Chrome\Application\chrome.exe
      Default      1293 cookies  v20=1293  -> route cdp
  Edge      1 profile(s)   exe: C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
      Default        88 cookies  v20=88    -> route cdp
  Comet     1 profile(s)   exe: C:\Users\...\Perplexity\Comet\Application\comet.exe
      Default        97 cookies  v10=97    -> route db
```

## Prove the engine still works

```bash
node ~/.claude/skills/setup-browser-cookies/scripts/tb-cookies.mjs selftest
```

47 assertions, non-zero exit on any failure. It builds real fixture databases
including deliberately broken ones (a dotted-host-only profile, a mixed v10/v20
profile, an all-v20 profile, a zero-byte file, a SQLite file with no `cookies`
table, a non-SQLite file, expired rows, blank-valued rows) and asserts that each
one either imports the right number or exits non-zero and writes nothing. Two of
the assertions run gstack's own SQL on the same fixture, so the comparison above
is a test rather than a claim.

## Options

| flag | meaning |
| --- | --- |
| `--browser` | `chrome`, `edge`, `brave`, `chromium`, `comet`, `arc`, `opera`, `vivaldi` |
| `--profile` | profile directory, default `Default`. Validated, not interpolated. |
| `--domain` | a hostname or a URL. Matches host-only, dotted and subdomain forms. |
| `--exact` | drop subdomain matching |
| `--route` | `auto` (default), `db`, `cdp` |
| `--out` | artifact path, default `./.toolbay/cookies/<domain>.json` |
| `--min` | fail unless at least N cookies land. Default 1. |
| `--include-expired` | keep already-expired rows (they will not authenticate anything) |
| `--db` | read a specific cookie database file instead of resolving a profile |

## Notes

- Node only. No bash preamble, no bun, no `open`, no `/tmp`, no `date +%s`.
  Runs the same from PowerShell and from Git Bash. Needs Node 22.5+ for
  `node:sqlite`; `doctor` says so if it is missing rather than returning zero
  rows.
- The database is always copied before reading, so a running browser does not
  block it, and the copy is opened read-write so a WAL can be replayed.
- macOS asks for Keychain permission on the first import per browser. A denied
  dialog is an error here, not an empty result.
- On Linux, v11 cookies need `secret-tool`. If it is unavailable, v11 rows are
  reported as unrecovered rather than quietly skipped.
- The artifact contains real session cookies. It is written where you point
  `--out`; treat it like a password file and delete it when the QA run is done.
- Only names and counts are ever printed. Cookie values never reach the
  transcript.
