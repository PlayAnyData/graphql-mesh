import {
  buildASTSchema,
  buildSchema,
  DocumentNode,
  execute,
  ExecutionResult,
  GraphQLSchema,
  introspectionFromSchema,
  isSchema,
  valueFromASTUntyped,
} from 'graphql';
import type { Plugin } from 'graphql-yoga';
import {
  createExecutablePlanForOperation,
  ExecutableOperationPlan,
  executeOperationPlan,
  extractSubgraphFromSupergraph,
} from '@graphql-mesh/fusion-execution';
// eslint-disable-next-line import/no-extraneous-dependencies
import { iterateAsync } from '@graphql-mesh/utils';
import { defaultMergedResolver } from '@graphql-tools/delegate';
import { addResolversToSchema } from '@graphql-tools/schema';
import {
  asArray,
  ExecutionRequest,
  Executor,
  getDirective,
  IResolvers,
  isAsyncIterable,
  isPromise,
  mapAsyncIterator,
  memoize2of4,
} from '@graphql-tools/utils';
import { wrapSchema } from '@graphql-tools/wrap';

export type TransportEntry = {
  kind: string;
  location: string;
  headers: Record<string, string>;
  options: any;
  subgraph: string;
};

function getTransportDirectives(supergraph: GraphQLSchema) {
  const transportDirectives = getDirective(supergraph, supergraph, 'transport');
  if (transportDirectives?.length) {
    return transportDirectives;
  }
  const astNode = supergraph.astNode;
  if (astNode?.directives?.length) {
    return astNode.directives
      .filter(directive => directive.name.value === 'transport')
      .map(transportDirective =>
        Object.fromEntries(
          transportDirective.arguments?.map(argument => [
            argument.name.value,
            valueFromASTUntyped(argument.value),
          ]),
        ),
      );
  }
  return [];
}

export function getSubgraphTransportMapFromSupergraph(supergraph: GraphQLSchema) {
  const subgraphTransportEntryMap: Record<string, TransportEntry> = {};
  const transportDirectives = getTransportDirectives(supergraph);
  for (const { kind, subgraph, location, headers, ...options } of transportDirectives) {
    subgraphTransportEntryMap[subgraph] = {
      kind,
      location,
      headers,
      options,
      subgraph,
    };
  }
  return subgraphTransportEntryMap;
}

export const getMemoizedExecutionPlanForOperation = memoize2of4(
  function getMemoizedExecutionPlanForOperation(
    supergraph: GraphQLSchema,
    document: DocumentNode,
    operationName?: string,
    _random?: number,
  ) {
    return createExecutablePlanForOperation({
      supergraph,
      document,
      operationName,
    });
  },
);

export function getExecutorForSupergraph(
  supergraph: GraphQLSchema,
  getTransportExecutor: (
    transportEntry: TransportEntry,
    getSubgraph: () => GraphQLSchema,
    subgraphName: string,
  ) => Executor | Promise<Executor>,
  plugins?: SupergraphPlugin[],
): Executor {
  const onSubgraphExecuteHooks: OnSubgraphExecuteHook[] = [];
  if (plugins) {
    for (const plugin of plugins) {
      if (plugin.onSubgraphExecute) {
        onSubgraphExecuteHooks.push(plugin.onSubgraphExecute);
      }
    }
  }
  const transportEntryMap = getSubgraphTransportMapFromSupergraph(supergraph);
  const executorMap: Record<string, Executor> = {};
  return function supergraphExecutor(execReq: ExecutionRequest) {
    function onSubgraphExecute(
      subgraphName: string,
      document: DocumentNode,
      variables: any,
      context: any,
    ) {
      let executor: Executor = executorMap[subgraphName];
      if (executor == null) {
        const transportEntry = transportEntryMap[subgraphName];
        // eslint-disable-next-line no-inner-declarations
        function wrapExecutorWithHooks(currentExecutor: Executor) {
          if (onSubgraphExecuteHooks.length) {
            return function executorWithHooks(subgraphExecReq: ExecutionRequest) {
              const onSubgraphExecuteDoneHooks: OnSubgraphExecuteDoneHook[] = [];
              const onSubgraphExecuteHooksRes$ = iterateAsync(
                onSubgraphExecuteHooks,
                onSubgraphExecuteHook =>
                  onSubgraphExecuteHook({
                    supergraph,
                    subgraphName,
                    transportKind: transportEntry?.kind,
                    transportLocation: transportEntry?.location,
                    transportHeaders: transportEntry?.headers,
                    transportOptions: transportEntry?.options,
                    executionRequest: subgraphExecReq,
                    executor: currentExecutor,
                    setExecutor(newExecutor: Executor) {
                      currentExecutor = newExecutor;
                    },
                  }),
                onSubgraphExecuteDoneHooks,
              );
              function handleOnSubgraphExecuteHooksResult() {
                if (onSubgraphExecuteDoneHooks.length) {
                  // eslint-disable-next-line no-inner-declarations
                  function handleExecutorResWithHooks(currentResult: ExecutionResult) {
                    const onSubgraphExecuteDoneHooksRes$ = iterateAsync(
                      onSubgraphExecuteDoneHooks,
                      onSubgraphExecuteDoneHook =>
                        onSubgraphExecuteDoneHook({
                          result: currentResult,
                          setResult(newResult: ExecutionResult) {
                            currentResult = newResult;
                          },
                        }),
                    );
                    if (isPromise(onSubgraphExecuteDoneHooksRes$)) {
                      return onSubgraphExecuteDoneHooksRes$.then(() => currentResult);
                    }
                    return currentResult;
                  }
                  const executorRes$ = currentExecutor(subgraphExecReq);
                  if (isPromise(executorRes$)) {
                    return executorRes$.then(handleExecutorResWithHooks);
                  }
                  if (isAsyncIterable(executorRes$)) {
                    return mapAsyncIterator(executorRes$ as any, handleExecutorResWithHooks);
                  }
                  return handleExecutorResWithHooks(executorRes$);
                }
                return currentExecutor(subgraphExecReq);
              }
              if (isPromise(onSubgraphExecuteHooksRes$)) {
                return onSubgraphExecuteHooksRes$.then(handleOnSubgraphExecuteHooksResult);
              }
              return handleOnSubgraphExecuteHooksResult();
            };
          }
          return currentExecutor;
        }
        executor = function lazyExecutor(subgraphExecReq: ExecutionRequest) {
          const executor$ = getTransportExecutor(
            transportEntry,
            function getSubgraph() {
              return extractSubgraphFromSupergraph(subgraphName, supergraph);
            },
            subgraphName,
          );
          if (isPromise(executor$)) {
            return executor$.then(executor_ => {
              executor = wrapExecutorWithHooks(executor_) as Executor;
              executorMap[subgraphName] = executor;
              return executor(subgraphExecReq);
            });
          }
          executor = wrapExecutorWithHooks(executor$) as Executor;
          executorMap[subgraphName] = executor;
          return executor(subgraphExecReq);
        };
      }
      return executor({ document, variables, context });
    }

    const executablePlan = getMemoizedExecutionPlanForOperation(
      supergraph,
      execReq.document,
      execReq.operationName,
    );
    return executeOperationPlan({
      executablePlan,
      onExecute: onSubgraphExecute,
      variables: execReq.variables,
      context: execReq.context,
    });
  };
}

export interface PlanCache {
  get(documentStr: string): Promise<ExecutableOperationPlan> | ExecutableOperationPlan;
  set(documentStr: string, plan: ExecutableOperationPlan): Promise<any> | any;
}

export interface YogaSupergraphPluginOptions<TServerContext, TUserContext> {
  getSupergraph():
    | GraphQLSchema
    | DocumentNode
    | string
    | Promise<GraphQLSchema | string | DocumentNode>;
  getTransportExecutor(
    transportEntry: TransportEntry,
    getSubgraph: () => GraphQLSchema,
    subgraphName: string,
  ): Executor | Promise<Executor>;
  planCache?: PlanCache;
  polling?: number;
  additionalResolvers?:
    | IResolvers<unknown, TServerContext & TUserContext>
    | IResolvers<unknown, TServerContext & TUserContext>[];
}

function ensureSchema(source: GraphQLSchema | DocumentNode | string) {
  if (isSchema(source)) {
    return source;
  }
  if (typeof source === 'string') {
    return buildSchema(source, { noLocation: true, assumeValidSDL: true, assumeValid: true });
  }
  return buildASTSchema(source, { assumeValidSDL: true, assumeValid: true });
}

function getExecuteFnFromExecutor(executor: Executor): typeof execute {
  return function executeFnFromExecutor({
    document,
    variableValues,
    contextValue,
    rootValue,
    operationName,
  }) {
    return executor({
      document,
      variables: variableValues,
      context: contextValue,
      operationName,
      rootValue,
    }) as Promise<ExecutionResult>;
  };
}

export function useSupergraph<TServerContext, TUserContext>(
  opts: YogaSupergraphPluginOptions<TServerContext, TUserContext>,
): Plugin<{}, TServerContext, TUserContext> & { invalidateSupergraph(): void } {
  let supergraph: GraphQLSchema;
  let executeFn: typeof execute;
  let executor: Executor;
  let plugins: SupergraphPlugin[];
  function getAndSetSupergraph(): Promise<void> | void {
    const supergraph$ = opts.getSupergraph();
    function handleLoadedSupergraph(loadedSupergraph: string | GraphQLSchema | DocumentNode) {
      supergraph = ensureSchema(loadedSupergraph);
      executor = getExecutorForSupergraph(supergraph, opts.getTransportExecutor, plugins);
      if (opts.additionalResolvers != null) {
        supergraph = wrapSchema({
          schema: supergraph,
          executor,
        });
        const additionalResolvers = asArray(opts.additionalResolvers);
        for (const additionalResolversObj of additionalResolvers) {
          supergraph = addResolversToSchema({
            schema: supergraph,
            resolvers: additionalResolversObj,
            updateResolversInPlace: true,
            defaultFieldResolver: defaultMergedResolver,
          });
        }
      } else {
        executeFn = getExecuteFnFromExecutor(executor);
      }
    }
    if (isPromise(supergraph$)) {
      return supergraph$.then(handleLoadedSupergraph);
    } else {
      return handleLoadedSupergraph(supergraph$);
    }
  }
  if (opts.polling) {
    setInterval(getAndSetSupergraph, opts.polling);
  }

  let initialSupergraph$: Promise<void> | void;
  let initiated = false;
  return {
    onYogaInit({ yoga }) {
      plugins = yoga.getEnveloped._plugins as SupergraphPlugin[];
    },
    onRequestParse() {
      return {
        onRequestParseDone() {
          if (!initiated) {
            initialSupergraph$ = getAndSetSupergraph();
          }
          initiated = true;
          return initialSupergraph$;
        },
      };
    },
    onEnveloped({ setSchema }: { setSchema: (schema: GraphQLSchema) => void }) {
      setSchema(supergraph);
    },
    onExecute({ setExecuteFn, args }) {
      if (executeFn) {
        if (args.operationName === 'IntrospectionQuery') {
          setExecuteFn(() => ({
            data: introspectionFromSchema(supergraph) as any,
          }));
          return;
        }
        setExecuteFn(executeFn);
      }
    },
    onSubscribe({ setSubscribeFn }) {
      if (executeFn) {
        setSubscribeFn(executeFn);
      }
    },
    invalidateSupergraph() {
      return getAndSetSupergraph();
    },
  };
}

export interface SupergraphPlugin {
  onSubgraphExecute?: OnSubgraphExecuteHook;
}

export type OnSubgraphExecuteHook = (
  payload: OnSupergraphExecutePayload,
) => Promise<OnSubgraphExecuteDoneHook> | OnSubgraphExecuteDoneHook;

export interface OnSupergraphExecutePayload {
  supergraph: GraphQLSchema;
  subgraphName: string;
  transportKind: string;
  transportLocation: string;
  transportHeaders: Record<string, string>;
  transportOptions: any;
  executionRequest: ExecutionRequest;
  executor: Executor;
  setExecutor(executor: Executor): void;
}

export interface OnSubgraphExecuteDonePayload {
  result: ExecutionResult;
  setResult(result: ExecutionResult): void;
}

export type OnSubgraphExecuteDoneHook = (
  payload: OnSubgraphExecuteDonePayload,
) => Promise<void> | void;
