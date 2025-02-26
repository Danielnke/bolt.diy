export async function onRequest(context) {  
  const { request, env } = context;  
  const url = new URL(request.url);  

  // Save a chat message  
  if (url.pathname === "/api/save-chat" && request.method === "POST") {  
    const { message, sender } = await request.json();  
    const timestamp = new Date().toISOString();  
    await env.DB.prepare("INSERT INTO chat_messages (message, timestamp, sender) VALUES (?, ?, ?)")  
      .bind(message, timestamp, sender)  
      .run();  
    return new Response("Chat saved", { status: 200 });  
  }  

  // Get all chat messages  
  if (url.pathname === "/api/get-chats") {  
    const result = await env.DB.prepare("SELECT * FROM chat_messages ORDER BY timestamp ASC").all();  
    return new Response(JSON.stringify(result.results), {  
      headers: { "Content-Type": "application/json" },  
    });  
  }  

  return new Response("Not found", { status: 404 });  
}  
