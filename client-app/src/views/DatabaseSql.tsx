import { usePublishSightline } from "../sightline/bridge";
import { dialogPrimaryActionClasses } from "../inspector-ui";
import { cx } from "../ui/classes";
import {
  SourceComparison,
  WorkbenchDialog,
  WorkbenchListHeading,
  WorkbenchPageHeader,
  workbenchCardClasses,
  workbenchCardSummaryClasses,
  workbenchChoiceClasses,
  workbenchDetailClasses,
  workbenchDetailSummaryClasses,
  workbenchEmptyClasses,
  workbenchMasterDetailClasses,
  workbenchNoticeClasses,
  workbenchPageClasses,
  workbenchPanelClasses,
} from "./WorkbenchUI";
import {
  documentSummaryClasses,
  documentSupportClasses,
  documentTitleClasses, documentCardTitleClasses,
} from "./DocumentUI";
import { noticeClasses } from "../ui/Surface";
import { Code2, RefreshCw } from "lucide-react";
import { Select, TextInput, Textarea } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBlocker } from "@tanstack/react-router";
import type { Mode } from "../../shared/model";
import { call } from "../http";
import type {
  SavedSqlCommand,
  SqlCatalog,
  SqlExecutionResult,
  SqlExecutionReview,
  SqlSourceReview,
} from "../../shared/database-sql";

export const databaseSqlApi = {
  load: () => call<SqlCatalog>("/database/sql"),
  review: (command: SavedSqlCommand, expectedRevision: string | null) =>
    call<SqlSourceReview>("/database/sql/review", {
      command,
      expectedRevision,
    }),
  save: (id: string) =>
    call<{ message: string; revision: string }>("/database/sql/save", { id }),
  executionReview: (
    path: string,
    revision: string,
    targetId: string,
    parameters: unknown,
  ) =>
    call<SqlExecutionReview>("/database/sql/execute-review", {
      path,
      revision,
      targetId,
      parameters,
    }),
  execute: (id: string, confirmation: string) =>
    call<SqlExecutionResult>("/database/sql/execute", { id, confirmation }),
};
const sqlLabelClasses = "grid min-w-0 gap-1 text-label";
const sqlTextareaClasses =
  "w-full resize-y px-3 py-2 font-mono text-label leading-[1.5]";
const sqlPreClasses =
  "max-w-full overflow-auto whitespace-pre-wrap wrap-anywhere";

type ParameterInput = {
  readonly type: "text" | "number" | "boolean" | "null";
  readonly value: string;
};
const queryStarter = (): SavedSqlCommand => ({
  name: "inspect_database",
  kind: "inspection",
  intent: "repeatable",
  description: "Inspect the current database",
  parameters: [],
  sql: 'SELECT current_database() AS database, current_schema() AS schema, current_user AS "user";',
});
const seedStarter = (): SavedSqlCommand => ({
  name: "seed_data",
  kind: "seed",
  intent: "once",
  description: "Add development data",
  parameters: [],
  sql: "",
});
function parameterValue(
  input: ParameterInput,
  name: string,
): string | number | boolean | null {
  if (input.type === "null") return null;
  if (input.type === "boolean") return input.value === "true";
  if (input.type === "number") {
    const value = Number(input.value);
    if (!input.value.trim() || !Number.isFinite(value))
      throw new Error("Enter a valid number for " + name + ".");
    return value;
  }
  return input.value;
}
function resultValue(value: unknown): string {
  if (value === null) return "NULL";
  if (value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function DatabaseSql({
  active,
  mode,
}: {
  readonly active: boolean;
  readonly mode: Mode;
}) {
  const [catalog, setCatalog] = useState<SqlCatalog>();
  const [selected, setSelected] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [command, setCommand] = useState<SavedSqlCommand>(queryStarter);
  const [baseline, setBaseline] = useState<SavedSqlCommand>(queryStarter);
  const [revision, setRevision] = useState<string | null>(null);
  const [parameterNames, setParameterNames] = useState("");
  const [parameters, setParameters] = useState<readonly ParameterInput[]>([]);
  const [sourceReview, setSourceReview] = useState<SqlSourceReview>();
  const [executionReview, setExecutionReview] = useState<SqlExecutionReview>();
  const [approval, setApproval] = useState("");
  const [result, setResult] = useState<SqlExecutionResult>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>(),
    [message, setMessage] = useState<string>();
  const [pendingCommand, setPendingCommand] = useState<() => void>();
  const id = useId();
  const modeContext = useRef({ mode, active, generation: 0 });
  if (modeContext.current.mode !== mode || modeContext.current.active !== active)
    modeContext.current = {
      mode,
      active,
      generation: modeContext.current.generation + 1,
    };
  const target = "local:postgres";
  const current: SavedSqlCommand = {
    ...command,
    parameters: parameterNames
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  };
  const dirty = editing && JSON.stringify(current) !== JSON.stringify(baseline);
  const needsSave = editing && (!selected || dirty);
  const persisted = catalog?.commands.find((item) => item.path === selected);
  const stale =
    !!selected && !!catalog && !busy && persisted?.revision !== revision;
  const departure = useBlocker({
    withResolver: true,
    enableBeforeUnload: false,
    shouldBlockFn: ({ current, next }) =>
      current.pathname !== next.pathname &&
      ((dirty && next.pathname !== "/database" && !next.pathname.startsWith("/database/")) || (busy && editing)),
  });
  usePublishSightline("databaseSql", () => ({
    targetId: mode === "dev" ? target : "",
    busy,
    reviewOpen: !!sourceReview || !!executionReview,
  }));
  const load = async () => {
    const value = await databaseSqlApi.load();
    if (!Array.isArray(value.commands))
      throw new Error("Restart npm run studio to enable saved SQL commands.");
    setCatalog(value);
  };
  const run = async (work: () => Promise<void>, generation?: number) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (error) {
      if (
        generation === undefined ||
        (modeContext.current.mode === "dev" &&
          modeContext.current.generation === generation)
      )
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (active) void run(load);
  }, [active]);
  useEffect(() => {
    setResult(undefined);
    setExecutionReview(undefined);
    setApproval("");
    setError(undefined);
    setMessage(undefined);
  }, [mode]);
  useEffect(() => {
    if (!active) {
      setSourceReview(undefined);
      setExecutionReview(undefined);
      setApproval("");
      setPendingCommand(undefined);
    }
  }, [active]);
  useEffect(() => {
    setResult(undefined);
    setExecutionReview(undefined);
  }, [command, parameters, parameterNames]);
  useEffect(() => {
    if (!dirty && !(busy && editing)) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty, busy, editing]);
  const choose = (path?: string, starter?: SavedSqlCommand) => {
    const item = catalog?.commands.find((item) => item.path === path);
    const next = item?.command ?? starter ?? queryStarter();
    setSelected(item?.path);
    setEditing(!!item || !!starter);
    setCommand(next);
    setBaseline(next);
    setRevision(item?.revision ?? null);
    setParameterNames(next.parameters.join(", "));
    setParameters(next.parameters.map(() => ({ type: "text", value: "" })));
    setResult(undefined);
    setSourceReview(undefined);
    setExecutionReview(undefined);
    setMessage(undefined);
    setError(undefined);
  };
  const requestChoose = (path?: string, starter?: SavedSqlCommand) => {
    if (dirty) setPendingCommand(() => () => choose(path, starter));
    else choose(path, starter);
  };
  const updateParameter = (index: number, patch: Partial<ParameterInput>) => {
    setParameters((values) =>
      current.parameters.map((_, at) =>
        at === index
          ? { ...(values[at] ?? { type: "text", value: "" }), ...patch }
          : (values[at] ?? { type: "text", value: "" }),
      ),
    );
  };
  const closeGuard = () => {
    setPendingCommand(undefined);
    if (departure.status === "blocked") departure.reset();
  };
  const discardAndContinue = () => {
    const next = pendingCommand;
    setPendingCommand(undefined);
    choose(selected);
    if (next) next();
    if (departure.status === "blocked") departure.proceed();
  };
  const columns = result
    ? [...new Set(result.rows.flatMap((row) => Object.keys(row)))]
    : [];
  const hasUncertainExecution = catalog?.history.some(
    (item) => item.status === "unconfirmed" || item.status === "running",
  );
  return (
    <div data-ui="database-sql" className={workbenchPageClasses} aria-busy={busy}>
      <WorkbenchPageHeader
        icon={Code2}
        title="Saved SQL"
        description="Reusable queries and data changes, saved in your repository."
        actions={
          <>
            <button
              className={buttonClasses({ variant: "quiet" })}
              disabled={busy}
              onClick={() => void run(load)}
            >
              <RefreshCw size={14} aria-hidden /> Refresh SQL catalog
            </button>
            <button
              className={buttonClasses({ variant: "quiet" })}
              disabled={busy || !catalog}
              onClick={() => requestChoose(undefined, seedStarter())}
            >
              Create seed
            </button>
            <button
              className={buttonClasses({ variant: "quiet" })}
              disabled={busy || !catalog}
              onClick={() => requestChoose(undefined, queryStarter())}
            >
              Create query
            </button>
          </>
        }
      />
      {mode === "prod" ? (
        <p className={workbenchNoticeClasses()} role="note">
          <strong>Production · source editing only.</strong> Saved commands are
          shared by both modes. Execution is available in Development against
          local PostgreSQL.
        </p>
      ) : null}
      {error && !sourceReview && !executionReview ? (
        <p
          data-ui="workbench-notice"
          className={workbenchNoticeClasses("warning")}
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className={workbenchNoticeClasses()}>
          {message}
        </p>
      ) : null}
      {!catalog && !error ? (
        <p role="status" className={workbenchEmptyClasses}>
          Loading saved commands…
        </p>
      ) : null}
      {catalog?.issues.map((issue) => (
        <p key={issue} className={workbenchNoticeClasses("warning")}>
          {issue}
        </p>
      ))}
      {hasUncertainExecution ? (
        <p className={workbenchNoticeClasses("warning")}>
          An earlier execution has an unconfirmed outcome. Review its recorded
          destination and execution history before retrying.
        </p>
      ) : null}
      {catalog ? (
        <div className={workbenchMasterDetailClasses}>
          <nav
            aria-label="Saved SQL commands"
            className={workbenchPanelClasses("grid content-start gap-2")}
          >
            <WorkbenchListHeading count={catalog.commands.length}>Commands</WorkbenchListHeading>
            {catalog.commands.length ? (
              <div className="grid gap-1">
                {catalog.commands.map((item) => (
                  <button
                    key={item.path}
                    aria-label={"Open SQL command " + item.command.name}
                    aria-pressed={selected === item.path}
                    className={workbenchChoiceClasses}
                    disabled={busy}
                    onClick={() => requestChoose(item.path)}
                  >
                    <strong className="text-label wrap-anywhere">
                      {item.command.name}
                    </strong>
                    <span className="text-caption text-graphite wrap-anywhere">
                      {item.command.description || item.command.kind}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="m-0 px-3 text-caption text-graphite">
                No saved commands yet.
              </p>
            )}
          </nav>
          {editing ? (
            <div className="grid min-w-0 gap-4">
              <fieldset
                disabled={busy}
                data-ui="sql-fields"
                aria-labelledby={`${id}-command`}
                className={cx("m-0", workbenchCardClasses)}
              >
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                  <div className="grid min-w-0 gap-1">
                    <h3 id={`${id}-command`} className={cx(documentCardTitleClasses, "wrap-anywhere")}>
                      {selected ? command.name : "New command"}
                    </h3>
                    <p className={dirty ? "m-0 text-caption leading-[1.5] text-local" : documentSupportClasses}>
                      {dirty
                        ? "Modified draft"
                        : selected
                          ? "Saved source"
                          : "Not saved"}
                    </p>
                  </div>
                  {dirty ? (
                    <button
                      className={buttonClasses({ variant: "link", className: "text-caption" })}
                      onClick={() => requestChoose(selected)}
                    >
                      Discard changes
                    </button>
                  ) : null}
                </div>
                {stale ? (
                  <p role="alert" className={noticeClasses()}>
                    The saved command changed. Reload it before running or
                    reviewing this draft.{" "}
                    <button
                      className={buttonClasses({ variant: "link" })}
                      onClick={() => requestChoose(selected)}
                    >
                      Reload saved command
                    </button>
                  </p>
                ) : null}
                <div className="grid grid-cols-2 gap-3 vp-650:grid-cols-1">
                  <label className={sqlLabelClasses}>
                    Name
                    <TextInput
                      aria-label="SQL command name"
                      value={command.name}
                      onChange={(event) =>
                        setCommand({ ...command, name: event.target.value })
                      }
                      className="w-full"
                    />
                  </label>
                  <label className={sqlLabelClasses}>
                    Description
                    <TextInput
                      aria-label="SQL description"
                      value={command.description}
                      onChange={(event) =>
                        setCommand({
                          ...command,
                          description: event.target.value,
                        })
                      }
                      className="w-full"
                    />
                  </label>
                </div>
                <label data-ui="sql-source" className={sqlLabelClasses}>
                  SQL
                  <Textarea
                    aria-label="SQL source"
                    spellCheck={false}
                    rows={10}
                    value={command.sql}
                    onChange={(event) =>
                      setCommand({ ...command, sql: event.target.value })
                    }
                    placeholder="Write one PostgreSQL statement…"
                    className={sqlTextareaClasses}
                  />
                </label>
                <details className={workbenchDetailClasses}>
                  <summary className={documentSummaryClasses}>
                    Command settings
                  </summary>
                  <div className="grid grid-cols-2 gap-3 vp-650:grid-cols-1">
                    <label className={sqlLabelClasses}>
                      Category
                      <Select
                        aria-label="SQL category"
                        value={command.kind}
                        onChange={(event) =>
                          setCommand({
                            ...command,
                            kind: event.target.value as SavedSqlCommand["kind"],
                          })
                        }
                        className="w-full"
                      >
                        <option value="inspection">Read-only query</option>
                        <option value="seed">Seed / demo data</option>
                        <option value="backfill">Backfill</option>
                        <option value="operation">Operational SQL</option>
                      </Select>
                    </label>
                    <label className={sqlLabelClasses}>
                      Run policy
                      <Select
                        aria-label="SQL execution intent"
                        value={command.intent}
                        onChange={(event) =>
                          setCommand({
                            ...command,
                            intent: event.target
                              .value as SavedSqlCommand["intent"],
                          })
                        }
                        className="w-full"
                      >
                        <option value="repeatable">Repeatable</option>
                        <option value="once">
                          Once per command and parameter set
                        </option>
                      </Select>
                    </label>
                    <label className={sqlLabelClasses + " col-span-full"}>
                      Parameter names, in $1, $2 order
                      <TextInput
                        aria-label="SQL parameter names"
                        value={parameterNames}
                        onChange={(event) =>
                          setParameterNames(event.target.value)
                        }
                        placeholder="For example: user_id, limit"
                        className="w-full"
                      />
                    </label>
                  </div>
                  <p className={documentSupportClasses}>
                    Repeatable SQL owns its idempotence. Changing the name or
                    category creates a new file and preserves the original.
                  </p>
                  <p className={cx(documentSupportClasses, "wrap-anywhere")}>
                    {selected ?? catalog.directory + "/"}
                  </p>
                </details>
                <div
                  data-ui="sql-source sql-source-actions"
                  className="flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-3"
                >
                  <p className={documentSupportClasses}>
                    Saving changes the repository file. Execution is reviewed
                    separately.
                  </p>
                  <button
                    data-variant="primary"
                    className={buttonClasses({ variant: "primary", className: "ml-auto" })}
                    disabled={
                      !needsSave ||
                      !command.name.trim() ||
                      !command.sql.trim() ||
                      stale
                    }
                    onClick={() =>
                      void run(async () => {
                        const sameFile =
                          selected &&
                          current.name === baseline.name &&
                          current.kind === baseline.kind;
                        setSourceReview(
                          await databaseSqlApi.review(
                            current,
                            sameFile ? revision : null,
                          ),
                        );
                      })
                    }
                  >
                    Review SQL source
                  </button>
                </div>
              </fieldset>
              {mode === "dev" ? (
                <fieldset
                  disabled={busy}
                  aria-labelledby={`${id}-run`}
                  className={cx("m-0", workbenchCardClasses)}
                >
                  <div className="grid min-w-0 gap-1">
                    <h3 id={`${id}-run`} className={documentCardTitleClasses}>
                      Run on Local PostgreSQL
                    </h3>
                    <p className={documentSupportClasses}>
                      {catalog.targets.find((item) => item.id === target)
                        ?.detail ??
                        "Uses this checkout’s local PostgreSQL connection."}
                    </p>
                  </div>
                  {current.parameters.length ? (
                    <div className="grid gap-3">
                      {current.parameters.map((name, index) => {
                        const input = parameters[index] ?? {
                          type: "text",
                          value: "",
                        };
                        return (
                          <div
                            key={index}
                            className="grid grid-cols-[minmax(0,1fr)_140px] items-end gap-2 vp-480:grid-cols-1"
                          >
                            <label className={sqlLabelClasses}>
                              <span className="flex min-w-0 items-baseline gap-2">
                                <span className="wrap-anywhere">{name}</span>
                                <span className="text-caption text-graphite">
                                  ${index + 1}
                                </span>
                              </span>
                              {input.type === "null" ? (
                                <span className="flex min-h-8 items-center text-caption text-graphite">
                                  SQL NULL
                                </span>
                              ) : input.type === "boolean" ? (
                                <Select
                                  aria-label={"SQL parameter " + name}
                                  value={
                                    input.value === "true" ? "true" : "false"
                                  }
                                  onChange={(event) =>
                                    updateParameter(index, {
                                      value: event.target.value,
                                    })
                                  }
                                >
                                  <option value="false">False</option>
                                  <option value="true">True</option>
                                </Select>
                              ) : (
                                <TextInput
                                  aria-label={"SQL parameter " + name}
                                  type={
                                    input.type === "number" ? "number" : "text"
                                  }
                                  step={
                                    input.type === "number" ? "any" : undefined
                                  }
                                  value={input.value}
                                  onChange={(event) =>
                                    updateParameter(index, {
                                      value: event.target.value,
                                    })
                                  }
                                  className="w-full"
                                />
                              )}
                            </label>
                            <label className={sqlLabelClasses}>
                              Type
                              <Select
                                aria-label={"Type for SQL parameter " + name}
                                value={input.type}
                                onChange={(event) =>
                                  updateParameter(index, {
                                    type: event.target
                                      .value as ParameterInput["type"],
                                    value:
                                      event.target.value === "boolean"
                                        ? "false"
                                        : input.value,
                                  })
                                }
                              >
                                <option value="text">Text</option>
                                <option value="number">Number</option>
                                <option value="boolean">Boolean</option>
                                <option value="null">Null</option>
                              </Select>
                            </label>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className={documentSupportClasses}>
                      No parameters.
                    </p>
                  )}
                  <details className={workbenchDetailClasses}>
                    <summary className={workbenchDetailSummaryClasses}>
                      Execution details
                    </summary>
                    <p className={documentSupportClasses}>
                      One statement runs in a transaction. Parameter values and
                      result rows stay out of persistent history. If the
                      connection is lost during COMMIT, inspect the target
                      before retrying.
                    </p>
                  </details>
                  {/* Like the source footer above: the note on the left, the action last at the right. */}
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-3">
                  {needsSave ? (
                    <p className={documentSupportClasses}>
                      Save the command before reviewing execution.
                    </p>
                  ) : null}
                  <button
                    data-variant="primary"
                    className={buttonClasses({ variant: "primary", className: "ml-auto" })}
                    disabled={!persisted || needsSave || stale}
                    onClick={() => {
                      const generation = modeContext.current.generation;
                      void run(async () => {
                        if (modeContext.current.mode !== "dev")
                          throw new Error(
                            "Switch to Development to run saved SQL locally.",
                          );
                        const values = current.parameters.map((name, index) =>
                          parameterValue(
                            parameters[index] ?? { type: "text", value: "" },
                            name,
                          ),
                        );
                        const reviewed = await databaseSqlApi.executionReview(
                          persisted!.path,
                          persisted!.revision,
                          target,
                          values,
                        );
                        if (
                          modeContext.current.mode === "dev" &&
                          modeContext.current.generation === generation
                        ) {
                          setApproval("");
                          setExecutionReview(reviewed);
                        }
                      }, generation);
                    }}
                  >
                    Review execution
                  </button>
                  </div>
                </fieldset>
              ) : null}
            </div>
          ) : (
            <section data-ui="workbench-empty" className={workbenchEmptyClasses}>
              <h3 className={cx(documentTitleClasses, "text-ink")}>
                {catalog.commands.length
                  ? "Choose a saved command"
                  : "Start with a query or seed"}
              </h3>
              <p className="m-0">
                {catalog.commands.length
                  ? "Open a command to edit its SQL or review a local run."
                  : "Create query starts with a read-only database check. Create seed opens a blank statement for your application data."}
              </p>
            </section>
          )}
        </div>
      ) : null}
      {result ? (
        <section
          aria-label="SQL execution result"
          className={workbenchCardClasses}
        >
          <div className="grid min-w-0 gap-1">
            <h3 className={documentCardTitleClasses}>
              {result.name} · {result.status} · {result.targetLabel}
            </h3>
            <p role="status" className={documentSupportClasses}>
              {result.message}
            </p>
          </div>
          <p className={documentSupportClasses}>
            {result.rowCount ?? 0} rows
            {result.truncated ? " · first 100 shown" : ""}
            {result.sqlState ? <> · <code>SQLSTATE {result.sqlState}</code></> : null}
          </p>
          {result.rows.length ? (
            <div
              role="region"
              aria-label="SQL result rows"
              tabIndex={0}
              className="max-h-100 max-w-full overflow-auto rounded-md border border-rule"
            >
              <table className="w-full border-collapse text-left text-caption">
                <thead>
                  <tr>
                    {columns.map((column) => (
                      <th
                        key={column}
                        scope="col"
                        className="border-b border-rule bg-wash px-3 py-2 font-semibold whitespace-nowrap"
                      >
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, index) => (
                    <tr key={index}>
                      {columns.map((column) => (
                        <td
                          key={column}
                          className="max-w-96 border-b border-rule px-3 py-2 align-top font-mono wrap-anywhere"
                        >
                          {resultValue(row[column])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className={workbenchEmptyClasses}>No rows returned.</p>
          )}
          <details className={workbenchDetailClasses}>
            <summary className={workbenchDetailSummaryClasses}>
              Command and revision
            </summary>
            <p className={cx(documentSupportClasses, "wrap-anywhere")}>
              <code>{result.path}</code> · {result.revision}
            </p>
          </details>
        </section>
      ) : null}
      {catalog ? (
        <details
          aria-label="SQL operation history"
          open={hasUncertainExecution}
          className={workbenchCardClasses}
        >
          <summary className={workbenchCardSummaryClasses}>
            Execution history ({catalog.history.length})
          </summary>
          <p className={documentSupportClasses}>
            Recorded runs never replay automatically. Unconfirmed outcomes need
            inspection of their recorded target.
          </p>
          {!catalog.history.length ? (
            <p className={workbenchEmptyClasses}>
              No saved SQL executions recorded.
            </p>
          ) : (
            catalog.history.map((item) => (
              <details key={item.id} className={cx(workbenchDetailClasses, "border-t border-rule pt-2")}>
                <summary className="min-h-8 cursor-pointer py-1 text-label leading-6">
                  {item.name} · {item.status} · {item.targetLabel}
                </summary>
                <p className="m-0 text-caption">{item.message}</p>
                <p className={cx(documentSupportClasses, "wrap-anywhere")}>
                  <code>{item.startedAt}</code> · {item.id}
                </p>
                <p className={cx(documentSupportClasses, "wrap-anywhere")}>
                  {item.path} · revision {item.revision.slice(0, 12)} · database{" "}
                  {item.database}
                  {item.sqlState ? " · SQLSTATE " + item.sqlState : ""}
                </p>
              </details>
            ))
          )}
        </details>
      ) : null}
      {active && sourceReview ? (
        <WorkbenchDialog
          title="Review saved SQL source"
          busy={busy}
          onClose={() => setSourceReview(undefined)}
          footer={
            <>
              <button
                className={buttonClasses({ variant: "quiet" })}
                disabled={busy}
                onClick={() => setSourceReview(undefined)}
              >
                Back
              </button>
              <button
                data-variant="primary"
                className={cx(
                  dialogPrimaryActionClasses,
                  buttonClasses({ variant: "primary" }),
                )}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const reviewed = sourceReview;
                    const response = await databaseSqlApi.save(reviewed.id);
                    setSelected(reviewed.path);
                    setCommand(reviewed.command);
                    setBaseline(reviewed.command);
                    setParameterNames(reviewed.command.parameters.join(", "));
                    setRevision(response.revision);
                    setSourceReview(undefined);
                    setMessage(response.message);
                    try {
                      await load();
                    } catch (error) {
                      throw new Error(
                        "SQL source was saved. Catalog refresh failed: " +
                          (error instanceof Error
                            ? error.message
                            : String(error)),
                      );
                    }
                  })
                }
              >
                Save SQL source
              </button>
            </>
          }
        >
          {error ? (
            <p role="alert" className="text-label text-refuse wrap-anywhere">
              {error}
            </p>
          ) : null}
          <p className="text-label wrap-anywhere">
            <code>{sourceReview.path}</code>
          </p>
          <p className="text-caption">
            Saving writes this repository file. No database is contacted.
          </p>
          <SourceComparison
            before={sourceReview.before ?? ""}
            after={sourceReview.after}
          />
        </WorkbenchDialog>
      ) : null}
      {active && executionReview ? (
        <WorkbenchDialog
          title="Approve SQL execution"
          busy={busy}
          onClose={() => setExecutionReview(undefined)}
          footer={
            <>
              <button
                className={buttonClasses({ variant: "quiet" })}
                disabled={busy}
                onClick={() => setExecutionReview(undefined)}
              >
                Cancel
              </button>
              <button
                data-variant="primary"
                className={cx(
                  dialogPrimaryActionClasses,
                  buttonClasses({ variant: "primary" }),
                )}
                disabled={
                  busy ||
                  mode !== "dev" ||
                  approval !== executionReview.confirmation
                }
                onClick={() => {
                  const generation = modeContext.current.generation;
                  void run(async () => {
                    if (modeContext.current.mode !== "dev")
                      throw new Error(
                        "Switch to Development and review execution again.",
                      );
                    const value = await databaseSqlApi.execute(
                      executionReview.id,
                      approval,
                    );
                    if (
                      modeContext.current.mode === "dev" &&
                      modeContext.current.generation === generation
                    ) {
                      setResult(value);
                      setExecutionReview(undefined);
                    }
                    try {
                      await load();
                    } catch (error) {
                      throw new Error(
                        "Execution finished. History refresh failed: " +
                          (error instanceof Error
                            ? error.message
                            : String(error)),
                      );
                    }
                  }, generation);
                }}
              >
                Execute reviewed SQL
              </button>
            </>
          }
        >
          {error ? (
            <p role="alert" className="text-label text-refuse wrap-anywhere">
              {error}
            </p>
          ) : null}
          <p className="text-label">
            <strong>{executionReview.targetLabel}</strong>
          </p>
          <p className="text-caption wrap-anywhere">
            <code>{executionReview.path}</code> ·{" "}
            {executionReview.command.intent}
          </p>
          <ul className="text-caption leading-[1.8]">
            {executionReview.effects.map((effect) => (
              <li key={effect}>{effect}</li>
            ))}
          </ul>
          <pre className={sqlPreClasses}>{executionReview.command.sql}</pre>
          <p className="text-caption">
            Bound values:{" "}
            <code className="wrap-anywhere">
              {JSON.stringify(executionReview.parameters)}
            </code>
          </p>
          <details>
            <summary className="min-h-8 cursor-pointer py-1 text-caption text-graphite">
              Target identity
            </summary>
            <code className="text-caption wrap-anywhere">
              {executionReview.targetIdentity}
            </code>
          </details>
          <label className={sqlLabelClasses}>
            Type <code>{executionReview.confirmation}</code>
            <TextInput
              aria-label="SQL execution confirmation"
              autoComplete="off"
              value={approval}
              onChange={(event) => setApproval(event.target.value)}
              className="w-full"
            />
          </label>
        </WorkbenchDialog>
      ) : null}
      {pendingCommand || departure.status === "blocked" ? createPortal(
        <WorkbenchDialog
          title="Discard SQL draft?"
          busy={busy}
          onClose={closeGuard}
          footer={
            <>
              <button
                className={buttonClasses({ variant: "quiet" })}
                onClick={closeGuard}
              >
                Keep editing
              </button>
              <button
                className={buttonClasses({ variant: "primary" })}
                disabled={busy}
                onClick={discardAndContinue}
              >
                Discard and continue
              </button>
            </>
          }
        >
          <p className="text-label">
            {busy
              ? "Wait for the current SQL operation to finish before leaving."
              : "Your SQL changes have not been saved. Discard them to continue."}
          </p>
        </WorkbenchDialog>, document.body
      ) : null}
    </div>
  );
}
