/** Offline process-boundary log fixture. It makes no external calls. */
export async function lambdaHandler(event: {
  readonly label: string;
  readonly secret?: string;
  readonly fail?: boolean;
}) {
  console.log("observed execution", event.label, event.secret ?? "");
  await new Promise((resolve) => setTimeout(resolve, 5));
  process.stderr.write(`final ${event.label}`);
  if (event.fail) throw new Error(`fixture failure ${event.label}`);
  return { label: event.label };
}
