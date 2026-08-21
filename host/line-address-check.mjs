// Run: node host/line-address-check.mjs
import { lineTargetsUs } from "./line-address.mjs";

let failed = 0;
const t = (line, id, want, what) => {
  const got = lineTargetsUs(line, id);
  if (got === want) return;
  console.error(`FAIL ${what}: got ${got} want ${want} for ${JSON.stringify(line)}`);
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
// Only a TRAILING to= counts. A TYPED answer's base64 body is one token and can
// itself end in "to=" (padding is trailing), so the token must be anchored and
// hex - and an unparseable one must read as broadcast, never as "not ours",
// because wrongly dropping an answer strands a blocked prompt.
t("ANSWER a 1 TYPED aGVsbG8gdG8= deadbeefdeadbeef", ME, true, "base64 body is not an address");
t("ANSWER a 1 0 deadbeefdeadbeef to=", ME, true, "empty address reads as broadcast");
t("ANSWER a 1 0 deadbeefdeadbeef to=zzzz", ME, true, "non-hex address reads as broadcast");
// With no identity of our own we cannot judge, so we must not drop anything.
t("ANSWER a 1 0 deadbeefdeadbeef to=44ab0071", "", true, "no hostId yet: accept everything");

console.log(failed ? `line-address: ${failed} FAILED` : "line-address: all checks passed");
process.exit(failed ? 1 : 0);
