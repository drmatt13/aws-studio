import { assignmentGrants, describeCondition, fieldProtections, type AccessGrant, type RowFilterValue, type readClientAccess } from "aws-studio/database/client-access";
import { fieldReaderCondition } from "../../shared/database-workbench";

type Parsed = ReturnType<typeof readClientAccess>;
const words = (value: string) => value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
const audience = (value: string) => ({ owner: "the row’s owner", anyone: "people who can see the row", authenticated: "signed-in users", member: "members of this group" })[value] ?? words(value);
const grantActor = (term: string, owner?: string) => {
  if (term === "owner" && owner) return owner;
  if (["owner", "anyone", "authenticated", "member"].includes(term)) return audience(term);
  return /^[A-Z][A-Z_]*$/.test(term) ? `${words(term)} role holders` : `people with the ${term} permission`;
};
const capitalized = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const destinations = (value: RowFilterValue) => typeof value !== "object" ? String(value) : "in" in value ? value.in.join(" or ") : `any value except ${String(value.not)}`;

/** A readable sentence from the parsed grant, including its stored-state and destination limits. */
export function grantSentence(verb: "read" | "write" | "create" | "update" | "delete", grant: AccessGrant, field = "this field"): string {
  const who = grant.who.map((term) => grantActor(term)).join(" or ") || "no one";
  const action = verb === "write" ? `set ${field}${grant.to === undefined ? "" : ` to ${destinations(grant.to)}`}` : verb === "read" ? `read ${field}` : verb === "create" ? "create rows" : verb === "delete" ? "delete rows" : `edit ${field}`;
  const when = Object.entries(grant.where ?? {}).map(([name, value]) => describeCondition(name, value)).join(" and ");
  return `${capitalized(who)} may ${action}${grant.except?.includes("owner") ? ", excluding the row’s owner" : ""}${when ? ` when ${when}` : ""}.`;
}

/** Describes declared grants, without treating this explanation as an authorization decision. */
export function grantSummary(grants: readonly AccessGrant[] | undefined, fallback: string): string {
  if (!grants?.length) return fallback;
  return grants.map((grant) => {
    // Same words as the rule sentences: a permission keeps its exact name.
    const who = capitalized(grant.who.map((term) => grantActor(term)).join(" or ")) || "No one";
    const when = Object.entries(grant.where ?? {}).map(([name, value]) => describeCondition(name, value)).join(" and ");
    const destination = grant.to === undefined ? "" : `; ${describeCondition("new value", grant.to)}`;
    return `${who}${grant.except?.includes("owner") ? ", excluding the row’s owner" : ""}${when ? ` when ${when}` : ""}${destination}`;
  }).join("; or ");
}

/** The three independent questions developers need answered for a scalar field. */
export function fieldAccessSummary(source: string, parsed: Parsed, model: string, name: string) {
  const declaration = parsed.policy.models[model];
  const field = declaration?.fields[name];
  if (!field || field.relation) return undefined;
  const mode = parsed.settings[model]?.[name];
  const protection = fieldProtections(source).find((entry) => entry.model === model && entry.field === name);
  const readers = grantSummary(field.read ?? declaration.read, "People who can see this row");
  const read = mode === "server-only" ? "Hidden from the API" : field.readIdentity
    ? `${readers} when ${fieldReaderCondition(model, field.readIdentity)}` : readers;
  const readOrigin = mode === "server-only" ? "Field protection" : field.readIdentity ? "Field identity condition and row policy" : field.read ? "Field override" : declaration.read ? "Model read default" : "Row visibility";
  const managed = mode === "server-only" || mode === "read-only" || protection?.reason === "primary-key" || protection?.reason === "clock";
  const createGrants = assignmentGrants(declaration.create, name);
  const updateGrants = assignmentGrants(declaration.update, name);
  const create = managed ? protection?.reason === "primary-key" ? "Generated or set by the server" : "Set by the server" : !declaration.create ? "No client creation grant" : field.write ? `${grantSummary(field.write, "No one")} when creation is also allowed` : grantSummary(createGrants, "No client creation grant");
  const update = managed ? "Clients cannot edit it" : field.link && !field.write ? "Fixed after creation" : grantSummary(field.write ?? updateGrants, "No client edit grant");
  const headline = mode === "server-only" ? "This field stays on the server."
    : managed ? "The server sets this field."
      : field.link && !field.write ? "Set when the row is created, then fixed to its original access group."
        : field.write?.length ? field.write.map((grant) => grantSentence("write", grant, name)).join(" ")
          : updateGrants?.length ? updateGrants.map((grant) => grantSentence("update", grant, name)).join(" ")
            : "Clients cannot edit this field after creation.";
  return {
    read, readOrigin, create, update, headline,
    createOrigin: managed ? "Automatic protection or server-assigned field" : field.write ? "Field write rule + model create rule" : "Model create rule",
    updateOrigin: managed ? "Protected on creation and update" : field.link && !field.write ? "Access link" : field.write ? "Field override" : "Model update default",
  };
}
