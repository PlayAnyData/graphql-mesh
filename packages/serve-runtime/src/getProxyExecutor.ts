import {
  defaultTransportsOption,
  getOnSubgraphExecute,
  TransportEntry,
} from '@graphql-mesh/fusion-runtime';
import { Executor } from '@graphql-tools/utils';
import { MeshServeConfigWithProxy } from './types';

export function getProxyExecutor<TContext>(
  config: MeshServeConfigWithProxy<TContext>,
  configContext: TContext,
): Executor {
  const fakeTransportEntryMap: Record<string, TransportEntry> = {};
  let subgraphName: string;
  const onSubgraphExecute = getOnSubgraphExecute({
    transports() {
      if (typeof config.transport === 'object') {
        return config.transport;
      }
      if (typeof config.transport === 'function') {
        return config.transport() as any;
      }
      return defaultTransportsOption('http');
    },
    transportEntryMap: new Proxy(fakeTransportEntryMap, {
      get(fakeTransportEntryMap, subgraphNameProp: string): TransportEntry {
        if (!fakeTransportEntryMap[subgraphNameProp]) {
          subgraphName = subgraphNameProp;
          fakeTransportEntryMap[subgraphNameProp] = {
            kind: 'http',
            subgraph: subgraphName.toString(),
            location: config.proxy?.endpoint,
            headers: config.proxy?.headers as any,
            options: config.proxy,
          };
        }
        return fakeTransportEntryMap[subgraphNameProp];
      },
    }),
    transportBaseContext: configContext,
  });
  return function (executionRequest) {
    return onSubgraphExecute(
      subgraphName,
      executionRequest.document,
      executionRequest.variables,
      executionRequest.context,
    );
  };
}
