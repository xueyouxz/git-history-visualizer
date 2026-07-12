export async function consumeSse<T>(url: string, token: string, signal: AbortSignal, consume: (state: T) => void) {
  const response = await fetch(url, { headers: { 'X-Session-Token': token }, signal });
  if (!response.ok || !response.body) throw new Error('无法读取任务进度');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  while (true) {
    const { done, value } = await reader.read(); buffer += decoder.decode(value, { stream: !done }); const frames = buffer.split('\n\n'); buffer = frames.pop() ?? '';
    for (const frame of frames) { const data = frame.split('\n').find(part => part.startsWith('data: ')); if (data) consume(JSON.parse(data.slice(6)) as T); }
    if (done) break;
  }
}
