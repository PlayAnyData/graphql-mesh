import { GraphQLSchema } from 'graphql';
import { MeshFetch } from '@graphql-mesh/types';
import { createDefaultExecutor } from '@graphql-tools/delegate';
import { processDirectives } from './directives.js';
import {
  loadGraphQLSchemaFromJSONSchemas,
  loadNonExecutableGraphQLSchemaFromJSONSchemas,
} from './loadGraphQLSchemaFromJSONSchemas.js';
import { JSONSchemaLoaderOptions } from './types.js';

export default loadGraphQLSchemaFromJSONSchemas;
export * from './loadGraphQLSchemaFromJSONSchemas.js';
export * from './getComposerFromJSONSchema.js';
export * from './getDereferencedJSONSchemaFromOperations.js';
export * from './getGraphQLSchemaFromDereferencedJSONSchema.js';
export * from './types.js';
export { processDirectives } from './directives.js';

export function loadJSONSchemaSubgraph(name: string, options: JSONSchemaLoaderOptions) {
  return (ctx: { fetch: MeshFetch; cwd: string }) => ({
    name,
    schema$: loadNonExecutableGraphQLSchemaFromJSONSchemas(name, {
      ...options,
      fetch: ctx.fetch,
      cwd: ctx.cwd,
    }),
  });
}

export interface RESTTransportEntry {
  kind: 'rest';
  location: string;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
}

export function getSubgraphExecutor(
  _options: RESTTransportEntry,
  getSubgraph: () => GraphQLSchema,
) {
  return createDefaultExecutor(processDirectives(getSubgraph()));
}
