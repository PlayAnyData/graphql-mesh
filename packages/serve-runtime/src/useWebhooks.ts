/* eslint-disable import/no-extraneous-dependencies */
import { Plugin, YogaLogger } from 'graphql-yoga';
import { MeshPubSub } from '@graphql-mesh/types';
import { PubSub } from '@graphql-mesh/utils';

// TODO: Use Yoga PubSub later
export interface MeshWebhooksPluginOptions {
  pubsub?: MeshPubSub;
}
export function useWebhooks({ pubsub = new PubSub() }: MeshWebhooksPluginOptions = {}): Plugin {
  let logger: YogaLogger;
  return {
    onYogaInit({ yoga }) {
      logger = yoga.logger;
    },
    onRequest({ request, url, endResponse, fetchAPI }): void | Promise<void> {
      for (const eventName of pubsub.getEventNames()) {
        if (eventName === `webhook:${request.method.toLowerCase()}:${url.pathname}`) {
          return request.text().then(body => {
            logger.debug(`Received webhook request for ${url.pathname}`, body);
            pubsub.publish(
              eventName,
              request.headers.get('content-type') === 'application/json' ? JSON.parse(body) : body,
            );
            endResponse(
              new fetchAPI.Response(null, {
                status: 204,
                statusText: 'OK',
              }),
            );
          });
        }
      }
    },
    onContextBuilding({ extendContext }) {
      extendContext({
        pubsub,
      } as any);
    },
  };
}
