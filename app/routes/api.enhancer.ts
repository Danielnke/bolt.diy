import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { streamText } from '~/lib/.server/llm/stream-text';
import { stripIndents } from '~/utils/stripIndent';
import type { ProviderInfo } from '~/types/model';
import { getApiKeysFromCookie, getProviderSettingsFromCookie } from '~/lib/api/cookies';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.enhancer');

export async function action(args: ActionFunctionArgs) {
  return enhancerAction(args);
}

async function enhancerAction({ context, request }: ActionFunctionArgs) {
  const { message, model, provider, project_id } = await request.json<{
    message: string;
    model: string;
    provider: ProviderInfo;
    project_id: string;
  }>();

  const { name: providerName } = provider;

  // Validate required fields
  if (!message || typeof message !== 'string') {
    logger.error('Invalid or missing message in request');
    throw new Response('Invalid or missing message', {
      status: 400,
      statusText: 'Bad Request',
    });
  }

  if (!model || typeof model !== 'string') {
    logger.error('Invalid or missing model in request');
    throw new Response('Invalid or missing model', {
      status: 400,
      statusText: 'Bad Request',
    });
  }

  if (!providerName || typeof providerName !== 'string') {
    logger.error('Invalid or missing provider in request');
    throw new Response('Invalid or missing provider', {
      status: 400,
      statusText: 'Bad Request',
    });
  }

  if (!project_id || typeof project_id !== 'string') {
    logger.error(`Invalid or missing project_id in request for provider ${providerName}`);
    throw new Response('Invalid or missing project_id', {
      status: 400,
      statusText: 'Bad Request',
    });
  }

  // Get API keys and settings from cookies
  const cookieHeader = request.headers.get('Cookie');
  const apiKeys = getApiKeysFromCookie(cookieHeader);
  const providerSettings = getProviderSettingsFromCookie(cookieHeader);

  // Determine the API key (prefer cookie-based, fall back to environment variable)
  const apiKey = apiKeys[providerName.toLowerCase()] || process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    logger.error(`Missing API key for provider ${providerName} and project ${project_id}`);
    throw new Response('Invalid or missing API key', {
      status: 401,
      statusText: 'Unauthorized',
    });
  }

  try {
    // Prepare the prompt for enhancement
    const prompt = stripIndents`
      You are a professional prompt engineer specializing in crafting precise, effective prompts.
      Your task is to enhance prompts by making them more specific, actionable, and effective.

      I want you to improve the user prompt that is wrapped in \`<original_prompt>\` tags.

      For valid prompts:
      - Make instructions explicit and unambiguous
      - Add relevant context and constraints
      - Remove redundant information
      - Maintain the core intent
      - Ensure the prompt is self-contained
      - Use professional language

      For invalid or unclear prompts:
      - Respond with clear, professional guidance
      - Keep responses concise and actionable
      - Maintain a helpful, constructive tone
      - Focus on what the user should provide
      - Use a standard template for consistency

      IMPORTANT: Your response must ONLY contain the enhanced prompt text.
      Do not include any explanations, metadata, or wrapper tags.

      <original_prompt>
        ${message}
      </original_prompt>
    `;

    // Stream the enhanced prompt using the specified provider and model
    const result = await streamText({
      messages: [
        {
          role: 'user',
          content: `[Model: ${model}]\n\n[Provider: ${providerName}]\n\n[Project: ${project_id}]\n\n${prompt}`,
          project_id, // Pass project_id for scoping (if streamText supports it)
        },
      ],
      env: context.cloudflare?.env as any,
      apiKeys: { [providerName.toLowerCase()]: apiKey },
      providerSettings: { [providerName]: providerSettings[providerName] || {} },
      project_id, // Pass project_id for logging or scoping (if supported by streamText)
    });

    logger.debug(`Successfully enhanced prompt for project ${project_id} with model ${model} and provider ${providerName}`);
    return new Response(result.textStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
        'Text-Encoding': 'chunked',
      },
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Failed to enhance prompt for project ${project_id}: ${errorMessage}`, error);

    if (error instanceof Error && error.message?.includes('API key')) {
      throw new Response('Invalid or missing API key', {
        status: 401,
        statusText: 'Unauthorized',
      });
    }

    throw new Response('Internal Server Error', {
      status: 500,
      statusText: 'Unexpected Server Error',
    });
  }
}
