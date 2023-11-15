import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { GraphQLSchema, parse } from 'graphql';
import { getComposedSchemaFromConfig } from '@graphql-mesh/compose-cli';
import { getExecutorForSupergraph } from '@graphql-mesh/fusion-runtime';
import { printSchemaWithDirectives } from '@graphql-tools/utils';
import { getSubgraphExecutor } from '@omnigraph/soap';
import { composeConfig } from '../mesh.config';

describe('SOAP Country Info', () => {
  let supergraph: GraphQLSchema;
  beforeAll(async () => {
    supergraph = await getComposedSchemaFromConfig({
      ...composeConfig,
      cwd: join(__dirname, '..'),
    });
  });
  it('generates the schema correctly', () => {
    expect(printSchemaWithDirectives(supergraph)).toMatchSnapshot('schema');
  });
  const queryNames = readdirSync(join(__dirname, '../example-queries'));
  for (const queryName of queryNames) {
    it(`executes ${queryName} query`, async () => {
      const supergraphExecutor = getExecutorForSupergraph(
        supergraph,
        (transportEntry, getSubgraph) => {
          if (transportEntry.kind === 'soap') {
            return getSubgraphExecutor(
              {
                ...transportEntry,
                kind: 'soap',
              },
              getSubgraph,
            );
          }
          throw new Error(`Unsupported transport kind: ${transportEntry.kind}`);
        },
      );
      const query = readFileSync(join(__dirname, '../example-queries', queryName), 'utf8');
      const result = await supergraphExecutor({
        document: parse(query),
      });
      expect(result).toMatchSnapshot(queryName);
    });
  }
});
