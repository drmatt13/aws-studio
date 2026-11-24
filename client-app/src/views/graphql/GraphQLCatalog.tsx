/** A Schema or Client catalog row's contents: the name, with its kind at the trailing edge. */
export function CatalogChoice({ name, kind }: { readonly name: string; readonly kind: string }) {
  return <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
    <span className="min-w-0 text-label font-medium wrap-anywhere">{name}</span>
    {/* Keep the kind readable on the resting, hover and selected surfaces. */}
    <span className="flex-none text-caption text-quiet">{kind}</span>
  </span>;
}

/** A catalog scrolls on its own so the selection beside it stays in view. */
export const catalogListClasses = "grid max-h-[min(60vh,560px)] content-start gap-1 overflow-y-auto";
