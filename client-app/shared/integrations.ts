/**
 * Framework-maintained integrations that depend on a fixed application source path.
 * These are compatibility contracts, not ownership: the file can be developer owned.
 */

/** Studio's Authentication workspace reads this stack's source, and its `userPool` is the application's canonical user pool. */
export const AUTHENTICATION_STACK_FILE = "cdk-app/lib/app/cognito-stack.ts";
