// The device draws this next to CC/CX on a session row, in a lane measured
// against the row's right edge - so it is capped at 6 characters HERE rather
// than trimmed on arrival. Derived on the Mac because the Mac is the only side
// that knows its own hostname, and overridable because a hostname is not always
// the name you think of the machine by.
export function macTag(hostname = "", override = "") {
  // An override is a user-provided TAG, so it is sanitised as a whole and never
  // split on separators. A hostname is an OS name where the distinguishing part
  // lives in the last segment (e.g. "air" vs "studio" in Apple defaults), so it
  // is split and that segment is taken. The asymmetry is deliberate.
  const cleanOverride = String(override || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 6);
  if (cleanOverride) return cleanOverride;

  const parts = String(hostname || "")
    .replace(/\.local$/i, "")
    .split(/[-_. ]+/)
    .filter(Boolean);
  if (parts.length === 0) return "";
  const lastSegment = parts[parts.length - 1];
  return lastSegment.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
}
