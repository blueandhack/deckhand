# USAGE per Claude account - design

Date: 2026-10-03. Branch: `usage-per-account`. Status: approved in conversation.

## Problem

`mergeUsage()` (`firmware/deckhand_display/usage.ino`) is built on one assumption, stated in its
own comment: *"Both Macs poll the same account, so the quota is the same number twice - the useful
difference between them is AGE."* The user's two Macs are signed into **different** Claude
accounts. So today:

- AUTO (freshest-wins) shows whichever Mac polled last, so the NOW/WEEK cards swap accounts
  silently at the OAuth poll cadence.
- Board 2's single trend ring (`usageRingPct`, the sparkline and the short-window burn slope) is
  fed from that merged value and interleaves two accounts' series. `USAGE_RING_DROP_PCT` was
  derived for the same-account case (two readings of ONE quota differing only in age), so a
  cross-account swing either clears the ring or reads as a burst.
- The tap cycles AUTO -> Mac A -> Mac B, but the resting state is AUTO, which is the broken view.

There is also a separate, still-open bug in the same code ([`pairing-and-multi-mac.md`](../../reference/pairing-and-multi-mac.md),
"OPEN BUG"): after a synthetic `MULTITEST` link drops, the Claude cards freeze on a wrong reading.

## Goal

Each Claude account gets its own 5-hour and weekly figures, bars, sparkline and burn estimate, and
they never mix. A tap switches which account is on screen. Two Macs on the SAME account still back
each other up exactly as today: freshest reading wins, and a negative age never wins.

## Out of scope

- More than `MAX_LINKS` (2) Macs. The structures are sized by `MAX_LINKS` and follow it if it
  grows.
- Showing several accounts at once (the user chose tap-to-switch over stacked or summary layouts).
- Any change to how a host polls the OAuth endpoint.

## Design

### 1. Host: name the account, without naming the person

- New `host/account-id.mjs`. `accountKey(claudeJson)` returns the first 8 lowercase hex chars of
  `sha256(oauthAccount.accountUuid)`, or `""` when the field is absent, empty or unreadable. The
  raw UUID, the email and the display name **never** go over the wire, because the BLE link is not
  encrypted.
- `host/index.mjs` reads `~/.claude.json` at the OAuth poll cadence (not every 5s tick, since the
  file can be large), caches the key, and publishes `acct` on every payload whenever it is
  non-empty. When there is no key the field is omitted, not sent empty.
- Optional `DECKHAND_ACCOUNT_TAG`: sanitised by the same `macTag()` override path, capped at 6,
  published as `acctTag` only when set. This lets a person name an account ("work") rather than a
  Mac.
- The tick log line gains `acct=<key|?>`, so on-glass checks can compare the device with the host.
- `host/account-id-check.mjs`: hashing is deterministic, lowercase, 8 chars; missing, empty or
  malformed input gives `""`; the output contains no substring of the UUID longer than 8 chars
  (no plaintext leak). It has a `--selftest` that injects a fault and exits 0 only when the fault
  is caught.

### 2. Device: group by account

- `HostLink` gains `acct[12]` and `acctTag[8]`, parsed beside `hostTag`/`hostEmoji` with
  `copyField`.
- **Two links are the same account iff both carry a non-empty `acct` and the two are equal.** A
  link with no `acct` (an old host, or a host that could not read `~/.claude.json`) is its own
  account, keyed by its `hostId`, and is never merged with another Mac on a guess. The cost is
  that two OLD hosts on the same account show as two accounts until updated, which is visible and
  harmless. Merging two different accounts is neither.
- `mergeUsage()` builds a list of distinct accounts in slot order. Within each account it applies
  today's freshest rule (Claude by `quotaAgeSec`, Codex by `cxAgeSec`, negative age never wins)
  into a per-account merged `Usage`. The global `usage` and `usageSourceLink`/`cxSourceLink` are
  then set from the **selected** account only.
- **Selection** is `char usageAcctSel[12]`: the selected account's key (its `acct`, or its
  `hostId` when it has none), stored by identity, not slot index, for the same reason
  `usagePinHostId` was. Empty means the first account in slot order. A selection whose account
  has gone falls back to the first account.
- **Codex is a separate OpenAI account**, so the Codex row reads only from the selected account's
  links and hides (via the existing `usageCodexShown()`) when they have none. The old pin's
  "fall back to any Mac for Codex" is removed: a Codex reading from another Mac shown under the
  "work" account would be the same mix-up this task fixes.
- `usagePinHostId`, AUTO and the N+1-state cycle are removed. `usageCyclePin()` becomes
  `usageCycleAccount()`: it steps to the next account in slot order and wraps, returning false
  (inert) with fewer than two accounts, as the pin cycle did.

### 3. Board 2: one trend ring per account

- The ring state (`usageRingPct`, `usageRingAt`, `Count`, `Head`, `Last`, `WasStale`) becomes a
  struct `UsageRing` with an owner key `acct[12]`, in an array `usageRings[MAX_LINKS]`.
- Every tick, every account present is sampled from ITS OWN merged `Usage` into ITS OWN ring, not
  just the selected one, so switching accounts shows real history immediately. An account's ring
  is claimed by key. When no ring is free, the ring whose owner has no live link is reused, and
  reuse always resets it.
- The sparkline, `usageRingSlope()`, `usageRingSpanMin()`, the caption and the burn verdict read
  the **selected** account's ring.
- `USAGE_RING_DROP_PCT`'s derivation still holds, because it now only ever sees one account's
  series, and its comment says so.
- Board 1 has no ring (`#if BOARD_USAGE_V2`) and takes none of this section.

### 4. The glass

- The card header's right-hand label names the selected account: `acctTag` if set, else the
  source Mac's tag or icon, as today. It shows whenever **more than one account** is present (not
  more than one Mac). With one account, or two Macs on one account, the header is exactly what it
  is today.
- `N/M` beside the label is drawn **only on a board whose geometry proves it fits**: a constant
  in the board header, asserted by `usage-geom-check.mjs` against the widest card label and the
  6-char tag cap. Board 1 is already recorded as not fitting (`usage.ino`'s comment at the tag
  draw: a `1/2` beside a 6-char tag collides at x=170), so there the changing label is the only
  carrier.
- The pinned-vs-auto bar and colour lose their meaning, because there is no AUTO. They are
  removed, not repurposed.
- An account switch can change values without changing the text the caches compare against, and
  a source change moves no digits, so the switch must bust the card caches (`srcCache` and kin ->
  `drawUsageStatic()`), and on board 2 the sparkline and burn caches too. The account key joins
  the existing bust tuple.

### 5. Remote control, for testing

- New verb `USAGEACCT <n>` selects account `n` (0-based, slot order). It is idempotent, so the
  host's double delivery is harmless. It refuses **by name** on a non-numeric or out-of-range `n`
  (quoting the range), on USAGE not being the live tab, and on a full-screen surface being up. It
  reports the account now selected (key and label). It exists on both boards, so
  `commands-check.mjs` must find it handled on both.
- `MULTITEST` gains `"acct":"feedfeed"` so the synthetic Mac is a distinct account even against a
  NEW host whose real `acct` is present.

### 6. The open freeze bug

It lives in the `mergeUsage()`/`pruneStaleLinks()` code this rewrites, and it is diagnosed rather
than assumed fixed. Acceptance: `MULTITEST 2`, wait past `LINK_STALE_MS` (21s), `SCREENSHOT`
USAGE, and compare with the host log's own `5h=`/`7d=` for the same minute. One concrete suspect,
for the diagnosis to confirm or rule out: the parse writes the payload into the global `usage`
before `mergeUsage()`, and `mergeUsage()` only overwrites `usage` when it finds a source, so a
tick with no source leaves the last-parsed payload on screen. The doc's OPEN BUG entry is updated
in place with the outcome.

## Verification

- Offline: a JS mirror of the grouping and selection rules (same account merges, `acct`-less never
  merges, selection by key survives slot reuse, the selected account falls back when it leaves),
  reported separately from structural assertions bound to the real function bodies:
  `mergeUsage()` never reads another account's link, the Codex arm has no cross-account fallback,
  and on board 2 the ring sampler takes the account's own `Usage`. Each has a `--selftest`.
- `usage-trend-check.py` is extended: the sampler and readers index a ring by account, and its
  `--selftest` fails when two accounts share one ring.
- Every existing checker stays green (the list in `CLAUDE.md`).
- Both boards compile (sequentially, never concurrently). Both binaries move, which is expected:
  multi-Mac is shared code. Re-baseline both, with the reason recorded, and update `CLAUDE.md`'s
  figures, including the hand-maintained RAM numbers.
- On glass, board 1 (the board cabled today): `MULTITEST 2` -> `TAB 0` -> `SCREENSHOT` ->
  `USAGEACCT 1` -> `SCREENSHOT` -> `USAGEACCT 0` -> `SCREENSHOT`. Account 0 must match the host
  log's `5h=`/`7d=`, account 1 must read 11%/22% (the synthetic link), and the header label must
  differ between them. Then the freeze acceptance in section 6.
- **Board 2 is not cabled today**, so its per-account ring is verified by compile plus offline
  checks only, and the report says so.
- The real cross-account case needs the NEW host running on both Macs. The live host runs from the
  main checkout, so that is a post-merge step, called out rather than claimed.

## Docs

- `docs/reference/usage-tab.md` and `docs/reference/pairing-and-multi-mac.md`: the "both Macs poll
  the same account" statements are corrected **in place** (kept and marked, per this repo's rule)
  and the new rules are described with their evidence.
- `CLAUDE.md`: binary figures (via `board-baseline.mjs --update`), RAM figures, and a
  `USAGEACCT` row in the command table.
