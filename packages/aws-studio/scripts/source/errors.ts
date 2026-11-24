/** Shared edit failure without importing the source-editing implementation. */
export class EditError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
