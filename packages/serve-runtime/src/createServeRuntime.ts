import {
  buildASTSchema,
  buildSchema,
  isSchema,
  type DocumentNode,
  type GraphQLSchema,
} from 'graphql';
import { createYoga, FetchAPI, YogaLogger, YogaServerInstance, type Plugin } from 'graphql-yoga';
import { useSupergraph } from '@graphql-mesh/fusion-runtime';
// eslint-disable-next-line import/no-extraneous-dependencies
import { MeshFetch, OnFetchHook } from '@graphql-mesh/types';
// eslint-disable-next-line import/no-extraneous-dependencies
import { DefaultLogger, getHeadersObj, wrapFetchWithHooks } from '@graphql-mesh/utils';
import { buildHTTPExecutor } from '@graphql-tools/executor-http';
import { useExecutor } from '@graphql-tools/executor-yoga';
import { getStitchedSchemaFromSupergraphSdl } from '@graphql-tools/federation';
import {
  createGraphQLError,
  getDocumentNodeFromSchema,
  isDocumentNode,
} from '@graphql-tools/utils';
import { isPromise } from '@whatwg-node/server';
import { httpTransport } from './http-transport';
import {
  MeshHTTPPlugin,
  MeshHTTPHandlerConfiguration as MeshServeRuntimeConfiguration,
} from './types';

type SupergraphConfig =
  | GraphQLSchema
  | DocumentNode
  | string
  | (() => SupergraphConfig)
  | Promise<SupergraphConfig>;

export function createServeRuntime<TServerContext, TUserContext = {}>(
  config: MeshServeRuntimeConfiguration<TServerContext, TUserContext>,
): YogaServerInstance<TServerContext, TUserContext> & { invalidateSupergraph(): void } {
  let transportImportFn: (handlerName: string) => Promise<any> | any;
  if (config.transports != null) {
    if (typeof config.transports === 'function') {
      transportImportFn = config.transports as any;
    } else {
      transportImportFn = (handlerName: string) => (config.transports as any)[handlerName];
    }
  } else {
    transportImportFn = defaultTransportImport;
  }

  let fetchAPI: FetchAPI = config.fetchAPI;
  // eslint-disable-next-line prefer-const
  let logger: YogaLogger;

  // TODO: Move these to other packages later

  function defaultTransportImport(handlerName: string) {
    if (handlerName === 'http') {
      return httpTransport;
    }
    if (handlerName === 'rest') {
      const omnigraphPackageName = '@omnigraph/json-schema';
      return import(omnigraphPackageName);
    }
    const omnigraphPackageName = `@omnigraph/${handlerName}`;
    return import(omnigraphPackageName);
  }

  const supergraphSpec = config.spec || 'fusion';

  let supergraphYogaPlugin: Plugin<TServerContext> & { invalidateSupergraph: () => void };

  if (config.http) {
    const executor = buildHTTPExecutor({
      fetch: fetchAPI?.fetch,
      ...config.http,
    });
    supergraphYogaPlugin = {
      ...useExecutor(executor),
      invalidateSupergraph() {},
    };
  } else if (supergraphSpec === 'fusion') {
    supergraphYogaPlugin = useSupergraph({
      getSupergraph() {
        return handleSupergraphConfig(config.supergraph, yoga.logger);
      },
      getTransportExecutor(transportEntry, getSubgraph, subgraphName) {
        function handleImportResult(importRes: any) {
          const getSubgraphExecutor = importRes.getSubgraphExecutor;
          if (!getSubgraphExecutor) {
            throw createGraphQLError(
              `getSubgraphExecutor is not exported from the transport: ${transportEntry.kind}`,
            );
          }
          return getSubgraphExecutor(transportEntry, getSubgraph);
        }
        logger.info(`Loading transport "${transportEntry?.kind}" for subgraph "${subgraphName}"`);
        const importRes$ = transportImportFn(transportEntry.kind);
        if (isPromise(importRes$)) {
          return importRes$.then(handleImportResult);
        }
        return handleImportResult(importRes$);
      },
      polling: config.polling,
    });
  } else if (supergraphSpec === 'federation') {
    let supergraph: GraphQLSchema;
    // eslint-disable-next-line no-inner-declarations
    function getAndSetSupergraph(): Promise<void> | void {
      const newSupergraph$ = handleSupergraphConfig(config.supergraph, yoga.logger);
      if (isPromise(newSupergraph$)) {
        return newSupergraph$
          .then(newSupergraph => {
            supergraph = getStitchedSchemaFromSupergraphSdl({
              supergraphSdl: getDocumentNodeFromSchema(newSupergraph),
            });
          })
          .catch(e => {
            yoga.logger.error(`Failed to load the new Supergraph: ${e.stack}`);
          });
      }
      supergraph = getStitchedSchemaFromSupergraphSdl({
        supergraphSdl: getDocumentNodeFromSchema(newSupergraph$),
      });
    }
    let initialSupergraph$: Promise<void> | void;
    supergraphYogaPlugin = {
      onRequestParse() {
        return {
          onRequestParseDone() {
            initialSupergraph$ ||= getAndSetSupergraph();
            return initialSupergraph$;
          },
        };
      },
      onEnveloped({ setSchema }: { setSchema: (schema: GraphQLSchema) => void }) {
        setSchema(supergraph);
      },
      invalidateSupergraph() {
        return getAndSetSupergraph();
      },
    };
  }

  const defaultFetchPlugin: MeshHTTPPlugin<TServerContext, {}> = {
    onFetch({ setFetchFn }) {
      setFetchFn(fetchAPI.fetch);
    },
    onYogaInit({ yoga }) {
      const onFetchHooks: OnFetchHook<TServerContext>[] = [];

      for (const plugin of yoga.getEnveloped._plugins as MeshHTTPPlugin<TServerContext, {}>[]) {
        if (plugin.onFetch) {
          onFetchHooks.push(plugin.onFetch);
        }
      }

      wrappedFetchFn = wrapFetchWithHooks(onFetchHooks);
    },
  };

  let wrappedFetchFn: MeshFetch;

  const yoga = createYoga<TServerContext>({
    fetchAPI: config.fetchAPI,
    logging: config.logging == null ? new DefaultLogger() : config.logging,
    plugins: [defaultFetchPlugin, ...(config.plugins || []), supergraphYogaPlugin],
    context({ request, req, connectionParams }: any) {
      // Maybe Node-like environment
      if (req?.headers) {
        return {
          fetch: wrappedFetchFn,
          logger,
          headers: getHeadersObj(req.headers),
          connectionParams,
        };
      }
      // Fetch environment
      if (request?.headers) {
        return {
          fetch: wrappedFetchFn,
          logger,
          headers: getHeadersObj(request.headers),
          connectionParams,
        };
      }
      return {};
    },
    cors: config.cors,
    graphiql: config.graphiql,
    batching: config.batching,
  });

  fetchAPI ||= yoga.fetchAPI;
  logger = yoga.logger;

  Object.defineProperty(yoga, 'invalidateSupergraph', {
    value: supergraphYogaPlugin.invalidateSupergraph,
    configurable: true,
  });

  return yoga as any;
}

function handleSupergraphConfig(
  supergraphConfig: SupergraphConfig,
  logger: YogaLogger,
): Promise<GraphQLSchema> | GraphQLSchema {
  if (isPromise(supergraphConfig)) {
    return supergraphConfig.then(newConfig => handleSupergraphConfig(newConfig, logger));
  }
  if (typeof supergraphConfig === 'function') {
    return handleSupergraphConfig(supergraphConfig(), logger);
  }
  if (isSchema(supergraphConfig)) {
    return supergraphConfig;
  }
  if (typeof supergraphConfig === 'string') {
    try {
      return buildSchema(supergraphConfig, {
        assumeValid: true,
        assumeValidSDL: true,
      });
    } catch (e) {
      logger.error(`Failed to load Supergraph from ${supergraphConfig}`);
      throw e;
    }
  }
  if (isDocumentNode(supergraphConfig)) {
    return buildASTSchema(supergraphConfig, {
      assumeValid: true,
      assumeValidSDL: true,
    });
  }
  throw new Error(
    `Invalid Supergraph config: ${supergraphConfig}. It can be an SDL string, a GraphQLSchema, a DocumentNode or a function that returns any of these`,
  );
}
