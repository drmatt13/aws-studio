import { useStudio } from "../studio";
import { openAwsProfileConfiguration } from "../aws-profile-queries";
import { Button } from "../ui/Button";
import { cx } from "../ui/classes";

/**
 * The active declaration association supplies credentials; destinations remain explicit.
 * `field` sits in a row of labelled inspection fields: it takes a label like theirs and
 * centres its value on their 32px control row, so text and controls share one line.
 */
export function AwsConnectionSummary({ className, layout = "inline" }: {
  readonly className?: string;
  readonly layout?: "inline" | "field";
}) {
  const { mode, awsProfile } = useStudio();
  const value = (
    <>
      <span className="wrap-anywhere">
        {layout === "inline" ? "Connection: " : null}
        <strong>{awsProfile || "Choose an AWS profile"}</strong> · selected for{" "}
        {mode === "dev" ? "Development" : "Production"}
      </span>
      <Button variant="link" size="compact" onClick={openAwsProfileConfiguration}>
        {awsProfile ? "Manage connection" : "Choose connection"}
      </Button>
    </>
  );
  if (layout === "field")
    return (
      <div
        className={cx("m-0 flex min-w-0 max-w-full flex-none flex-col gap-1 text-label", className)}
        data-slot="aws-connection-summary"
      >
        <span>AWS connection</span>
        <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-caption">{value}</div>
      </div>
    );
  return (
    <div
      className={cx("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-caption", className)}
      data-slot="aws-connection-summary"
    >
      {value}
    </div>
  );
}
