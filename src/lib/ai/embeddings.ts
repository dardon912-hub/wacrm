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
// ============================================================

const GEMINI_EMBEDDINGS_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models'

export const EMBEDDING_MODEL = 'gemini-embedding-001'
export const EMBEDDING_DIMENSIONS = 1536

// Keep batches modest so a big re-index stays under request-size
// limits and partial failures are cheap to retry.
const BATCH_SIZE = 96

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

/**
 * Embed a list of strings using the native Gemini batchEmbedContents
 * endpoint, preserving input order. Batched; throws `AiError` on
 * provider/network failure so callers can decide whether to degrade
 * (retrieval) or surface (ingest).
 */
export async function embedTexts(
  apiKey: string,
  inputs: string[],
): Promise<number[][]> {
  if (inputs.length === 0) return []
  const timeoutMs = aiRequestTimeoutMs()
  const out: number[][] = []

  for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
    const batch = inputs.slice(start, start + BATCH_SIZE)

    // Each request in the batch wraps a single string as a Content
    // object. outputDimensionality trims the 3072-dim native output to
    // 1536 so vectors fit the `vector(1536)` pgvector column.
    const requests = batch.map((text) => ({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      outputDimensionality: EMBEDDING_DIMENSIONS,
    }))

    const url = `${GEMINI_EMBEDDINGS_BASE}/${EMBEDDING_MODEL}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`

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

    if (!res.ok) {
      // Mirror the shape of providerHttpError but for the native API.
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
            ? 'Gemini embeddings rate limit reached'
            : `Gemini embeddings API error (${status})`

      throw new AiError(detail ? `${base}: ${detail}` : base, {
        code,
        status: code === 'invalid_key' ? 401 : 502,
      })
    }

    const data = (await res.json().catch(() => null)) as BatchEmbedResponse | null
    const rows = data?.embeddings
    if (!rows || rows.length !== batch.length) {
      throw new AiError('Gemini embeddings response was malformed.', {
        code: 'embeddings_malformed',
      })
    }

    for (const r of rows) {
      if (!Array.isArray(r.values)) {
        throw new AiError('Gemini embeddings response missing a vector.', {
          code: 'embeddings_malformed',
        })
      }
      out.push(r.values)
    }
  }

  return out
}
