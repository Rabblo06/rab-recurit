import { computeWorkspaceTableCopyOrder, FkGraphCycleError, TableEdge, WORKSPACE_FK_EDGES, WORKSPACE_TABLE_COPY_ORDER } from './fk-graph';
import { WORKSPACE_TABLES } from '../provision-workspace-schema';

describe('computeWorkspaceTableCopyOrder', () => {
  it('produces every one of the 15 workspace tables, each exactly once', () => {
    expect(new Set(WORKSPACE_TABLE_COPY_ORDER).size).toBe(15);
    expect([...WORKSPACE_TABLE_COPY_ORDER].sort()).toEqual([...WORKSPACE_TABLES].sort());
  });

  it('places every table strictly after everything it depends on (the actual safety property, not just "some order")', () => {
    const position = new Map(WORKSPACE_TABLE_COPY_ORDER.map((t, i) => [t, i]));
    for (const edge of WORKSPACE_FK_EDGES) {
      expect(position.get(edge.from)!).toBeGreaterThan(position.get(edge.to)!);
    }
  });

  it('is deterministic — recomputing from the same input always returns the same order', () => {
    const again = computeWorkspaceTableCopyOrder([...WORKSPACE_TABLES]);
    expect(again).toEqual(WORKSPACE_TABLE_COPY_ORDER);
  });

  it('places user_note among the roots (it has no workspace-to-workspace FK)', () => {
    const position = new Map(WORKSPACE_TABLE_COPY_ORDER.map((t, i) => [t, i]));
    // Every table user_note has no dependency on sorts no later than it does — i.e. it is a root.
    expect(WORKSPACE_FK_EDGES.some((e) => e.from === 'user_note')).toBe(false);
    expect(position.get('user_note')).toBeLessThan(position.get('replacement_request')!);
  });

  it('throws FkGraphCycleError, naming every table still stuck, when the graph has a real cycle', () => {
    const cyclicEdges: TableEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' },
    ];
    expect(() => computeWorkspaceTableCopyOrder(['a', 'b', 'c'], cyclicEdges)).toThrow(FkGraphCycleError);
    try {
      computeWorkspaceTableCopyOrder(['a', 'b', 'c'], cyclicEdges);
    } catch (error) {
      expect(error).toBeInstanceOf(FkGraphCycleError);
      expect([...(error as FkGraphCycleError).cycle].sort()).toEqual(['a', 'b', 'c']);
    }
  });

  it('ignores an edge whose tables are outside the requested set, rather than failing', () => {
    const order = computeWorkspaceTableCopyOrder(['x', 'y'], [{ from: 'x', to: 'y' }, { from: 'y', to: 'z' }]);
    expect(order).toEqual(['y', 'x']);
  });
});
