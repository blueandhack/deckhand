// Run: node host/line-address-check.mjs
import { lineTargetsUs, stripAddress } from "./line-address.mjs";

let failed = 0;
const t = (line, id, want, what) => {
  const got = lineTargetsUs(line, id);
  if (got === want) return;
  console.error(`FAIL ${what}: got ${got} want ${want} for ${JSON.stringify(line)}`);
  failed++;
};
const ts = (line, want, what) => {
  const got = stripAddress(line);
  if (got === want) return;
  console.error(`FAIL ${what}: got ${JSON.stringify(got)} want ${JSON.stringify(want)} for ${JSON.stringify(line)}`);
  failed++;
};

const ME = "9f3c1a20", THEM = "44ab0071";

t("ANSWER abc123 4242 0 f00dcafef00dcafe to=9f3c1a20", ME, true, "addressed to us");
t("ANSWER abc123 4242 0 f00dcafef00dcafe to=44ab0071", ME, false, "addressed to the other Mac");
// Unaddressed is BROADCAST, not "drop": BATT and HELLO are deliberately for
// everyone, and a device on older firmware stamps nothing at all.
t("BATT mv=3854 pct=42 state=1 left=312", ME, true, "unaddressed broadcast");
t("HELLO Deckhand-1A2B v2", ME, true, "hello is for whoever is listening");
t("ANSWER abc123 4242 0 f00dcafef00dcafe", ME, true, "legacy firmware stamps nothing");
t("ANSWER abc123 4242 0 f00dcafef00dcafe to=9F3C1A20", ME, true, "hostId compare is case-insensitive");
// Only a TRAILING to= counts. A non-anchored regex would wrongly treat a
// mid-line "to=" as the address; this fixture has real teeth for that,
// unlike a base64 body that never literally contains the substring "to="
// (which passes regardless of whether the anchor is right or broken).
t("ANSWER a 1 TYPED to=44ab0071 deadbeefdeadbeef", ME, true, "a mid-line to= is not the address");
t("ANSWER a 1 0 deadbeefdeadbeef to=", ME, true, "empty address reads as broadcast");
t("ANSWER a 1 0 deadbeefdeadbeef to=zzzz", ME, true, "non-hex address reads as broadcast");
// With no identity of our own we cannot judge, so we must not drop anything.
t("ANSWER a 1 0 deadbeefdeadbeef to=44ab0071", "", true, "no hostId yet: accept everything");

// stripAddress must remove exactly what lineTargetsUs matches on - no more,
// no less - so a positional parser downstream sees the pre-addressing line.
ts(
  "ANSWER abc123 4242 0 f00dcafef00dcafe to=9f3c1a20",
  "ANSWER abc123 4242 0 f00dcafef00dcafe",
  "a trailing address is stripped"
);
ts(
  "BATT mv=3854 pct=42 state=1 left=312",
  "BATT mv=3854 pct=42 state=1 left=312",
  "an unaddressed line passes through untouched"
);
ts(
  "ANSWER a 1 TYPED to=44ab0071 deadbeefdeadbeef",
  "ANSWER a 1 TYPED to=44ab0071 deadbeefdeadbeef",
  "a mid-line to= survives stripping intact"
);

console.log(failed ? `line-address: ${failed} FAILED` : "line-address: all checks passed");
process.exit(failed ? 1 : 0);
