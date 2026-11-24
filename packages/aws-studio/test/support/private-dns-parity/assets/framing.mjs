// Bounded newline framing for the isolated, phase-zero control channel.
export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1_048_576;

export function encodeFrame(value) {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new Error("Control frame exceeds its byte limit.");
  return frame;
}

export function readFrames(socket, onFrame, onError = () => {}) {
  let buffered = Buffer.alloc(0);
  let failed = false;
  const fail = (error) => {
    if (failed) return;
    failed = true;
    onError(error);
    socket.destroy();
  };
  const onData = (chunk) => {
    if (failed) return;
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      const newline = buffered.indexOf(10);
      if (newline === -1) {
        if (buffered.length > MAX_FRAME_BYTES) fail(new Error("Control frame exceeds its byte limit."));
        return;
      }
      if (newline + 1 > MAX_FRAME_BYTES) { fail(new Error("Control frame exceeds its byte limit.")); return; }
      const line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      try {
        const frame = JSON.parse(line.toString("utf8"));
        if (!frame || typeof frame !== "object" || Array.isArray(frame) || frame.version !== PROTOCOL_VERSION) throw new Error("Invalid control protocol frame.");
        onFrame(frame);
      } catch (error) { fail(error); return; }
    }
  };
  socket.on("data", onData);
  return () => socket.off("data", onData);
}

export function writeFrame(socket, frame) {
  if (socket.destroyed || !socket.writable) throw new Error("Management channel is unavailable.");
  socket.write(encodeFrame({ version: PROTOCOL_VERSION, ...frame }));
}
