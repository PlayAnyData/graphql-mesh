import { GraphQLSchema } from 'graphql';
import { ProcessDirectiveArgs } from 'packages/loaders/json-schema/src/directives.js';
import { MeshFetch } from '@graphql-mesh/types';
import { createDefaultExecutor } from '@graphql-tools/delegate';
import {
  loadNonExecutableGraphQLSchemaFromOpenAPI,
  processDirectives,
} from './loadGraphQLSchemaFromOpenAPI.js';
import { OpenAPILoaderOptions } from './types.js';

export { loadGraphQLSchemaFromOpenAPI as default } from './loadGraphQLSchemaFromOpenAPI.js';
export * from './loadGraphQLSchemaFromOpenAPI.js';
export { getJSONSchemaOptionsFromOpenAPIOptions } from './getJSONSchemaOptionsFromOpenAPIOptions.js';
export { OpenAPILoaderOptions } from './types.js';

export function loadOpenAPISubgraph(name: string, options: OpenAPILoaderOptions) {
  return (ctx: { fetch: MeshFetch; cwd: string }) => ({
    name,
    schema$: loadNonExecutableGraphQLSchemaFromOpenAPI(name, {
      ...options,
      fetch: ctx.fetch,
      cwd: ctx.cwd,
    }),
  });
}

export interface OpenAPITransportEntry {
  kind: 'rest';
  location: string;
  headers: Record<string, string>;
  options: ProcessDirectiveArgs;
}

export function getSubgraphExecutor(
  _transportEntry: OpenAPITransportEntry,
  getSubgraph: () => GraphQLSchema,
) {
  return createDefaultExecutor(processDirectives(getSubgraph()));
}
