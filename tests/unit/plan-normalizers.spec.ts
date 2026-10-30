import { describe, expect, it } from 'vitest';
import { normalizePostgresPlan } from '../../src/adapters/postgres/postgres-plan-parser.js';
import { normalizeSqlServerPlanXml } from '../../src/adapters/sqlserver/sqlserver-plan-parser.js';

describe('Execution Plan Normalizers (PostgreSQL EXPLAIN JSON & SQL Server SHOWPLAN_XML)', () => {
  it('normalizes PostgreSQL Seq Scan and unconditional Nested Loop join accurately', () => {
    const explainJson = [
      {
        Plan: {
          'Node Type': 'Nested Loop',
          'Plan Rows': 50000,
          'Total Cost': 1245.75,
          Plans: [
            {
              'Node Type': 'Seq Scan',
              'Relation Name': 'clientes',
              'Plan Rows': 500,
              'Total Cost': 15.0
            },
            {
              'Node Type': 'Index Scan',
              'Relation Name': 'pedidos',
              'Plan Rows': 100,
              'Total Cost': 8.5
            }
          ]
        }
      }
    ];

    const profile = normalizePostgresPlan(explainJson, 'postgres-test');
    expect(profile.hasFullScan).toBe(true);
    expect(profile.hasUnconditionalJoin).toBe(true);
    expect(profile.estimatedRows).toBe(50000);
    expect(profile.estimatedCost).toBe(1245.75);
  });

  it('normalizes PostgreSQL Index Scan with Hash Cond join as low-risk', () => {
    const explainJson = [
      {
        Plan: {
          'Node Type': 'Hash Join',
          'Hash Cond': '(p.cliente_id = c.id)',
          'Plan Rows': 12,
          'Total Cost': 4.2,
          Plans: [
            {
              'Node Type': 'Index Scan',
              'Relation Name': 'pedidos',
              'Index Cond': '(cliente_id = 42)',
              'Plan Rows': 12,
              'Total Cost': 2.1
            },
            {
              'Node Type': 'Index Scan',
              'Relation Name': 'clientes',
              'Index Cond': '(id = 42)',
              'Plan Rows': 1,
              'Total Cost': 1.1
            }
          ]
        }
      }
    ];

    const profile = normalizePostgresPlan(explainJson, 'postgres-test');
    expect(profile.hasFullScan).toBe(false);
    expect(profile.hasUnconditionalJoin).toBe(false);
    expect(profile.estimatedRows).toBe(12);
    expect(profile.estimatedCost).toBe(4.2);
  });

  it('normalizes SQL Server SHOWPLAN_XML with Table Scan and NoJoinPredicate="1"', () => {
    const showplanXml = `
      <ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan">
        <BatchSequence>
          <Batch>
            <Statements>
              <StmtSimple StatementText="SELECT * FROM clientes, pedidos">
                <QueryPlan>
                  <RelOp NodeId="0" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="25000" EstimatedTotalSubtreeCost="48.92" NoJoinPredicate="1">
                    <NestedLoops Optimized="0">
                      <RelOp NodeId="1" PhysicalOp="Table Scan" LogicalOp="Table Scan" EstimateRows="500" EstimatedTotalSubtreeCost="1.2" />
                      <RelOp NodeId="2" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="50" EstimatedTotalSubtreeCost="0.4" />
                    </NestedLoops>
                  </RelOp>
                </QueryPlan>
              </StmtSimple>
            </Statements>
          </Batch>
        </BatchSequence>
      </ShowPlanXML>
    `;

    const profile = normalizeSqlServerPlanXml(showplanXml, 'sqlserver-test');
    expect(profile.hasFullScan).toBe(true);
    expect(profile.hasUnconditionalJoin).toBe(true);
    expect(profile.estimatedRows).toBe(25000);
    expect(profile.estimatedCost).toBe(48.92);
  });

  it('normalizes SQL Server SHOWPLAN_XML with Index Seek as low-risk', () => {
    const showplanXml = `
      <ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan">
        <BatchSequence>
          <Batch>
            <Statements>
              <StmtSimple StatementText="SELECT id FROM clientes WHERE id = @id">
                <QueryPlan>
                  <RelOp NodeId="0" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="1" EstimatedTotalSubtreeCost="0.0032831">
                    <IndexScan>
                      <SeekPredicates />
                    </IndexScan>
                  </RelOp>
                </QueryPlan>
              </StmtSimple>
            </Statements>
          </Batch>
        </BatchSequence>
      </ShowPlanXML>
    `;

    const profile = normalizeSqlServerPlanXml(showplanXml, 'sqlserver-test');
    expect(profile.hasFullScan).toBe(false);
    expect(profile.hasUnconditionalJoin).toBe(false);
    expect(profile.estimatedRows).toBe(1);
    expect(profile.estimatedCost).toBeCloseTo(0.0032831, 6);
  });
});
