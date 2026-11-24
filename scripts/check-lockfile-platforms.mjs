import { fileURLToPath } from "node:url";

process.env.FRAMEWORK_REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
await import("aws-studio/cli/check-lockfile-platforms.mjs");
