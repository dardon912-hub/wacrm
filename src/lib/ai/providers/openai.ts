import { AiError } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

// Google Gemini's OpenAI-compatible endpoint — accepts a Gemini API
// key (AIza...) as the Bearer token.
const OPENAI_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'

interface OpenAiResponse {
  choices?: { message?: { content?: string } }[]
}

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text (handoff parsing happens in
 * `generateReply`).
 */
export async function generateOpenAi(args: ProviderArgs): Promise<string> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
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
        // Gemini's OpenAI-compat layer uses `max_tokens`, not the newer
        // `max_completion_tokens` name that the native OpenAI API accepts.
        max_tokens: MAX_OUTPUT_TOKENS,
        // Gemini 2.5 Flash "thinks" by default, which eats the token
        // budget and can return empty replies — turn it off. (Remove
        // this line if you switch to a model that can't disable
        // thinking, e.g. gemini-2.5-pro.)
        reasoning_effort: 'none',
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Gemini', res)
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null
  const text = data?.choices?.[0]?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError('Gemini returned an empty response.', {
      code: 'empty_response',
    })
  }
  return text
}
