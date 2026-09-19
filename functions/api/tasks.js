export async function onRequestGet({ env }) {
  try {
    const tasks = await env.TASKI_KV.get("tasks");
    return new Response(tasks || "[]", {
      headers: { 
        "Content-Type": "application/json",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate"
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.text();
    // Validate JSON
    JSON.parse(body);
    await env.TASKI_KV.put("tasks", body);
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: "Invalid JSON or server error", details: error.message }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }
}
