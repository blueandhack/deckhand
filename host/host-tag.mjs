// The device draws this next to CC/CX on a session row, in a lane measured
// against the row's right edge - so it is capped at 6 characters HERE rather
// than trimmed on arrival. Derived on the Mac because the Mac is the only side
// that knows its own hostname, and overridable because a hostname is not always
// the name you think of the machine by.
export function macTag(hostname = "", override = "") {
  const pick = (s) => {
    const parts = String(s || "")
      .replace(/\.local$/i, "")
      .split(/[-_. ]+/)
      .filter(Boolean);
    if (parts.length === 0) return "";
    let segment = parts[parts.length - 1];
    const cleaned = segment.toLowerCase().replace(/[^a-z0-9]/g, "");
    // If the last segment becomes a single character after cleaning, prefer the
    // previous segment if it exists (handles cases like "studio-b" → "studio")
    if (cleaned.length === 1 && parts.length > 1) {
      segment = parts[parts.length - 2];
      return segment.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
    }
    return cleaned.slice(0, 6);
  };
  return pick(override) || pick(hostname);
}
