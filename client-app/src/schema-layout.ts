import type { DeclaredSchema, SchemaTable } from "../shared/database";

export const TABLE_WIDTH = 340;
export const TABLE_HEADER = 70;
export const COLUMN_HEIGHT = 30;
export const tableHeight = (table: SchemaTable) => TABLE_HEADER + table.columns.length * COLUMN_HEIGHT + 35;
const GUTTER = 96;
const MARGIN = 48;
const GROUP_HEADER = 48;
const GROUP_RESOLUTION = 1.3;
type PositionedTable = { table: SchemaTable; x: number; y: number; height: number };

/** Cluster by foreign-key affinity, rather than Prisma declaration order or model names. */
function relationshipGroups(schema: DeclaredSchema) {
  const sorted = [...schema.tables].sort((a, b) => a.id.localeCompare(b.id));
  const neighbors = new Map(sorted.map(table => [table.id, new Map<string, number>()]));
  for (const relation of schema.relations) {
    if (relation.from === relation.to || !neighbors.has(relation.from) || !neighbors.has(relation.to)) continue;
    for (const [from, to] of [[relation.from, relation.to], [relation.to, relation.from]]) {
      const links = neighbors.get(from!)!;
      links.set(to!, (links.get(to!) ?? 0) + 1);
    }
  }
  const degree = (id: string) => [...neighbors.get(id)!.values()].reduce((sum, weight) => sum + weight, 0);
  const total = sorted.reduce((sum, table) => sum + degree(table.id), 0);
  const groups = sorted.map(table => [table]);
  // Greedy modularity joins dense neighborhoods without pulling every table into a shared hub.
  while (total) {
    let best = 0, pair: [number, number] | undefined;
    for (let a = 0; a < groups.length; a++) for (let b = a + 1; b < groups.length; b++) {
      const left = groups[a]!, right = groups[b]!;
      const weight = left.reduce((sum, table) => sum + right.reduce((n, other) => n + (neighbors.get(table.id)!.get(other.id) ?? 0), 0), 0);
      const gain = weight - left.reduce((sum, table) => sum + degree(table.id), 0)
        * right.reduce((sum, table) => sum + degree(table.id), 0) / total * GROUP_RESOLUTION;
      if (gain > best + 1e-9) { best = gain; pair = [a, b]; }
    }
    if (!pair) break;
    groups[pair[0]]!.push(...groups.splice(pair[1], 1)[0]!);
  }
  let orderedGroups = groups.map(members => {
    const affinity = (table: SchemaTable) => members.reduce((sum, other) => sum + (neighbors.get(table.id)!.get(other.id) ?? 0), 0);
    const ordered: SchemaTable[] = [];
    const remaining = [...members];
    while (remaining.length) {
      remaining.sort((a, b) => {
        const linked = (table: SchemaTable) => ordered.reduce((sum, other) => sum + (neighbors.get(table.id)!.get(other.id) ?? 0), 0);
        return linked(b) - linked(a) || affinity(b) - affinity(a) || degree(b.id) - degree(a.id) || a.id.localeCompare(b.id);
      });
      ordered.push(remaining.shift()!);
    }
    return ordered;
  }).sort((a, b) => b.length - a.length || a[0]!.id.localeCompare(b[0]!.id));
  const distance = (order: SchemaTable[][]) => {
    const positions = new Map(order.flatMap((members, index) => members.map(table => [table.id, index] as const)));
    return schema.relations.reduce((sum, relation) => sum + Math.abs((positions.get(relation.from) ?? 0) - (positions.get(relation.to) ?? 0)), 0);
  };
  // Put neighborhoods with shared foreign keys next to each other, keeping hubs between dependents.
  let cost = distance(orderedGroups);
  while (cost > 0) {
    let next = orderedGroups, nextCost = cost;
    for (let a = 0; a < orderedGroups.length; a++) for (let b = a + 1; b < orderedGroups.length; b++) {
      const candidate = [...orderedGroups];
      [candidate[a], candidate[b]] = [candidate[b]!, candidate[a]!];
      const candidateCost = distance(candidate);
      if (candidateCost < nextCost) { next = candidate; nextCost = candidateCost; }
    }
    if (nextCost === cost) break;
    orderedGroups = next; cost = nextCost;
  }
  return orderedGroups;
}

function packGroup(members: SchemaTable[], columns: number) {
  const bottoms = Array<number>(columns).fill(GROUP_HEADER);
  const tables = members.map(table => {
    const column = bottoms.indexOf(Math.min(...bottoms));
    const y = bottoms[column]!, height = tableHeight(table);
    bottoms[column] = y + height + GUTTER;
    return { table, x: MARGIN + column * (TABLE_WIDTH + GUTTER), y, height };
  });
  return { id: members[0]!.id, title: members[0]!.model, tables,
    width: MARGIN * 2 + columns * TABLE_WIDTH + (columns - 1) * GUTTER,
    height: Math.max(...bottoms) - GUTTER + MARGIN };
}

/** Compact relationship neighborhoods, balanced for an overview instead of fixed three-column rows. */
export function schemaLayout(schema: DeclaredSchema, aspectRatio = 1.5) {
  const aspect = Math.max(0.3, Math.min(4, aspectRatio));
  const neighborhoods = relationshipGroups(schema);
  const area = schema.tables.reduce((sum, table) => sum + (TABLE_WIDTH + GUTTER) * (tableHeight(table) + GUTTER), 0);
  const targetWidth = Math.max(600, Math.sqrt(area * aspect));
  let best: { groups: (ReturnType<typeof packGroup> & { x: number; y: number })[]; width: number; height: number; score: number } | undefined;
  // Try several shelf widths and local column counts; tall models no longer stretch an entire row.
  for (const columns of [1, 2, 3]) for (const factor of [0.7, 1, 1.3, 1.6]) {
    const groups: NonNullable<typeof best>["groups"] = [];
    let x = MARGIN, y = MARGIN, rowHeight = 0, width = 0;
    for (const members of neighborhoods) {
      const group = packGroup(members, Math.min(columns, members.length));
      if (x > MARGIN && x + group.width + MARGIN > targetWidth * factor) {
        x = MARGIN; y += rowHeight + MARGIN; rowHeight = 0;
      }
      groups.push({ ...group, x, y });
      width = Math.max(width, x + group.width + MARGIN);
      x += group.width + MARGIN;
      rowHeight = Math.max(rowHeight, group.height);
    }
    const height = Math.max(350, y + rowHeight + MARGIN);
    width = Math.max(480, width);
    const score = Math.max(width / aspect, height) ** 2 + width * height * 0.15;
    if (!best || score < best.score) best = { groups, width, height, score };
  }
  const groups = best!.groups;
  const tables: PositionedTable[] = groups.flatMap(group => group.tables.map(table => ({ ...table, x: table.x + group.x, y: table.y + group.y })));
  const positions = new Map(tables.map(entry => [entry.table.id, entry]));
  const edges = [...schema.relations].sort((a, b) => a.id.localeCompare(b.id)).flatMap((relation, index) => {
    const from = positions.get(relation.from), to = positions.get(relation.to);
    if (!from || !to) return [];
    const columnY = (entry: PositionedTable, field: string) => entry.y + TABLE_HEADER + Math.max(0, entry.table.columns.findIndex(column => column.name === field)) * COLUMN_HEIGHT + COLUMN_HEIGHT / 2;
    const y1 = columnY(from, relation.fields[0]!), y2 = columnY(to, relation.references[0]!);
    const goesRight = to.x > from.x, sameColumn = to.x === from.x;
    const x1 = from.x + (goesRight || sameColumn ? TABLE_WIDTH : 0);
    const x2 = to.x + (goesRight ? 0 : TABLE_WIDTH);
    const bend = sameColumn ? Math.max(x1, x2) + 24 + (index % 4) * 8 : (x1 + x2) / 2;
    const path = relation.from === relation.to
      ? `M ${x1} ${y1} C ${bend} ${y1}, ${bend} ${y1 - 44}, ${x1} ${y1 - 44} L ${x2} ${y2}`
      : `M ${x1} ${y1} C ${bend} ${y1}, ${bend} ${y2}, ${x2} ${y2}`;
    return [{ relation, path, label: { x: sameColumn ? bend + 6 : (x1 + x2) / 2, y: (y1 + y2) / 2 - 10 } }];
  });
  return { tables, groups, edges, width: best!.width, height: best!.height };
}
