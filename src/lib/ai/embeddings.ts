import { AiError } from './types'
import { aiRequestTimeoutMs } from './defaults'
import { toNetworkError } from './providers/shared'

// ============================================================
// Embeddings via the native Gemini batchEmbedContents API.
//
// We deliberately bypass the OpenAI-compat embeddings path
// (v1beta/openai/embeddings) because that layer does not reliably
// honour the `dimensions` parameter for gemini-embedding-001, which
// causes 404s. The native API supports `outputDimensionality` properly
// and lets us keep the `vector(1536)` pgvector column from migration
// 030 without a schema change.
//
// Auth: Gemini API key (AIza…) passed as a query-string param — the
// same key the user stores in the "Embeddings key" field.
//
// Rate limits (free tier): gemini-embedding-001 allows 5 RPM.
// We enforce a minimum inter-batch gap and retry 429s with exponential
// backoff so large re-indexes don't blow the quota.
// ============================================================

const GEMINI_EMBEDDINGS_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models'

export const EMBEDDING_MODEL = 'gemini-embedding-001'
export const EMBEDDING_DIMENSIONS = 1536

// Keep batches small on the free tier (5 RPM). Each batch = 1 request.
// With BATCH_SIZE=10 and MIN_BATCH_GAP_MS=13_000 we stay well under 5 RPM.
const BATCH_SIZE = 10

// Minimum wait between consecutive batch requests (ms).
// 5 RPM = 1 request per 12 s → use 13 s to give headroom.
const MIN_BATCH_GAP_MS = 13_000

// Retry config for 429 responses.
const MAX_RETRIES = 4
const RETRY_BASE_MS = 15_000 // 15 s initial back-off, doubles each retry

// ---- Native API response shapes --------------------------------

interface BatchEmbedResponse {
  embeddings?: { values?: number[] }[]
}

// ----------------------------------------------------------------

/** Format a vector for a pgvector column / RPC param: `[0.1,0.2,...]`.
 *  PostgREST casts this text literal to `vector`; a raw JS array does
 *  not cast reliably. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Fetch one batch with automatic 429-retry + exponential back-off.
 * Throws `AiError` on non-retryable failures.
 */
async function fetchBatch(
  url: string,
  requests: object[],
  timeoutMs: number,
  batchSize: number,
): Promise<number[][]> {
  let attempt = 0

  while (true) {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw toNetworkError(err)
    }

    if (res.status === 429 && attempt < MAX_RETRIES) {
      // Respect Retry-After header if present, otherwise use exponential back-off.
      const retryAfter = res.headers.get('Retry-After')
      const waitMs = retryAfter
        ? Number(retryAfter) * 1000
        : RETRY_BASE_MS * Math.pow(2, attempt)
      attempt++
      await sleep(waitMs)
      continue
    }

    if (!res.ok) {
      let detail = ''
      try {
        const body = (await res.json()) as {
          error?: { message?: string } | string
        }
        detail =
          typeof body?.error === 'string'
            ? body.error
            : (body?.error?.message ?? '')
      } catch {
        // Non-JSON body — fall through to status-only message.
      }

      const { status } = res
      const code =
        status === 401 || status === 403
          ? 'invalid_key'
          : status === 429
            ? 'rate_limited'
            : 'provider_error'
      const base =
        code === 'invalid_key'
          ? 'Gemini rejected the embeddings API key'
          : code === 'rate_limited'
            ? 'Gemini embeddings rate limit reached — try again in a minute'
            : `Gemini embeddings API error (${status})`

      throw new AiError(detail ? `${base}: ${detail}` : base, {
        code,
        status: code === 'invalid_key' ? 401 : 502,
      })
    }

    const data = (await res.json().catch(() => null)) as BatchEmbedResponse | null
    const rows = data?.embeddings
    if (!rows || rows.length !== batchSize) {
      throw new AiError('Gemini embeddings response was malformed.', {
        code: 'embeddings_malformed',
      })
    }

    const out: number[][] = []
    for (const r of rows) {
      if (!Array.isArray(r.values)) {
        throw new AiError('Gemini embeddings response missing a vector.', {
          code: 'embeddings_malformed',
        })
      }
      out.push(r.values)
    }
    return out
  }
}

/**
 * Embed a list of strings using the native Gemini batchEmbedContents
 * endpoint, preserving input order. Batched with inter-batch pacing and
 * 429-retry so the free-tier 5 RPM limit is never exceeded. Throws
 * `AiError` on non-retryable provider/network failure.
 */
export async function embedTexts(
  apiKey: string,
  inputs: string[],
): Promise<number[][]> {
  if (inputs.length === 0) return []
  const timeoutMs = aiRequestTimeoutMs()
  const out: number[][] = []
  let lastRequestAt = 0

  for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
    const batch = inputs.slice(start, start + BATCH_SIZE)

    // Enforce minimum gap between requests to stay under 5 RPM.
    const now = Date.now()
    const elapsed = now - lastRequestAt
    if (lastRequestAt > 0 && elapsed < MIN_BATCH_GAP_MS) {
      await sleep(MIN_BATCH_GAP_MS - elapsed)
    }

    const requests = batch.map((text) => ({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      outputDimensionality: EMBEDDING_DIMENSIONS,
    }))

    const url = `${GEMINI_EMBEDDINGS_BASE}/${EMBEDDING_MODEL}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`

    lastRequestAt = Date.now()
    const vectors = await fetchBatch(url, requests, timeoutMs, batch.length)
    out.push(...vectors)
  }

  return out
}
