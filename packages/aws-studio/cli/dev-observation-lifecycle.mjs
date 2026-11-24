/** Rotate only the diagnostic pipe when preparation changes the owned runtime identity. */
export async function refreshDevelopmentObservation(options) {
  const next = await options.prepare();
  if (!next?.enabled) {
    if (options.previousRunId) await options.close();
    return false;
  }
  if (!next.runtimeSessionId || next.runtimeSessionId === options.previousRunId)
    return false;
  if (!options.previousRunId) {
    await options.start();
    return true;
  }
  options.record({
    kind: "startup.source-changed",
    message:
      "Declarations or the development binding changed during startup. Subsequent startup output belongs to a new runtime session.",
  });
  await options.close();
  await options.start();
  return true;
}
