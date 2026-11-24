import { projectModules } from "../project-modules";
import type { ValidationRequest, ValidationReply } from "./validation-service";

process.once("disconnect", () => process.exit(0));
process.once("message", (request: ValidationRequest) => {
  const send = (reply: ValidationReply) => process.send?.(reply, () => process.disconnect());
  try {
    const modules = projectModules(process.cwd());
    if (request.kind === "policy") {
      modules.statefulResources().resolveStatefulResources(request.value, request.mode, false);
      for (const environment of Object.values(request.value)) {
        const { database, cognito } = environment ?? {};
        if (database?.reference) {
          const check: (value: unknown) => void = modules.databaseLifecycle().assertDatabaseReference;
          check(database.reference);
        }
        if (cognito?.reference) modules.cognitoLifecycle().validateCognitoReference(cognito.reference, cognito.reference);
      }
    } else if (request.kind === "cognito") {
      modules.cognitoLifecycle().validateCognitoReference(request.reference, request.destination);
    } else {
      const check: (value: unknown, destination: Extract<ValidationRequest, { kind: "database" }>["destination"]) => void = modules.databaseLifecycle().assertDatabaseReference;
      check(request.reference, request.destination);
    }
    send({ ok: true });
  } catch (error) {
    send({ ok: false, message: error instanceof Error ? error.message : "The installed framework could not verify this declaration." });
  }
});
