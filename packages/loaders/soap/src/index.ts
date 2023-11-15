import { GraphQLSchema } from 'graphql';
import { MeshFetch } from '@graphql-mesh/types';
import { defaultImportFn, DefaultLogger, readFileOrUrl } from '@graphql-mesh/utils';
import { createExecutorFromSchemaAST } from './executor.js';
import { SOAPLoader } from './SOAPLoader.js';

export * from './SOAPLoader.js';
export * from './types.js';
export * from './executor.js';

export interface SOAPSubgraphLoaderOptions {
  source?: string;
  fetch?: MeshFetch;
  schemaHeaders?: Record<string, string>;
  operationHeaders?: Record<string, string>;
}

export function loadSOAPSubgraph(subgraphName: string, options: SOAPSubgraphLoaderOptions) {
  return ({ cwd, fetch }: { cwd: string; fetch: MeshFetch }) => {
    const soapLoader = new SOAPLoader({
      subgraphName,
      fetch: options.fetch || fetch,
      schemaHeaders: options.schemaHeaders,
      operationHeaders: options.operationHeaders,
    });
    return {
      name: subgraphName,
      schema$: readFileOrUrl<string>(options.source, {
        allowUnknownExtensions: true,
        cwd,
        fetch: options.fetch || fetch,
        importFn: defaultImportFn,
        logger: new DefaultLogger(`SOAP Subgraph ${subgraphName}`),
      })
        .then(wsdl => soapLoader.loadWSDL(wsdl))
        .then(object => {
          soapLoader.loadedLocations.set(options.source, object);
          return soapLoader.buildSchema();
        }),
    };
  };
}

export interface SOAPTransportEntry {
  subgraph: string;
  kind: 'soap';
  location: string;
  headers: Record<string, string>;
}

export function getSubgraphExecutor(
  _transportEntry: SOAPTransportEntry,
  getSubgraph: () => GraphQLSchema,
) {
  return createExecutorFromSchemaAST(getSubgraph());
}
