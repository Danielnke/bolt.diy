// app/routes/api.chat.ts
import { type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { createScopedLogger } from '~/utils/logger';

// Define types locally since we can't import types directly from dynamic imports
interface Message {
  id: string;
  role: string;
  content: string;
}

interface StreamingOptions {
  toolChoice: string;
  onFinish: (result: { text: string; finishReason: string; usage?: any }) => Promise<void>;
}

interface FileMap {
  [key: string]: any;
}

interface ProgressAnnotation {
  type: 'progress';
  label: string;
  status: 'in-progress' | 'complete';
  order: number;
  message: string;
}

interface ContextAnnotation {
  type: 'chatSummary' | 'codeContext';
  summary?: string;
  files?: string[];
  chatId?: string;
  projectId?: string;
}

// Define constants here to avoid server-only imports
const MAX_RESPONSE_SEGMENTS = 5; // Adjust as needed
const MAX_TOKENS = 4096; // Adjust as needed
const CONTINUE_PROMPT = 'Please continue the response.';
const WORK_DIR = '/work/';

const logger = createScopedLogger('api.chat');

// Utility function to parse cookies
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
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const env = context.cloudflare?.env;

  // Dynamically import server-only modules inside the action function
  const { createDataStream, generateId } = await import('ai');
  const SwitchableStream = (await import('~/lib/.server/llm/switchable-stream')).default;
  const { streamText } = await import('~/lib/.server/llm/stream-text');
  const { getFilePaths, selectContext } = await import('~/lib/.server/llm/select-context');
  const { createSummary } = await import('~/lib/.server/llm/create-summary');
  const { filesToArtifacts } = await import('~/utils/fileUtils');

  // Function to process messages to ensure string content
  function processMessages(messages: Message[]): Message[] {
    return messages.map((msg) => ({
      ...msg,
      content: typeof msg.content === 'string' ? msg.content : (msg.content as string), // Ensure content is a string
    }));
  }

  try {
    // Parse the request body
    const { messages, files, projectId, model, image, promptId, contextOptimization } = await request.json<{
      messages: Message[];
      files: Record<string, any>;
      projectId: string;
      model?: string;
      image?: string | null;
      promptId?: string;
      contextOptimization?: boolean;
    }>();

    // Basic validation
    if (!projectId || typeof projectId !== 'string') {
      logger.error('Missing or invalid projectId', { projectId });
      return new Response('Missing or invalid projectId', { status: 400 });
    }

    if (!messages || !Array.isArray(messages)) {
      logger.error('Missing or invalid messages', { messages });
      return new Response('Missing or invalid messages', { status: 400 });
    }

    // Process messages to ensure string content
    const processedMessages = processMessages(messages);

    // Normalize messages (ensure valid content and role)
    const validMessages = processedMessages.map((msg) => ({
      content: (msg.content || '').trim() || 'No content',
      role: (msg.role || 'unknown').trim() || 'unknown',
    }));

    if (validMessages.length === 0) {
      logger.error('No valid messages provided for project ' + projectId);
      return new Response('No valid messages provided', { status: 400 });
    }

    logger.info(`Processing chat request for project ${projectId} in bolt_diy_database`);

    // Save chat messages to D1 (bolt_diy_database)
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

    // Handle image (log for now, can be extended)
    if (image) {
      logger.debug(`Image provided for project ${projectId}: ${image}`);
    }

    // Streaming response with corrected formatting
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
          dataStream.writeData({
            type: 'progress',
            label: 'summary',
            status: 'in-progress',
            order: progressCounter++,
            message: 'Generating Chat Summary',
          } satisfies ProgressAnnotation);

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

          dataStream.writeData({
            type: 'progress',
            label: 'summary',
            status: 'complete',
            order: progressCounter++,
            message: 'Chat Summary Generated',
          } satisfies ProgressAnnotation);

          dataStream.writeMessageAnnotation({
            type: 'chatSummary',
            summary,
            chatId: validMessages.slice(-1)?.[0]?.content,
            projectId,
          } as ContextAnnotation);

          dataStream.writeData({
            type: 'progress',
            label: 'context',
            status: 'in-progress',
            order: progressCounter++,
            message: 'Updating Context Buffer',
          } satisfies ProgressAnnotation);

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

          dataStream.writeData({
            type: 'progress',
            label: 'context',
            status: 'complete',
            order: progressCounter++,
            message: 'Context Buffer Updated',
          } satisfies ProgressAnnotation);
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
              dataStream.writeData({
                type: 'progress',
                label: 'response',
                status: 'complete',
                order: progressCounter++,
                message: 'Response Generated',
              } satisfies ProgressAnnotation);
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
              { id: generateId(), role: 'user', content: `[Model: ${model || 'default-model'}]\n\n[Provider: ${provider || 'default-provider'}]\n\n${CONTINUE_PROMPT}`, projectId },
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

        dataStream.writeData({
          type: 'progress',
          label: 'response',
          status: 'in-progress',
          order: progressCounter++,
          message: 'Generating Response',
        } satisfies ProgressAnnotation);

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
      },
      onError: (error: any) => `Custom error for project ${projectId}: ${error.message}`,
    }).pipeThrough(
      new TransformStream({
        transform: (chunk, controller) => {
          const str = typeof chunk === 'string' ? `data: ${chunk}\n\n` : `data: ${JSON.stringify(chunk)}\n\n`; // Ensure proper SSE format
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
