# AGENTS.md

Guidance for coding agents (Codex, and anything else that reads `AGENTS.md`) working in this
repository.

**Read [`CLAUDE.md`](CLAUDE.md).** It applies to you unchanged: it is the rules for this
repository, and it ends with a table saying which [`docs/reference/`](docs/reference/) file to
read before touching what. [`docs/README.md`](docs/README.md) is the full index.

The `Claude` references throughout are FACTUAL, not addressed at the reader — they name Claude
Code's own hook scripts, its `~/.claude/` directories, its `Claude Code-credentials` keychain
item, and the on-screen labels this firmware draws. They are not instructions about who is
reading. **Do not rename them** — a past search-and-replace over this file did exactly that and
pointed every path at a directory that does not exist.

---

**This file used to be a 2,325-line verbatim copy of CLAUDE.md**, with a header saying "update
the two together". That did not happen: CLAUDE.md reached 6,639 lines while this stayed at
2,325, so it was roughly 4,300 lines stale — and a stale copy is worse than a pointer, because
a reader cannot tell which half is current. A pointer cannot drift.

Three of the claims it was still serving are ones CLAUDE.md had already corrected in place: that
BLE writes await a response on each chunk (they do not — `withoutResponse`), that `feedChar`'s
guard counts *characters* (it counts BYTES), and a text-lane width that had been re-derived. So
the copy was not merely behind; it was teaching agents things this repo had measured to be
false.
