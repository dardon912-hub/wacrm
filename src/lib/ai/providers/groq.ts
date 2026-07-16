import { AiError } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

// Groq's OpenAI-compatible chat completions endpoint.
// Free tier: 30 RPM, 14,400 RPD (resets daily).
// Docs: https://console.groq.com/docs/openai
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

interface GroqResponse {
  choices?: { message?: { content?: string } }[]
}

/**
 * Call Groq's OpenAI-compatible Chat Completions endpoint.
 * Returns the raw assistant text (handoff parsing happens in
 * `generateReply`).
 */
export async function generateGroq(args: ProviderArgs): Promise<string> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergeConsecutive(messages),
        ],
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.3, // Lower temperature = more factual, less hallucination
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Groq', res)
  }

  const data = (await res.json().catch(() => null)) as GroqResponse | null
  const text = data?.choices?.[0]?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError('Groq returned an empty response.', {
      code: 'empty_response',
    })
  }
  return text
}
