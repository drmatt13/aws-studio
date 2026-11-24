/** Full JSON envelopes, including tiny writes, share a fixed byte and record budget. */
export class LambdaIpcBudget {
  private bytes = 0;
  private records = 0;
  private maximumBytes = 0;
  private maximumRecords = 0;
  private rejected = 0;
  constructor(
    private readonly send: (
      message: unknown,
      done: (error?: Error | null) => void,
    ) => void,
    private readonly onReleased: () => void = () => {},
    private readonly byteLimit = 256 * 1024,
    private readonly recordLimit = 512,
  ) {}
  get statistics() {
    return {
      bytes: this.bytes,
      records: this.records,
      peakBytes: this.maximumBytes,
      peakRecords: this.maximumRecords,
      droppedFrames: this.rejected,
    };
  }
  trySend(
    message: unknown,
    done?: (error?: Error | null) => void,
    countRejection = true,
  ): boolean {
    let size: number;
    try {
      size = Buffer.byteLength(JSON.stringify(message));
    } catch {
      if (countRejection) this.rejected++;
      return false;
    }
    if (
      this.bytes + size > this.byteLimit ||
      this.records >= this.recordLimit
    ) {
      if (countRejection) this.rejected++;
      return false;
    }
    this.bytes += size;
    this.records++;
    this.maximumBytes = Math.max(this.maximumBytes, this.bytes);
    this.maximumRecords = Math.max(this.maximumRecords, this.records);
    let released = false;
    const release = (error?: Error | null, notify = true) => {
      if (released) return;
      released = true;
      this.bytes -= size;
      this.records--;
      try {
        this.onReleased();
      } catch {
        /* No recursive diagnostics. */
      }
      if (notify) done?.(error);
    };
    try {
      this.send(message, release);
      return true;
    } catch {
      release(undefined, false);
      if (countRejection) this.rejected++;
      return false;
    }
  }
}
