import type { ServerBuild } from '@remix-run/cloudflare';
import { createPagesFunctionHandler } from '@remix-run/cloudflare-pages';
import * as serverBuild from '../build/server';

export const onRequest = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);

  if (url.pathname === '/api/save-chat' && request.method === 'POST') {
    try {
      console.log('Received save-chat request');
      const body = await request.json();
      console.log('Request body:', body);
      const { message, sender, model, image } = body;

      if (!env.DB) {
        throw new Error('D1 binding (DB) is undefined');
      }
      if (image && !env.BUCKET) {
        throw new Error('R2 binding (BUCKET) is undefined');
      }

      let imageUrl = null;
      if (image) {
        console.log('Uploading image to R2');
        const key = `chat-image-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        await env.BUCKET.put(key, Buffer.from(image, 'base64'), {
          httpMetadata: { contentType: 'image/jpeg' },
        });
        imageUrl = `r2://${key}`; // Placeholder
      }

      const timestamp = new Date().toISOString();
      console.log('Saving to D1:', { message, timestamp, sender, model, imageUrl });
      await env.DB.prepare(
        'INSERT INTO chat_messages (message, timestamp, sender, model, image_url) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(message, timestamp, sender, model || 'unknown', imageUrl)
        .run();

      return new Response('Chat saved', { status: 200 });
    } catch (error) {
      console.error('Error in save-chat:', error.message, error.stack);
      return new Response(`Failed to save chat: ${error.message}`, { status: 500 });
    }
  }

  if (url.pathname === '/api/get-chats') {
    try {
      if (!env.DB) {
        throw new Error('D1 binding (DB) is undefined');
      }
      const result = await env.DB.prepare('SELECT * FROM chat_messages ORDER BY timestamp ASC').all();
      return new Response(JSON.stringify(result.results), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    } catch (error) {
      console.error('Error in get-chats:', error.message, error.stack);
      return new Response(`Failed to load chat history: ${error.message}`, { status: 500 });
    }
  }

  return createPagesFunctionHandler({
    build: serverBuild as unknown as ServerBuild,
  })(context);
};
