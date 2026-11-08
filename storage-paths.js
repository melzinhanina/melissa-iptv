import path from "node:path";

// Hostless mounts the application directory read-only and may set TMPDIR=/app.
// Runtime-generated files must always use the writable /tmp filesystem.
const TEMP_ROOT = "/tmp";
export const DATA_DIR = path.join(TEMP_ROOT, "melissa-iptv");
export const HLS_DIR = path.join(DATA_DIR, "hls");
