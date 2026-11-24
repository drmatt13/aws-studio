import { useEffect, useMemo, useRef } from "react";
import { useStudio } from "../studio";
import { healthConditions, healthIndicator } from "./conditions";

/** Derives every health surface from one place, so the indicator, panel and toasts cannot disagree. */
export function useHealth(refreshFailure: string | undefined) {
  const { snapshot, response, live } = useStudio();
  const sourceWatch = live.sourceWatch ?? response.sourceWatch;
  const { models, source, repositoryRoot, generatedAt } = snapshot;
  const loaded = !Object.values(models).some((model) => model.stale);
  const lastLoadedAt = useRef<string | undefined>(undefined);
  useEffect(() => { if (loaded) lastLoadedAt.current = generatedAt; }, [loaded, generatedAt]);
  const conditions = useMemo(() => healthConditions({
    models, sourceProblems: source.problems, sourceWatch, repositoryRoot,
    ...(refreshFailure === undefined ? {} : { refreshFailure }),
    ...(lastLoadedAt.current ? { lastLoadedAt: lastLoadedAt.current } : {}),
  }), [models, source.problems, sourceWatch, repositoryRoot, refreshFailure]);
  const indicator = useMemo(() => healthIndicator(conditions), [conditions]);
  return { conditions, indicator };
}
