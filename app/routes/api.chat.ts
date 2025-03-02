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

// Define constants here to avoid server-only imports
const MAX_RESPONSE_SEGMENTS = 5; // Adjust as needed
const MAX_TOKENS = 4096; // Adjust as needed
const CONTINUE_PROMPT = 'Please continue the response.';

const logger = createScopedLogger('api.chat');

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

    // Simplified JSON response (no streaming)
    return new Response(JSON.stringify({ success: true, message: 'Chat saved successfully' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
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
