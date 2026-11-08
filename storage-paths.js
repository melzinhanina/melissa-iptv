import os from "node:os";
import path from "node:path";

// Centralized temporary paths. Hostless may set TMPDIR to its read-only app mount.
export const DATA_DIR = path.join(os.tmpdir(), "melissa-iptv");
export const HLS_DIR = path.join(DATA_DIR, "hls");
