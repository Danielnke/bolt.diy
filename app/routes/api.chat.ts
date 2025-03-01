import { type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { createDataStream, generateId } from 'ai';
import { MAX_RESPONSE_SEGMENTS, MAX_TOKENS, type FileMap } from '~/lib/.server/llm/constants';
import { CONTINUE_PROMPT } from '~/lib/common/prompts/prompts';
import { streamText, type Messages, type StreamingOptions } from '~/lib/.server/llm/stream-text';
import SwitchableStream from '~/lib/.server/llm/switchable-stream';
import type { IProviderSetting } from '~/types/model';
import { createScopedLogger } from '~/utils/logger';
import { getFilePaths, selectContext } from '~/lib/.server/llm/select-context';
import type { ContextAnnotation, ProgressAnnotation } from '~/types/context';
import { WORK_DIR } from '~/utils/constants';
import { createSummary } from '~/lib/.server/llm/create-summary';
import { filesToArtifacts } from '~/utils/fileUtils'; // Ensure this is imported correctly

const logger = createScopedLogger('api.chat');

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};

  const items = cookieHeader.split(';').map((cookie) => cookie.trim());

  items.forEach((item) => {
    const [name, ...rest] = item.split('=');

    if (name && rest) {
      const decodedName = decodeURIComponent(name.trim());
      const decodedValue = decodeURIComponent(rest.join('=').trim());
      cookies[decodedName] = decodedValue;
    }
  });

  return cookies;
}

// Handle POST requests (send/save chats and files)
export async function action({ context, request }: ActionFunctionArgs) {
  if (request.method === 'POST') {
    return chatPostAction({ context, request });
  }
  return new Response('Method not allowed', { status: 405 });
}

// Handle GET requests (retrieve chats)
export async function loader({ context, request }: LoaderFunctionArgs) {
  if (request.method === 'GET') {
    return chatGetAction({ context, request });
  }
  return new Response('Method not allowed', { status: 405 });
}

async function chatPostAction({ context, request }: ActionFunctionArgs) {
  const { messages, files, promptId, contextOptimization, projectId } = await request.json<{
    messages: Messages;
    files: any;
    promptId?: string;
    contextOptimization: boolean;
    projectId: string;
  }>();

  const cookieHeader = request.headers.get('Cookie');
  const apiKeys = JSON.parse(parseCookies(cookieHeader || '').apiKeys || '{}');
  const providerSettings: Record<string, IProviderSetting> = JSON.parse(
    parseCookies(cookieHeader || '').providers || '{}',
  );

  const stream = new SwitchableStream();

  const cumulativeUsage = {
    completionTokens: 0,
    promptTokens: 0,
    totalTokens: 0,
  };
  const encoder: TextEncoder = new TextEncoder();
  let progressCounter: number = 1;

  try {
    const totalMessageContent = messages.reduce((acc, message) => acc + (message.content as string), '');
    logger.debug(`Total message length: ${totalMessageContent.split(' ').length}, words for project ${projectId}`);

    // Save chat messages to D1
    for (const message of messages) {
      await context.cloudflare?.env.DB.prepare(`
        INSERT INTO chat_messages (message, sender, model, project_id, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        message.content[0]?.text || (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)),
        message.role,
        'default-model', // Replace with your model if available
        projectId,
        Date.now()
      ).run();
    }

    // Store files in Cloudflare KV under PROJECT_<projectId>
    if (files && Object.keys(files).length > 0) {
      const namespace = `PROJECT_${projectId}`;
      for (const [fileName, fileContent] of Object.entries(files)) {
        await context.cloudflare?.env.PROJECT_FILES.put(
          `${namespace}/${fileName}`,
          JSON.stringify(fileContent)
        );
      }
    }

    const dataStream = createDataStream({
      async execute(dataStream) {
        const filePaths = getFilePaths(files || {});
        let filteredFiles: FileMap | undefined = undefined;
        let summary: string | undefined = undefined;

        if (filePaths.length > 0 && contextOptimization) {
          dataStream.writeData('HI ');
          logger.debug('Generating Chat Summary for project ' + projectId);
          dataStream.writeMessageAnnotation({
            type: 'progress',
            value: progressCounter++,
            message: 'Generating Chat Summary',
            projectId, // Include projectId for scoping
          } as ProgressAnnotation);

          // Create a summary of the chat
          console.log(`Messages count: ${messages.length} for project ${projectId}`);

          summary = await createSummary({
            messages: [...messages],
            env: context.cloudflare?.env,
            apiKeys,
            providerSettings,
            promptId,
            contextOptimization,
            projectId, // Pass projectId for context
            onFinish(resp) {
              if (resp.usage) {
                logger.debug('createSummary token usage for project ' + projectId, JSON.stringify(resp.usage));
                cumulativeUsage.completionTokens += resp.usage.completionTokens || 0;
                cumulativeUsage.promptTokens += resp.usage.promptTokens || 0;
                cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
              }
            },
          });

          dataStream.writeMessageAnnotation({
            type: 'chatSummary',
            summary,
            chatId: messages.slice(-1)?.[0]?.id,
            projectId, // Include projectId in the annotation
          } as ContextAnnotation);

          // Update context buffer
          logger.debug('Updating Context Buffer for project ' + projectId);
          dataStream.writeMessageAnnotation({
            type: 'progress',
            value: progressCounter++,
            message: 'Updating Context Buffer',
            projectId, // Include projectId for scoping
          } as ProgressAnnotation);

          // Select context files
          console.log(`Messages count: ${messages.length} for project ${projectId}`);
          filteredFiles = await selectContext({
            messages: [...messages],
            env: context.cloudflare?.env,
            apiKeys,
            files,
            providerSettings,
            promptId,
            contextOptimization,
            summary,
            projectId, // Pass projectId for scoping
            onFinish(resp) {
              if (resp.usage) {
                logger.debug('selectContext token usage for project ' + projectId, JSON.stringify(resp.usage));
                cumulativeUsage.completionTokens += resp.usage.completionTokens || 0;
                cumulativeUsage.promptTokens += resp.usage.promptTokens || 0;
                cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
              }
            },
          });

          if (filteredFiles) {
            logger.debug(`files in context : ${JSON.stringify(Object.keys(filteredFiles))} for project ${projectId}`);
          }

          dataStream.writeMessageAnnotation({
            type: 'codeContext',
            files: Object.keys(filteredFiles).map((key) => {
              let path = key;

              if (path.startsWith(WORK_DIR)) {
                path = path.replace(WORK_DIR, '');
              }

              return path;
            }),
            projectId, // Include projectId in the annotation
          } as ContextAnnotation);

          dataStream.writeMessageAnnotation({
            type: 'progress',
            value: progressCounter++,
            message: 'Context Buffer Updated',
            projectId, // Include projectId for scoping
          } as ProgressAnnotation);
          logger.debug('Context Buffer Updated for project ' + projectId);
        }

        // Stream the text
        const options: StreamingOptions = {
          toolChoice: 'none',
          onFinish: async ({ text: content, finishReason, usage }) => {
            logger.debug('usage for project ' + projectId, JSON.stringify(usage));

            if (usage) {
              cumulativeUsage.completionTokens += usage.completionTokens || 0;
              cumulativeUsage.promptTokens += usage.promptTokens || 0;
              cumulativeUsage.totalTokens += usage.totalTokens || 0;
            }

            if (finishReason !== 'length') {
              dataStream.writeMessageAnnotation({
                type: 'usage',
                value: {
                  completionTokens: cumulativeUsage.completionTokens,
                  promptTokens: cumulativeUsage.promptTokens,
                  totalTokens: cumulativeUsage.totalTokens,
                },
                projectId, // Include projectId in usage annotation
              });
              await new Promise((resolve) => setTimeout(resolve, 0));
              return;
            }

            if (stream.switches >= MAX_RESPONSE_SEGMENTS) {
              throw Error(`Cannot continue message for project ${projectId}: Maximum segments reached`);
            }

            const switchesLeft = MAX_RESPONSE_SEGMENTS - stream.switches;

            logger.info(`Reached max token limit (${MAX_TOKENS}): Continuing message (${switchesLeft} switches left) for project ${projectId}`);

            messages.push({ id: generateId(), role: 'assistant', content, projectId });
            messages.push({ id: generateId(), role: 'user', content: CONTINUE_PROMPT, projectId });

            const result = await streamText({
              messages,
              env: context.cloudflare?.env,
              options,
              apiKeys,
              files,
              providerSettings,
              promptId,
              contextOptimization,
              projectId, // Pass projectId for scoping
            });

            result.mergeIntoDataStream(dataStream);

            (async () => {
              for await (const part of result.fullStream) {
                if (part.type === 'error') {
                  const error: any = part.error;
                  logger.error(`Error streaming for project ${projectId}: ${error}`);
                  return;
                }
              }
            })();
          },
        };

        const result = await streamText({
          messages,
          env: context.cloudflare?.env,
          options,
          apiKeys,
          files,
          providerSettings,
          promptId,
          contextOptimization,
          projectId, // Pass projectId for scoping
        });

        (async () => {
          for await (const part of result.fullStream) {
            if (part.type === 'error') {
              const error: any = part.error;
              logger.error(`Error streaming for project ${projectId}: ${error}`);
              return;
            }
          }
        })();

        result.mergeIntoDataStream(dataStream);
      },
      onError: (error: any) => `Custom error for project ${projectId}: ${error.message}`,
    }).pipeThrough(
      new TransformStream({
        transform: (chunk, controller) => {
          const str = typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
          controller.enqueue(encoder.encode(str));
        },
      }),
    );

    return new Response(dataStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
        'Text-Encoding': 'chunked',
      },
    });
  } catch (error: any) {
    logger.error(`Error in chatPostAction for project ${projectId}:`, error);

    if (error.message?.includes('API key')) {
      return new Response('Invalid or missing API key', {
        status: 401,
        statusText: 'Unauthorized',
      });
    }

    return new Response(null, {
      status: 500,
      statusText: 'Internal Server Error',
    });
  }
}

async function chatGetAction({ context, request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get('projectId');

  if (!projectId) {
    return new Response('Missing projectId', { status: 400 });
  }

  try {
    const { results } = await context.cloudflare?.env.DB.prepare(`
      SELECT * FROM chat_messages WHERE project_id = ?
    `).bind(projectId).all();

    logger.debug(`Retrieved ${results.length} chats for project ${projectId}`);
    return new Response(JSON.stringify(results), { status: 200 });
  } catch (error) {
    logger.error(`Failed to get chats for project ${projectId}:`, error);
    return new Response('Failed to retrieve chats', { status: 500 });
  }
}
