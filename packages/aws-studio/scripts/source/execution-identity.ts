// Node-free, so browser code may name it as a type.
/** Who owns an operation: a live process, its OS user, and a token naming this one run. */
export interface ExecutionIdentity {
  readonly pid: number;
  /** POSIX user id; -1 only when Windows userSid supplies the owner identity. */
  readonly uid: number;
  readonly userSid?: string;
  readonly started: string;
  readonly token: string;
}
