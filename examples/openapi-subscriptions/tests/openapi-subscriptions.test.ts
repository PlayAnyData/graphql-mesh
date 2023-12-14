import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { ExecutionResult } from 'graphql';
import { createServeRuntime, useCustomFetch } from '@graphql-mesh/serve-runtime';
import { createApp } from '../api/app';
import { serveConfig } from '../mesh.config';

describe('OpenAPI Subscriptions', () => {
  if (process.versions.node.startsWith('14')) {
    it('dummy', () => {});
    return;
  }
  let appWrapper: ReturnType<typeof createApp>;
  let meshServeRuntime: ReturnType<typeof createServeRuntime>;
  beforeAll(() => {
    meshServeRuntime = createServeRuntime({
      ...serveConfig,
      supergraph() {
        return readFileSync(join(__dirname, '..', 'supergraph.graphql'), 'utf8');
      },
      plugins: [
        useCustomFetch((...args) => (appWrapper.app as any).fetch(...args)),
        ...serveConfig.plugins,
      ],
    });
    appWrapper = createApp((...args) => (meshServeRuntime.fetch as any)(...args));
  });
  afterAll(() => {
    appWrapper.dispose();
  });
  it('should work', async () => {
    expect.assertions(2);
    const startWebhookMutation = await readFile(
      join(__dirname, '..', 'example-queries', 'startWebhook.mutation.graphql'),
      'utf8',
    );

    const startWebhookResponse = await meshServeRuntime.fetch('http://localhost:4000/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: startWebhookMutation,
      }),
    });

    const startWebhookResult = (await startWebhookResponse.json()) as ExecutionResult;

    expect(startWebhookResult).toMatchObject({
      data: {
        post_streams: {
          subscriptionId: expect.any(String),
        },
      },
    });

    const listenWebhookSubscription = await readFile(
      join(__dirname, '..', 'example-queries', 'listenWebhook.subscription.graphql'),
      'utf8',
    );

    const listenWebhookResponse = await meshServeRuntime.fetch('http://localhost:4000/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        query: listenWebhookSubscription,
        variables: {
          subscriptionId: (startWebhookResult.data?.post_streams as any).subscriptionId,
        },
      }),
    });

    for await (const chunk of listenWebhookResponse.body!) {
      const chunkStr = Buffer.from(chunk).toString('utf8').trim();
      if (chunkStr.includes('data: ')) {
        expect(chunkStr).toContain(
          `data: ${JSON.stringify({
            data: {
              onData: {
                userData: 'RANDOM_DATA',
              },
            },
          })}`,
        );
        break;
      }
    }
  });
});
