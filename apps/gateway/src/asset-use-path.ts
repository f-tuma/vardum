import { mediaStem } from "@vardum/shared";
import { toKey } from "./lib/format.js";

/** A generated path is extensionless; dots in names must not promise a format. */
export function defaultUsePath(prefix: string, displayName: string) {
  return `${prefix}${toKey(mediaStem(displayName)).replace(/\.+/g, "-")}`;
}
