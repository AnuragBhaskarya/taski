export async function onRequest(context) {
  return new Response(JSON.stringify({
    url: context.env.SUPABASE_URL,
    key: context.env.SUPABASE_ANON_KEY
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
