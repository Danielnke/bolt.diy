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

// Function to clean up old D1 data (run once or on demand)
async function cleanupOldD1Data(env: any) {
  try {
    const { count } = await env.DB.prepare(`
      DELETE FROM chat_messages WHERE project_id = 'default-project'
    `).run();
    logger.debug(`Cleaned up ${count} old chat messages with project_id = 'default-project' in bolt_diy_database`);
  } catch (error) {
    logger.error('Failed to clean up old D1 data in bolt_diy_database:', error);
  }
}

// Function to clean up old KV data (non-project-specific keys)
async function cleanupOldKVData(env: any) {
  try {
    const keys = await env.PROJECT_FILES.list({ prefix: '' }); // List all keys
    for (const key of keys.keys) {
      if (!key.name.startsWith('PROJECT_') || !key.name.includes('/')) {
        await env.PROJECT_FILES.delete(key.name);
        logger.debug(`Deleted old KV key: ${key.name}`);
      }
    }
  } catch (error) {
    logger.error('Failed to clean up old KV data in PROJECT_FILES:', error);
  }
}

// Handle POST requests (send/save chats and files)
export async function action({ context, request }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const env = context.cloudflare?.env;

  // Run cleanup on first POST request (optional: run once or on demand)
  if (!env.CLEANUP_DONE) {
    await cleanupOldD1Data(env);
    await cleanupOldKVData(env);
    env.CLEANUP_DONE = true; // Prevent repeated cleanup
  }

  try {
    // Parse the request body
    const { messages, files, projectId, model, image, promptId } = await request.json<{
      messages: { content: string; role: string }[];
      files: Record<string, any>;
      projectId: string;
      model?: string;
      image?: string | null;
      promptId?: string;
    }>();

    // Basic validation with fallbacks
    if (!projectId || typeof projectId !== 'string') {
      logger.error('Missing or invalid projectId', { projectId });
      return new Response('Missing or invalid projectId', { status: 400 });
    }

    if (!messages || !Array.isArray(messages)) {
      logger.error('Missing or invalid messages', { messages });
      return new Response('Missing or invalid messages', { status: 400 });
    }

    // Validate and normalize each message
    const validMessages = messages.map((msg) => ({
      content: (msg.content || '').trim() || 'No content',
      role: (msg.role || 'unknown').trim() || 'unknown',
    }));

    if (validMessages.length === 0) {
      logger.error('No valid messages provided for project ' + projectId);
      return new Response('No valid messages provided', { status: 400 });
    }

    logger.info(`Processing chat request for project ${projectId} in bolt_diy_database`);

    // Save chat messages to D1 (bolt_diy_database) - Test saving first, skip streaming temporarily
    for (const message of validMessages) {
      const content = message.content;
      const role = message.role;
      const messageModel = model || 'default-model';

      try {
        await env.DB.prepare(`
          INSERT INTO chat_messages (message, sender, model, project_id, timestamp)
          VALUES (?, ?, ?, ?, ?)
        `)
          .bind(content, role, messageModel, projectId, Date.now())
          .run();
      } catch (dbError) {
        logger.error(`Failed to save message to D1 for project ${projectId}:`, {
          error: dbError.message,
          stack: dbError.stack,
        });
        return new Response(`Database error: ${dbError.message}`, { status: 500 });
      }
    }

    // Store files in Cloudflare KV (PROJECT_FILES) under PROJECT_<projectId>
    if (files && Object.keys(files).length > 0) {
      const namespace = `PROJECT_${projectId}`;
      for (const [fileName, fileContent] of Object.entries(files)) {
        try {
          await env.PROJECT_FILES.put(
            `${namespace}/${fileName}`,
            JSON.stringify(fileContent)
          );
        } catch (kvError) {
          logger.error(`Failed to store file ${fileName} in PROJECT_FILES for project ${projectId}:`, {
            error: kvError.message,
            stack: kvError.stack,
          });
          return new Response(`KV storage error: ${kvError.message}`, { status: 500 });
        }
      }
    }

    // Handle image if provided (log for now, can be extended)
    if (image) {
      logger.debug(`Image provided for project ${projectId}: ${image}`);
    }

    // Temporarily disable streaming to isolate the 500 error - return a simple success response
    return new Response('Chat saved successfully', { status: 200 });

    // Uncomment and fix the following streaming logic if needed after confirming saves work
    /*
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

    const dataStream = createDataStream({
      async execute(dataStream) {
        const filePaths = getFilePaths(files || {});
        let filteredFiles: FileMap | undefined = undefined;
        let summary: string | undefined = undefined;

        if (filePaths.length > 0 && contextOptimization) {
          dataStream.writeData('HI ');
          logger.debug(`Generating Chat Summary for project ${projectId}`);
          dataStream.writeMessageAnnotation({
            type: 'progress',
            value: progressCounter++,
            message: 'Generating Chat Summary',
            projectId,
          } as ProgressAnnotation);

          summary = await createSummary({
            messages: validMessages.map(m => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content })),
            env,
            apiKeys,
            providerSettings,
            promptId: promptId || 'default',
            contextOptimization,
            projectId,
            onFinish(resp) {
              if (resp.usage) {
                logger.debug(`createSummary token usage for project ${projectId}`, JSON.stringify(resp.usage));
                cumulativeUsage.completionTokens += resp.usage.completionTokens || 0;
                cumulativeUsage.promptTokens += resp.usage.promptTokens || 0;
                cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
              }
            },
          });

          dataStream.writeMessageAnnotation({
            type: 'chatSummary',
            summary,
            chatId: validMessages.slice(-1)?.[0]?.content,
            projectId,
          } as ContextAnnotation);

          logger.debug(`Updating Context Buffer for project ${projectId}`);
          dataStream.writeMessageAnnotation({
            type: 'progress',
            value: progressCounter++,
            message: 'Updating Context Buffer',
            projectId,
          } as ProgressAnnotation);

          filteredFiles = await selectContext({
            messages: validMessages.map(m => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content })),
            env,
            apiKeys,
            files,
            providerSettings,
            promptId: promptId || 'default',
            contextOptimization,
            summary,
            projectId,
            onFinish(resp) {
              if (resp.usage) {
                logger.debug(`selectContext token usage for project ${projectId}`, JSON.stringify(resp.usage));
                cumulativeUsage.completionTokens += resp.usage.completionTokens || 0;
                cumulativeUsage.promptTokens += resp.usage.promptTokens || 0;
                cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
              }
            },
          });

          if (filteredFiles) {
            logger.debug(`Files in context: ${JSON.stringify(Object.keys(filteredFiles))} for project ${projectId}`);
          }

          dataStream.writeMessageAnnotation({
            type: 'codeContext',
            files: Object.keys(filteredFiles || {}).map((key) => {
              let path = key;
              if (path.startsWith(WORK_DIR)) {
                path = path.replace(WORK_DIR, '');
              }
              return path;
            }),
            projectId,
          } as ContextAnnotation);

          dataStream.writeMessageAnnotation({
            type: 'progress',
            value: progressCounter++,
            message: 'Context Buffer Updated',
            projectId,
          } as ProgressAnnotation);
          logger.debug(`Context Buffer Updated for project ${projectId}`);
        }

        const options: StreamingOptions = {
          toolChoice: 'none',
          onFinish: async ({ text: content, finishReason, usage }) => {
            logger.debug(`Usage for project ${projectId}`, JSON.stringify(usage));

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
                projectId,
              });
              await new Promise((resolve) => setTimeout(resolve, 0));
              return;
            }

            if (stream.switches >= MAX_RESPONSE_SEGMENTS) {
              throw Error(`Cannot continue message for project ${projectId}: Maximum segments reached`);
            }

            const switchesLeft = MAX_RESPONSE_SEGMENTS - stream.switches;

            logger.info(`Reached max token limit (${MAX_TOKENS}): Continuing message (${switchesLeft} switches left) for project ${projectId}`);

            const newMessages = [
              ...validMessages.map(m => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content, id: generateId() })),
              { id: generateId(), role: 'assistant', content, projectId },
              { id: generateId(), role: 'user', content: CONTINUE_PROMPT, projectId },
            ];

            const result = await streamText({
              messages: newMessages,
              env,
              options,
              apiKeys,
              files,
              providerSettings,
              promptId: promptId || 'default',
              contextOptimization,
              projectId,
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

        try {
          const result = await streamText({
            messages: validMessages.map(m => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content, id: generateId() })),
            env,
            options,
            apiKeys,
            files,
            providerSettings,
            promptId: promptId || 'default',
            contextOptimization,
            projectId,
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
        } catch (streamError) {
          logger.error(`Failed to stream response for project ${projectId}:`, streamError);
          throw new Error(`Streaming error: ${streamError.message}`);
        }
      },
      onError: (error: any) => `Custom error for project ${projectId}: ${error.message}`,
    }).pipeThrough(
      new TransformStream({
        transform: (chunk, controller) => {
          const str = typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
          controller.enqueue(new TextEncoder().encode(str));
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
    */
  } catch (error: any) {
    logger.error(`Error in chatPostAction for project ${projectId}:`, {
      message: error.message,
      stack: error.stack,
    });
    return new Response(`Internal Server Error: ${error.message || 'Unknown error'}`, { status: 500 });
  }
}

// Handle GET requests (retrieve chats)
export async function loader({ context, request }: LoaderFunctionArgs) {
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(request.url);
  const projectId = url.searchParams.get('projectId');

  if (!projectId) {
    logger.error('Missing projectId in GET request');
    return new Response('Missing projectId', { status: 400 });
  }

  try {
    const { results } = await context.cloudflare?.env.DB.prepare(`
      SELECT * FROM chat_messages WHERE project_id = ?
    `).bind(projectId).all();

    logger.info(`Retrieved ${results.length} chats for project ${projectId} from bolt_diy_database`);
    return new Response(JSON.stringify(results), { status: 200 });
  } catch (error) {
    logger.error(`Failed to get chats for project ${projectId} from bolt_diy_database:`, error);
    return new Response(`Failed to retrieve chats: ${error.message || 'Unknown error'}`, { status: 500 });
  }
}
