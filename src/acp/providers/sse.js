'use strict';

/**
 * Minimal SSE (Server-Sent Events) chunk parser.
 *
 * Both Anthropic and OpenAI emit token streams over the SSE wire format
 * (per the WHATWG eventsource standard). The two upstream JSON shapes
 * differ, but the framing rules are identical — so we share one parser
 * here and let each provider's stream handler interpret its own event
 * objects.
 *
 * Wire format (recap):
 *
 *   event: foo        ← optional event name
 *   data: {"a":1}     ← payload (may repeat; concatenated with \n)
 *   data: more
 *                     ← blank line terminates the event
 *   data: [DONE]      ← OpenAI uses this sentinel; we surface it via onEvent
 *
 * Lines beginning with `:` are comments and ignored. Unknown fields
 * (`id:`, `retry:`) are ignored — we only care about `event:` and `data:`.
 *
 * This parser is *stateful across chunks*. Network reads can arrive
 * mid-event, so the caller passes the leftover buffer from the previous
 * call and gets back the new leftover. Pattern:
 *
 *   let buf = '';
 *   res.on('data', (chunk) => {
 *     buf = parseSseStream(chunk, buf, (event, data) => { … });
 *   });
 *
 * onEvent is invoked synchronously for each complete event with:
 *   - eventName: string|null (the `event:` field value, or null if absent)
 *   - data:      object|null (parsed JSON, or null on `[DONE]` sentinel,
 *                or `{ _raw: <string> }` if the payload couldn't be JSON-parsed)
 */
function parseSseStream(chunk, buffer, onEvent) {
  // Accept Buffer or string.
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  buffer += text;

  // Events are separated by a blank line — \n\n or \r\n\r\n.
  // Split keeps everything; pop() returns the partial trailing event.
  const parts = buffer.split(/\r?\n\r?\n/);
  const remaining = parts.pop();

  for (const block of parts) {
    if (!block.trim()) continue;
    let eventName = null;
    const dataLines = [];
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine;
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        // RFC says a single leading space after `data:` should be stripped.
        let value = line.slice(5);
        if (value.startsWith(' ')) value = value.slice(1);
        dataLines.push(value);
      }
      // Other fields (id:, retry:) are intentionally ignored.
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join('\n');
    if (payload === '[DONE]') {
      onEvent(eventName || 'done', null);
      continue;
    }
    try {
      onEvent(eventName, JSON.parse(payload));
    } catch {
      // Malformed JSON — surface for debugging without throwing,
      // streams shouldn't die on a single bad event.
      onEvent(eventName, { _raw: payload });
    }
  }

  return remaining;
}

module.exports = { parseSseStream };
