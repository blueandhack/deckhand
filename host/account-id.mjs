// The account a Mac's quota belongs to, as a short opaque key. Two Macs signed into
// the SAME Claude account publish the same key, which is how the device knows their
// readings are one quota measured twice rather than two quotas. HASHED, never the
// raw id: the BLE link is unencrypted, and the device only needs equality.
import { createHash } from "crypto";

export function accountKey(claudeJson) {
  const id = claudeJson?.oauthAccount?.accountUuid;
  if (typeof id !== "string" || !id) return "";
  return createHash("sha256").update(id).digest("hex").slice(0, 8);
}
