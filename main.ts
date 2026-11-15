// free-model-aggregator-02: one server, two client wires, and a real free model behind every
// answer, dialled through the trial gateway on the entrant's OpenRouter key.
//
// Strategy, in one paragraph per scoring column:
//   quality  - rank the brief's free models by rating_milli among those meeting the prompt's
//              requirements (tools / vision / JSON mode, read from the brief's manifest row
//              for the arriving prompt and unioned with what the body itself declares), and
//              dial the best. Fail over down that same ranked list.
//   failover - a refused call is never the end of a prompt while another ranked candidate
//              remains (at most 4 calls per prompt); every refusal the prompt recovered from
//              is reported on the response's x-makefun-upstream-failures header, in order.
//              A model that refused earlier in the trial is demoted below every model that
//              has not, so one rate-limited model cannot take later prompts down with it.
//   wire     - upstream answers are buffered whole, then rendered in the client's wire:
//              the provider's own JSON with the dialled id put back as `model`, or a
//              deterministic SSE rendering of that same answer when the client streamed.
//   catalog  - exactly the brief's free models, in the brief's order, in the register body,
//              in --list output and in both GET /v1/models shapes. Nothing else, ever.
//   replay   - every decision is a function of the brief and of the gateway's answers seen
//              so far; ids and timestamps in synthesized frames are fixed constants, and
//              nothing reads the wall clock, so a replayed trial repeats the live one.
//
// The trial's shape: listen on an ephemeral port, POST $MAKEFUN_ENV_URL/register with the
// catalog, serve the routes, poll GET $MAKEFUN_ENV_URL/work, exit 0 when it says done.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---------------------------------------------------------------------------
// The brief: the free model table and the prompt manifest, parsed out of the
// prose at $MAKEFUN_PROMPT_FILE. Both ride in the file as JSON documents that
// name their schema; extract each by brace matching from its schema marker.
// ---------------------------------------------------------------------------

interface ModelRow {
  id: string;
  display_name: string;
  rating_milli: number;
  context_length: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  free: boolean;
}

interface Requirement {
  tools: boolean;
  vision: boolean;
  json: boolean;
}

interface PromptRow {
  id: string;
  requires: Requirement;
}

function extractJson(text: string, marker: string): Json | null {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const start = text.lastIndexOf('{', at);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const value: unknown = JSON.parse(text.slice(start, i + 1));
          return isRecord(value) ? value : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** The practice table, used only when the brief cannot be read (a bare --list, say). */
const FALLBACK_MODELS: ModelRow[] = [
  { id: 'openrouter/baidu/ernie-5.5-flash-preview:free', display_name: 'Baidu: ERNIE-5.5-Flash-Preview (free)', rating_milli: 1150, context_length: 1024000, tools: true, vision: false, json: true, free: true },
  { id: 'openrouter/cohere/north-mini-code:free', display_name: 'Cohere: North Mini Code (free)', rating_milli: 1200, context_length: 256000, tools: true, vision: false, json: false, free: true },
  { id: 'openrouter/dots-studio/dots-3-note-preview:free', display_name: 'Dots Studio: Dots3-Note Preview (free)', rating_milli: 1150, context_length: 512000, tools: true, vision: true, json: true, free: true },
  { id: 'openrouter/google/gemma-4-26b-a4b-it:free', display_name: 'Google: Gemma 4 26B A4B (free)', rating_milli: 1150, context_length: 262144, tools: true, vision: true, json: true, free: true },
  { id: 'openrouter/google/gemma-4-31b-it:free', display_name: 'Google: Gemma 4 31B (free)', rating_milli: 1210, context_length: 262144, tools: true, vision: true, json: true, free: true },
  { id: 'openrouter/inclusionai/ling-3.2-flash:free', display_name: 'inclusionAI: Ling 3.2 Flash (free)', rating_milli: 1150, context_length: 1048576, tools: true, vision: true, json: true, free: true },
  { id: 'openrouter/liquid/lfm-3-1.7b:free', display_name: 'LiquidAI: LFM3-1.7B (free)', rating_milli: 1150, context_length: 262144, tools: true, vision: false, json: true, free: true },
  { id: 'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', display_name: 'NVIDIA: Nemotron 3 Nano Omni (free)', rating_milli: 1150, context_length: 256000, tools: true, vision: true, json: false, free: true },
  { id: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free', display_name: 'NVIDIA: Nemotron 3 Ultra (free)', rating_milli: 1285, context_length: 1000000, tools: true, vision: false, json: false, free: true },
  { id: 'openrouter/nvidia/nemotron-3.5-lightning:free', display_name: 'NVIDIA: Nemotron 3.5 Lightning (free)', rating_milli: 1221, context_length: 1000000, tools: true, vision: false, json: false, free: true },
  { id: 'openrouter/nvidia/nemotron-3.5-super-vl:free', display_name: 'NVIDIA: Nemotron 3.5 Super VL (free)', rating_milli: 1303, context_length: 1000000, tools: true, vision: true, json: true, free: true },
  { id: 'openrouter/particle-ai/particle-1:free', display_name: 'Particle AI: Particle-1 (free)', rating_milli: 1150, context_length: 1048576, tools: true, vision: true, json: true, free: true },
  { id: 'openrouter/recursive/flint-v1.0:free', display_name: 'Recursive: Flint (free)', rating_milli: 1150, context_length: 262144, tools: true, vision: false, json: true, free: true },
  { id: 'openrouter/thinkingmachines/inkling-2-small:free', display_name: 'Thinking Machines: Inkling 2 Small (free)', rating_milli: 1475, context_length: 1048576, tools: true, vision: true, json: false, free: true },
];

function readBrief(path: string): { models: ModelRow[]; prompts: PromptRow[] } {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { models: FALLBACK_MODELS, prompts: [] };
  }
  const modelsDoc = extractJson(text, 'free-model-aggregator-02/models/v1');
  const promptsDoc = extractJson(text, 'free-model-aggregator-02/prompts/v1');
  const models: ModelRow[] = [];
  if (modelsDoc !== null && Array.isArray(modelsDoc.models)) {
    for (const raw of modelsDoc.models) {
      if (!isRecord(raw) || typeof raw.id !== 'string' || raw.free !== true) continue;
      models.push({
        id: raw.id,
        display_name: typeof raw.display_name === 'string' ? raw.display_name : raw.id,
        rating_milli: num(raw.rating_milli) ?? 0,
        context_length: num(raw.context_length),
        tools: raw.tools === true,
        vision: raw.vision === true,
        json: raw.json === true,
        free: true,
      });
    }
  }
  const prompts: PromptRow[] = [];
  if (promptsDoc !== null && Array.isArray(promptsDoc.prompts)) {
    for (const raw of promptsDoc.prompts) {
      if (!isRecord(raw)) continue;
      const req = isRecord(raw.requires) ? raw.requires : {};
      prompts.push({
        id: typeof raw.id === 'string' ? raw.id : '',
        requires: { tools: req.tools === true, vision: req.vision === true, json: req.json === true },
      });
    }
  }
  return { models: models.length > 0 ? models : FALLBACK_MODELS, prompts };
}

const brief = readBrief(process.env.MAKEFUN_PROMPT_FILE ?? '');

/** The catalog document: registered, printed by --list, and the source of both model lists. */
const catalog: Json = {
  providers: [
    {
      id: 'openrouter',
      base_url: 'https://openrouter.ai/api/v1',
      key_env: 'OPENROUTER_API_KEY',
      wire: 'openai',
      models: brief.models.map((m) => ({ id: m.id, free: true, context_length: m.context_length })),
    },
  ],
};

// ---------------------------------------------------------------------------
// Routing: rank the models meeting a requirement set by rating, best first.
// A model that has refused in this trial sorts below every one that has not.
// ---------------------------------------------------------------------------

const refusedBefore = new Set<string>();
let manifestIndex = 0;

function meets(req: Requirement, m: ModelRow): boolean {
  return (!req.tools || m.tools) && (!req.vision || m.vision) && (!req.json || m.json);
}

function ranked(req: Requirement): ModelRow[] {
  return brief.models
    .filter((m) => meets(req, m))
    .sort((a, b) => Number(refusedBefore.has(a.id)) - Number(refusedBefore.has(b.id)) || b.rating_milli - a.rating_milli);
}

/** What a body itself declares, unioned with the manifest row for the arriving prompt. */
function requirementsFor(body: Json, wire: 'openai' | 'anthropic'): Requirement {
  const row = brief.prompts[manifestIndex];
  manifestIndex += 1;
  const req: Requirement = row !== undefined ? { ...row.requires } : { tools: false, vision: false, json: false };
  if (Array.isArray(body.tools) && body.tools.length > 0) req.tools = true;
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  if (format === 'json_object' || format === 'json_schema') req.json = true;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'image' || block.type === 'image_url') req.vision = true;
      if (block.type === 'image_url') req.vision = true;
    }
  }
  void wire;
  return req;
}

// ---------------------------------------------------------------------------
// Wire translation. The gateway speaks only Chat Completions; an Anthropic
// client body is translated into it, and the answer is translated back. Text
// extraction and the usage formula are shared with the renderers below.
// ---------------------------------------------------------------------------

function blocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function argsObject(value: unknown): Json {
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON: an empty input.
    }
  }
  return {};
}

/** An Anthropic Messages request as a Chat Completions request (the gateway's only route). */
function anthropicToOpenAI(body: Json): Json {
  const messages: Json[] = [];
  const system = blocksText(body.system);
  if (system !== '') messages.push({ role: 'system', content: system });
  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(raw)) continue;
    const role = raw.role === 'assistant' ? 'assistant' : 'user';
    if (typeof raw.content === 'string') {
      messages.push({ role, content: raw.content });
      continue;
    }
    if (!Array.isArray(raw.content)) continue;
    if (role === 'assistant') {
      const toolCalls: Json[] = [];
      for (const block of raw.content) {
        if (!isRecord(block) || block.type !== 'tool_use') continue;
        toolCalls.push({
          id: typeof block.id === 'string' ? block.id : '',
          type: 'function',
          function: { name: typeof block.name === 'string' ? block.name : '', arguments: JSON.stringify(isRecord(block.input) ? block.input : {}) },
        });
      }
      const text = blocksText(raw.content);
      messages.push({ role, content: text === '' ? null : text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    const parts: Json[] = [];
    for (const block of raw.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') {
        messages.push({ role: 'tool', tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '', content: blocksText(block.content) });
      } else if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image' && isRecord(block.source)) {
        const source = block.source;
        if (source.type === 'base64' && typeof source.data === 'string') {
          const media = typeof source.media_type === 'string' ? source.media_type : 'image/png';
          parts.push({ type: 'image_url', image_url: { url: `data:${media};base64,${source.data}` } });
        } else if (source.type === 'url' && typeof source.url === 'string') {
          parts.push({ type: 'image_url', image_url: { url: source.url } });
        }
      }
    }
    if (parts.length > 0) messages.push({ role: 'user', content: parts });
  }
  const out: Json = { messages };
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    const tools: Json[] = [];
    for (const raw of body.tools) {
      if (!isRecord(raw) || typeof raw.name !== 'string') continue;
      tools.push({
        type: 'function',
        function: { name: raw.name, description: typeof raw.description === 'string' ? raw.description : '', parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} } },
      });
    }
    if (tools.length > 0) out.tools = tools;
  }
  if (isRecord(body.tool_choice)) {
    const choice = body.tool_choice;
    if (choice.type === 'auto') out.tool_choice = 'auto';
    else if (choice.type === 'any') out.tool_choice = 'required';
    else if (choice.type === 'tool' && typeof choice.name === 'string') out.tool_choice = { type: 'function', function: { name: choice.name } };
  }
  return out;
}

// ---------------------------------------------------------------------------
// The dial: one prompt, a ranked candidate list, at most 4 gateway calls.
// Every refusal is recorded for the failures header and demotes its model.
// ---------------------------------------------------------------------------

interface Failure {
  status: number;
  code: string;
  model: string | null;
}

interface Served {
  answer: Json;
  model: string;
  failures: Failure[];
}

const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';
const MAX_CALLS_PER_PROMPT = 4;
const CALL_TIMEOUT_MS = 25_000;

function chatCompletionsUrl(): string {
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

function errorCode(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value) && isRecord(value.error)) {
      if (typeof value.error.code === 'string') return value.error.code;
      if (typeof value.error.type === 'string') return value.error.type;
    }
  } catch {
    // Not JSON: no code.
  }
  return '';
}

async function serve(body: Json, req: Requirement): Promise<Served | { failures: Failure[] }> {
  const failures: Failure[] = [];
  const candidates = ranked(req).slice(0, MAX_CALLS_PER_PROMPT);
  for (const candidate of candidates) {
    let response: Response;
    try {
      response = await fetch(chatCompletionsUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${GATEWAY_KEY}` },
        body: JSON.stringify({ ...body, model: candidate.id, stream: false }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      failures.push({ status: 0, code: 'network_error', model: candidate.id });
      refusedBefore.add(candidate.id);
      continue;
    }
    const text = await response.text();
    if (!response.ok) {
      failures.push({ status: response.status, code: errorCode(text), model: candidate.id });
      refusedBefore.add(candidate.id);
      continue;
    }
    let answer: Json = {};
    try {
      const value: unknown = JSON.parse(text);
      if (isRecord(value)) answer = value;
    } catch {
      failures.push({ status: 0, code: 'bad_answer', model: candidate.id });
      refusedBefore.add(candidate.id);
      continue;
    }
    return { answer, model: candidate.id, failures };
  }
  return { failures };
}

// ---------------------------------------------------------------------------
// Rendering. A buffered gateway answer becomes the client's wire: JSON with
// the dialled id as `model`, or a deterministic SSE rendering of the same
// answer. Usage comes from the provider; when it is absent, the providers'
// own counting formula over the request and the answer fills it, whole.
// ---------------------------------------------------------------------------

const FIXED_CREATED = 1767225600;
const FIXED_CREATED_AT = '2026-01-01T00:00:00Z';

function sse(event: string | null, data: unknown): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

function answerParts(answer: Json): { text: string; toolCalls: Json[]; finish: string; usage: Json | null } {
  const choice = Array.isArray(answer.choices) && isRecord(answer.choices[0]) ? answer.choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const toolCalls: Json[] = [];
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (isRecord(call) && isRecord(call.function)) toolCalls.push(call);
  }
  return {
    text: typeof message.content === 'string' ? message.content : blocksText(message.content),
    toolCalls,
    finish: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop',
    usage: isRecord(answer.usage) ? answer.usage : null,
  };
}

function usageFor(answer: Json, requestBody: Json, wire: 'openai' | 'anthropic'): { input: number; output: number } {
  const parts = answerParts(answer);
  if (parts.usage !== null) {
    const input = num(parts.usage.prompt_tokens) ?? num(parts.usage.input_tokens);
    const output = num(parts.usage.completion_tokens) ?? num(parts.usage.output_tokens);
    if (input !== null && output !== null) return { input, output };
  }
  let promptChars = blocksText(requestBody.system).length;
  let toolNames = '';
  for (const m of Array.isArray(requestBody.messages) ? requestBody.messages : []) {
    if (isRecord(m) && m.role === 'user') promptChars += blocksText(m.content).length;
  }
  if (wire === 'anthropic') {
    toolNames = (Array.isArray(requestBody.tools) ? requestBody.tools : []).flatMap((t) => (isRecord(t) && typeof t.name === 'string' ? [t.name] : [])).join(',');
  } else {
    toolNames = (Array.isArray(requestBody.tools) ? requestBody.tools : [])
      .flatMap((t) => (isRecord(t) && isRecord(t.function) && typeof t.function.name === 'string' ? [t.function.name] : []))
      .join(',');
  }
  const prompt = promptChars + toolNames.length;
  return { input: 1 + Math.floor(prompt / 4), output: 1 + Math.floor(parts.text.length / 4) };
}

function stopReasonOf(finish: string): string {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  if (finish === 'content_filter') return 'refusal';
  return 'end_turn';
}

function renderOpenAI(answer: Json, model: string, requestBody: Json, stream: boolean): { contentType: string; body: string } {
  const parts = answerParts(answer);
  const usage = usageFor(answer, requestBody, 'openai');
  const usageJson = { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output };
  if (!stream) {
    const out: Json = { ...answer, model, usage: usageJson };
    if (!Array.isArray(out.choices)) out.choices = [{ index: 0, message: { role: 'assistant', content: parts.text }, finish_reason: parts.finish, logprobs: null }];
    return { contentType: 'application/json', body: JSON.stringify(out) };
  }
  const chunk = (delta: Json, finish: string | null): Json => ({
    id: 'chatcmpl-aggregate',
    object: 'chat.completion.chunk',
    created: FIXED_CREATED,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const frames = [sse(null, chunk({ role: 'assistant', content: '' }, null)), sse(null, chunk({ content: parts.text }, null))];
  for (const call of parts.toolCalls) {
    frames.push(sse(null, chunk({ tool_calls: [{ index: 0, id: typeof call.id === 'string' ? call.id : 'call_aggregate', type: 'function', function: { name: call.function.name, arguments: typeof call.function.arguments === 'string' ? call.function.arguments : '' } }] }, null)));
  }
  frames.push(sse(null, chunk({}, parts.finish)));
  frames.push(sse(null, { id: 'chatcmpl-aggregate', object: 'chat.completion.chunk', created: FIXED_CREATED, model, choices: [], usage: usageJson }));
  frames.push('data: [DONE]\n\n');
  return { contentType: 'text/event-stream', body: frames.join('') };
}

function renderAnthropic(answer: Json, model: string, requestBody: Json, stream: boolean): { contentType: string; body: string } {
  const parts = answerParts(answer);
  const usage = usageFor(answer, requestBody, 'anthropic');
  const content: Json[] = [];
  if (parts.text !== '') content.push({ type: 'text', text: parts.text });
  for (const call of parts.toolCalls) {
    content.push({
      type: 'tool_use',
      id: typeof call.id === 'string' ? call.id : 'toolu_aggregate',
      name: typeof call.function.name === 'string' ? call.function.name : '',
      input: argsObject(call.function.arguments),
    });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  const stop = stopReasonOf(parts.finish);
  if (!stream) {
    return {
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'msg_aggregate',
        type: 'message',
        role: 'assistant',
        model,
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: usage.input, output_tokens: usage.output },
      }),
    };
  }
  const frames = [
    sse('message_start', {
      type: 'message_start',
      message: { id: 'msg_aggregate', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 0 } },
    }),
  ];
  content.forEach((block, index) => {
    if (block.type === 'text') {
      frames.push(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }));
      frames.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }));
    } else {
      frames.push(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }));
      frames.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } }));
    }
    frames.push(sse('content_block_stop', { type: 'content_block_stop', index }));
  });
  frames.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output } }));
  frames.push(sse('message_stop', { type: 'message_stop' }));
  return { contentType: 'text/event-stream', body: frames.join('') };
}

// ---------------------------------------------------------------------------
// The HTTP surface and the env handshake.
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 8 * 1024 * 1024;

async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function send(res: ServerResponse, status: number, contentType: string, body: string, failures: Failure[]): void {
  const headers: Record<string, string> = { 'content-type': contentType, 'content-length': String(Buffer.byteLength(body)) };
  if (failures.length > 0) headers['x-makefun-upstream-failures'] = JSON.stringify(failures.slice(0, 8));
  res.writeHead(status, headers);
  res.end(body);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string, failures: Failure[]): void {
  const body =
    wire === 'anthropic'
      ? JSON.stringify({ type: 'error', error: { type, message } })
      : JSON.stringify({ error: { message, type, code: null } });
  send(res, status, 'application/json', body, failures);
}

function modelsRoute(req: IncomingMessage, res: ServerResponse): void {
  if (typeof req.headers['x-api-key'] === 'string') {
    const body = JSON.stringify({
      data: brief.models.map((m) => ({ type: 'model', id: m.id, display_name: m.display_name, created_at: FIXED_CREATED_AT })),
      has_more: false,
    });
    send(res, 200, 'application/json', body, []);
    return;
  }
  const body = JSON.stringify({
    object: 'list',
    data: brief.models.map((m) => ({ id: m.id, object: 'model', created: FIXED_CREATED, owned_by: 'openrouter' })),
  });
  send(res, 200, 'application/json', body, []);
}

async function completions(req: IncomingMessage, res: ServerResponse, wire: 'openai' | 'anthropic'): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, wire, 400, 'invalid_request_error', 'the request body is not one JSON object', []);
  const requirement = requirementsFor(body, wire);
  const gatewayBody = wire === 'anthropic' ? anthropicToOpenAI(body) : { ...body };
  delete gatewayBody.stream;
  delete gatewayBody.stream_options;
  const result = await serve(gatewayBody, requirement);
  if (!('answer' in result)) {
    return sendError(res, wire, 502, wire === 'anthropic' ? 'api_error' : 'upstream_error', 'every free model that meets this request refused or failed', result.failures);
  }
  const rendered = wire === 'anthropic' ? renderAnthropic(result.answer, result.model, body, body.stream === true) : renderOpenAI(result.answer, result.model, body, body.stream === true);
  send(res, 200, rendered.contentType, rendered.body, result.failures);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') return modelsRoute(req, res);
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return completions(req, res, 'openai');
  if (req.method === 'POST' && url.pathname === '/v1/messages') return completions(req, res, 'anthropic');
  return sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`, []);
}

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

async function register(port: number): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: 1, port, catalog }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}`);
  log(`registered on port ${port} with ${brief.models.length} free models`);
}

/** Poll GET /work; exit 0 the moment the env says every prompt has been driven. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status === 200) {
          const work: unknown = await res.json();
          if (isRecord(work) && work.done === true) {
            clearInterval(timer);
            server.close();
            process.exit(0);
          }
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, 200);
}

async function start(): Promise<void> {
  if (process.argv.includes('--list')) {
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (GATEWAY_URL === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, 'openai', 500, 'internal_error', 'the server failed to answer', []);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  if (address.port === 8080) throw new Error('the OS picked 8080, which the env owns');
  await register(address.port);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
