import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { verifyPhoneNumber, subscribeWabaToApp } from '@/lib/whatsapp/meta-api'
import { encrypt } from '@/lib/whatsapp/encryption'

/**
 * POST /api/whatsapp/embedded-signup
 *
 * Completes the WhatsApp Embedded Signup (coexistence) flow.
 *
 * The browser runs Meta's Embedded Signup via the Facebook JS SDK and
 * hands us three things:
 *   - `code`             — an OAuth authorization code (response_type=code)
 *   - `phone_number_id`  — from the WA_EMBEDDED_SIGNUP session-info message
 *   - `waba_id`          — same
 *
 * We then, server-side:
 *   1. Exchange `code` for a business access token (needs the App Secret,
 *      which must never touch the browser).
 *   2. Validate the token + phone number against Meta.
 *   3. Subscribe the WABA to this app so inbound events flow.
 *   4. Encrypt the token and upsert the account's whatsapp_config row.
 *
 * Admin-only: connecting WhatsApp is an account-level configuration
 * change, so we gate on the 'admin' role (same bar as the manual form's
 * effect, enforced explicitly here).
 */

// The Graph version is pinned to match src/lib/whatsapp/meta-api.ts so
// the OAuth exchange and the subsequent Graph calls speak the same API.
const GRAPH_VERSION = 'v21.0'
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

// Service-role client — used only to detect a phone_number_id already
// claimed by a DIFFERENT account. Under RLS the caller can't see other
// accounts' rows, so the conflict would be invisible without it. Mirrors
// the pattern in /api/whatsapp/config.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

interface TokenExchangeResponse {
  access_token?: string
  token_type?: string
  error?: { message?: string }
}

/**
 * Recover the WABA ID + phone number ID from the exchanged access token.
 *
 * Meta's WA_EMBEDDED_SIGNUP postMessage is flaky (origin quirks, timing,
 * new business portfolios), so the browser often arrives without these ids.
 * The exchanged token IS scoped to the granted WABA, so we can recover them:
 *
 *   1. `debug_token` → `granular_scopes[].target_ids` → WABA id(s)
 *   2. `GET /{waba_id}/phone_numbers` → phone number id(s)
 *
 * Returns whatever it can resolve; callers check for undefined.
 */
async function resolveIdsFromToken(
  accessToken: string,
  appId: string,
  appSecret: string,
): Promise<{ wabaId?: string; phoneNumberId?: string }> {
  const result: { wabaId?: string; phoneNumberId?: string } = {}

  // --- Step 1: introspect the token to find WABA id(s) ----------------
  // The app-level access token (appId|appSecret) is used as the
  // `access_token` param, while the user's business token is `input_token`.
  try {
    const debugParams = new URLSearchParams({
      input_token: accessToken,
      access_token: `${appId}|${appSecret}`,
    })
    const debugRes = await fetch(
      `${GRAPH_BASE}/debug_token?${debugParams.toString()}`,
    )
    if (debugRes.ok) {
      const debugData = (await debugRes.json()) as {
        data?: {
          granular_scopes?: Array<{
            scope?: string
            target_ids?: string[]
          }>
        }
      }
      // Look for whatsapp_business_management or
      // whatsapp_business_messaging scopes — both carry target_ids
      // containing the WABA id.
      const scopes = debugData.data?.granular_scopes ?? []
      for (const s of scopes) {
        if (
          s.scope?.includes('whatsapp_business') &&
          s.target_ids?.length
        ) {
          result.wabaId = s.target_ids[0]
          break
        }
      }
    }
  } catch (err) {
    console.warn('[embedded-signup] debug_token introspection failed:', err)
  }

  // --- Step 2: resolve phone number id from the WABA ------------------
  if (result.wabaId) {
    try {
      const phoneRes = await fetch(
        `${GRAPH_BASE}/${result.wabaId}/phone_numbers?fields=id`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      )
      if (phoneRes.ok) {
        const phoneData = (await phoneRes.json()) as {
          data?: Array<{ id?: string }>
        }
        if (phoneData.data?.length && phoneData.data[0].id) {
          result.phoneNumberId = phoneData.data[0].id
        }
      }
    } catch (err) {
      console.warn('[embedded-signup] phone_numbers lookup failed:', err)
    }
  }

  return result
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { supabase, userId, accountId } = ctx

  // --- Inputs ---------------------------------------------------------
  let body: {
    code?: string
    phone_number_id?: string
    waba_id?: string
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const code = body.code
  // Mutable: the browser may not report these (Meta's session-info
  // postMessage is flaky), in which case we derive them from the token
  // below. So they start as whatever the client sent, possibly undefined.
  let phone_number_id = body.phone_number_id
  let waba_id = body.waba_id
  if (!code) {
    return NextResponse.json(
      { error: 'Missing authorization code from Embedded Signup.' },
      { status: 400 },
    )
  }

  // --- App credentials ------------------------------------------------
  const appId = process.env.NEXT_PUBLIC_META_APP_ID ?? process.env.META_APP_ID
  const appSecret = process.env.META_APP_SECRET
  if (!appId || !appSecret) {
    return NextResponse.json(
      {
        error:
          'Server is missing NEXT_PUBLIC_META_APP_ID and/or META_APP_SECRET. Set them in the environment and restart.',
      },
      { status: 500 },
    )
  }

  // --- 1. Exchange the code for a business access token ---------------
  let accessToken: string
  try {
    const params = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      code,
    })
    const res = await fetch(`${GRAPH_BASE}/oauth/access_token?${params.toString()}`)
    const data = (await res.json()) as TokenExchangeResponse
    if (!res.ok || !data.access_token) {
      const message = data.error?.message ?? `Meta token exchange failed (${res.status})`
      console.error('[embedded-signup] token exchange failed:', message)
      return NextResponse.json({ error: `Token exchange failed: ${message}` }, { status: 400 })
    }
    accessToken = data.access_token
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[embedded-signup] token exchange threw:', message)
    return NextResponse.json({ error: `Token exchange error: ${message}` }, { status: 502 })
  }

  // --- 1b. Resolve WABA + phone number if the browser didn't ---------
  // Meta's WA_EMBEDDED_SIGNUP postMessage doesn't always reach us (origin
  // quirks, timing), so the client can arrive here without the ids. The
  // exchanged token IS scoped to the granted WABA, so we can recover them:
  //   debug_token           -> granular_scopes target_ids = WABA id(s)
  //   /{waba_id}/phone_numbers -> phone number id(s)
  if (!phone_number_id || !waba_id) {
    const resolved = await resolveIdsFromToken(accessToken, appId, appSecret)
    waba_id = waba_id || resolved.wabaId
    phone_number_id = phone_number_id || resolved.phoneNumberId
  }
  if (!phone_number_id || !waba_id) {
    return NextResponse.json(
      {
        error:
          'Connected, but could not determine the WABA / phone number ID from the signup. Make sure a phone number is added to your WhatsApp Business Account, then retry the connection.',
      },
      { status: 400 },
    )
  }

  // --- 2. Validate the token + phone number against Meta --------------
  let phoneInfo
  try {
    phoneInfo = await verifyPhoneNumber({ phoneNumberId: phone_number_id, accessToken })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Meta API error'
    console.error('[embedded-signup] phone verification failed:', message)
    return NextResponse.json(
      { error: `Meta rejected the connected number: ${message}` },
      { status: 400 },
    )
  }

  // --- Guard: is this number already claimed by another account? ------
  const { data: claimed, error: claimedError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('account_id')
    .eq('phone_number_id', phone_number_id)
    .neq('account_id', accountId)
    .maybeSingle()

  if (claimedError) {
    console.error('[embedded-signup] claim check failed:', claimedError)
    return NextResponse.json({ error: 'Failed to validate configuration' }, { status: 500 })
  }
  if (claimed) {
    return NextResponse.json(
      {
        error:
          'This WhatsApp number is already linked to another account on this instance. Each number can connect to one account only.',
      },
      { status: 409 },
    )
  }

  // --- 3. Subscribe the WABA to this app (best-effort) ----------------
  // Idempotent on Meta's side. Non-fatal: we still save so the user can
  // retry the subscription from the diagnostics rather than re-run the
  // whole signup.
  let subscribedAppsAt: string | null = null
  let subscribeError: string | null = null
  try {
    await subscribeWabaToApp({ wabaId: waba_id, accessToken })
    subscribedAppsAt = new Date().toISOString()
  } catch (err) {
    subscribeError = err instanceof Error ? err.message : String(err)
    console.warn('[embedded-signup] subscribed_apps failed (non-fatal):', subscribeError)
  }

  // --- 4. Encrypt + persist -------------------------------------------
  let encryptedAccessToken: string
  try {
    encryptedAccessToken = encrypt(accessToken)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown encryption error'
    console.error('[embedded-signup] encryption failed:', message)
    return NextResponse.json(
      {
        error:
          'Failed to encrypt the access token. Check ENCRYPTION_KEY is a valid 64-char hex string.',
      },
      { status: 500 },
    )
  }

  // Look up any existing row so we preserve its verify_token (used for
  // the app-level webhook GET handshake). If there isn't one yet, mint a
  // fresh verify token and return it so the admin can paste it into the
  // Meta App Dashboard → WhatsApp → Configuration webhook settings.
  const { data: existing } = await supabase
    .from('whatsapp_config')
    .select('id, verify_token')
    .eq('account_id', accountId)
    .maybeSingle()

  let verifyTokenPlain: string | null = null
  let encryptedVerifyToken: string | null = existing?.verify_token ?? null
  if (!encryptedVerifyToken) {
    verifyTokenPlain = crypto.randomBytes(24).toString('hex')
    encryptedVerifyToken = encrypt(verifyTokenPlain)
  }

  const nowIso = new Date().toISOString()
  const baseRow = {
    phone_number_id,
    waba_id,
    access_token: encryptedAccessToken,
    verify_token: encryptedVerifyToken,
    status: 'connected',
    connected_at: nowIso,
    // Coexistence numbers are registered through the Embedded Signup
    // flow itself (no separate /register + PIN step), so mark them live.
    registered_at: nowIso,
    subscribed_apps_at: subscribedAppsAt,
    last_registration_error: subscribeError,
    updated_at: nowIso,
  }

  if (existing) {
    const { error: updateError } = await supabase
      .from('whatsapp_config')
      .update(baseRow)
      .eq('account_id', accountId)
    if (updateError) {
      console.error('[embedded-signup] update failed:', updateError)
      return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
    }
  } else {
    const { error: insertError } = await supabase
      .from('whatsapp_config')
      .insert({ account_id: accountId, user_id: userId, ...baseRow })
    if (insertError) {
      console.error('[embedded-signup] insert failed:', insertError)
      return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
    }
  }

  return NextResponse.json({
    success: true,
    connected: true,
    subscribed: subscribedAppsAt != null,
    subscribe_error: subscribeError,
    phone_info: phoneInfo,
    // Present only when we just minted one. The UI shows it once so the
    // admin can configure the app-level webhook verify token in Meta.
    verify_token: verifyTokenPlain,
  })
}
