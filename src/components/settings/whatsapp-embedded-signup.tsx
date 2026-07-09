'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, MessageCircle, AlertTriangle, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

// Public (safe to expose) — the Facebook JS SDK reads these in-browser.
const APP_ID = process.env.NEXT_PUBLIC_META_APP_ID;
const CONFIG_ID = process.env.NEXT_PUBLIC_META_CONFIG_ID;
// Keep in lockstep with the server route + meta-api helpers.
const GRAPH_VERSION = 'v21.0';

// Meta posts the Embedded Signup session info from these origins.
const FB_MESSAGE_ORIGINS = new Set([
  'https://www.facebook.com',
  'https://web.facebook.com',
]);

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    FB?: any;
    fbAsyncInit?: () => void;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// Button label + spinner, split out to avoid a nested ternary in JSX.
function renderButtonInner({
  connecting,
  sdkReady,
}: {
  connecting: boolean;
  sdkReady: boolean;
}) {
  if (connecting) {
    return (
      <>
        <Loader2 className="mr-2 size-4 animate-spin" />
        Connecting…
      </>
    );
  }
  if (!sdkReady) {
    return (
      <>
        <Loader2 className="mr-2 size-4 animate-spin" />
        Loading Facebook SDK…
      </>
    );
  }
  return (
    <>
      <MessageCircle className="mr-2 size-4" />
      Connect WhatsApp
    </>
  );
}

/**
 * WhatsApp Embedded Signup (coexistence) launcher.
 *
 * Loads the Facebook JS SDK, runs Meta's Embedded Signup with our
 * Login-for-Business config, captures the phone_number_id / waba_id from
 * the session-info postMessage, and hands the OAuth code + those ids to
 * the server route which finishes the connection.
 */
export function WhatsAppEmbeddedSignup() {
  const [sdkReady, setSdkReady] = useState(false);
  const [connecting, setConnecting] = useState(false);
  // phone_number_id / waba_id arrive via postMessage BEFORE the FB.login
  // callback fires with the code, so stash them in a ref to read later.
  const sessionInfoRef = useRef<{ phoneNumberId?: string; wabaId?: string }>({});

  const configured = Boolean(APP_ID && CONFIG_ID);

  // --- Load the Facebook JS SDK once ---------------------------------
  useEffect(() => {
    if (!configured) return;
    if (typeof window === 'undefined') return;
    if (window.FB) {
      setSdkReady(true);
      return;
    }

    window.fbAsyncInit = function () {
      window.FB?.init({
        appId: APP_ID,
        autoLogAppEvents: true,
        xfbml: true,
        version: GRAPH_VERSION,
      });
      setSdkReady(true);
    };

    const scriptId = 'facebook-jssdk';
    if (document.getElementById(scriptId)) return;
    const js = document.createElement('script');
    js.id = scriptId;
    js.src = 'https://connect.facebook.net/en_US/sdk.js';
    js.async = true;
    js.defer = true;
    js.crossOrigin = 'anonymous';
    document.body.appendChild(js);
  }, [configured]);

  // --- Capture the Embedded Signup session info ----------------------
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!FB_MESSAGE_ORIGINS.has(event.origin)) return;
      try {
        const data = JSON.parse(event.data);
        if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
        // On FINISH, data.data carries the identifiers we need.
        if (data.data?.phone_number_id || data.data?.waba_id) {
          sessionInfoRef.current = {
            phoneNumberId: data.data.phone_number_id,
            wabaId: data.data.waba_id,
          };
        }
        if (data.event === 'CANCEL' || data.event === 'ERROR') {
          // Reset any half-captured info so a retry starts clean.
          sessionInfoRef.current = {};
        }
      } catch {
        // Non-JSON postMessage from Facebook (unrelated SDK chatter) — ignore.
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const finalize = useCallback(
    async (code: string, phoneNumberId?: string, wabaId?: string) => {
      try {
        const res = await fetch('/api/whatsapp/embedded-signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            phone_number_id: phoneNumberId,
            waba_id: wabaId,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          toast.error(data.error || 'Failed to complete the connection.');
          return;
        }

        toast.success(
          data.phone_info?.verified_name
            ? `Connected — ${data.phone_info.verified_name} is now live.`
            : 'WhatsApp connected via coexistence.',
          { duration: 8000 },
        );

        if (data.subscribe_error) {
          toast.warning(
            `Saved, but subscribing the WABA to this app failed: ${data.subscribe_error}. Use "Verify Registration" below to retry.`,
            { duration: 12000 },
          );
        }

        // If the server minted a fresh webhook verify token, surface it
        // once — the admin needs it for the Meta App Dashboard webhook.
        if (data.verify_token) {
          const callbackUrl = `${window.location.origin}/api/whatsapp/webhook`;
          toast.info(
            `Set your Meta App webhook — Callback URL: ${callbackUrl} · Verify token: ${data.verify_token} (copied).`,
            { duration: 20000 },
          );
          try {
            await navigator.clipboard.writeText(data.verify_token);
          } catch {
            /* clipboard may be blocked; the toast still shows the token */
          }
        }

        // Reload so the manual-config panel below re-hydrates from the
        // freshly-saved row (status, phone number, registration state).
        setTimeout(() => window.location.reload(), 1500);
      } catch (err) {
        console.error('[embedded-signup] finalize error:', err);
        toast.error('Network error completing the connection. Try again.');
      } finally {
        setConnecting(false);
        sessionInfoRef.current = {};
      }
    },
    [],
  );

  const launch = useCallback(() => {
    if (!window.FB) {
      toast.error('Facebook SDK is still loading — try again in a moment.');
      return;
    }
    setConnecting(true);
    sessionInfoRef.current = {};

    window.FB.login(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (response: any) => {
        // Log the raw response so the exact failure mode is visible in
        // the browser console (Meta gives no code for several distinct
        // reasons — cancel, no access, token-type config, blocked popup).
        console.log('[embedded-signup] FB.login response:', response);

        const authResponse = response?.authResponse;
        const code = authResponse?.code;
        if (code) {
          const { phoneNumberId, wabaId } = sessionInfoRef.current;
          void finalize(code, phoneNumberId, wabaId);
          return;
        }

        setConnecting(false);

        // Meta returned a token instead of a code → the Login config is
        // not a "code response" Embedded Signup config.
        if (authResponse?.accessToken) {
          toast.error(
            'Meta returned an access token, not a code. Your Facebook Login for Business configuration must use the WhatsApp Embedded Signup (code) response type.',
            { duration: 12000 },
          );
          return;
        }
        if (response?.status === 'not_authorized') {
          toast.error(
            'Login was not authorized — you must approve the requested WhatsApp permissions in the popup.',
            { duration: 10000 },
          );
          return;
        }
        toast.error(
          'No authorization code returned. Check: (1) you completed the popup without closing it, (2) this exact domain is in your Meta app\u2019s Allowed Domains / OAuth redirect URIs, and (3) your Facebook account has admin/developer/tester access to the app (apps in Development mode reject everyone else).',
          { duration: 14000 },
        );
      },
      {
        config_id: CONFIG_ID,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, sessionInfoVersion: '3' },
      },
    );
  }, [finalize]);

  // --- Not configured: guide the admin to set env vars ---------------
  if (!configured) {
    return (
      <section>
        <Alert className="border-amber-600/40 bg-amber-950/30">
          <AlertTriangle className="size-5 text-amber-400" />
          <AlertTitle>Coexistence signup not configured</AlertTitle>
          <AlertDescription>
            To enable one-click WhatsApp coexistence, set{' '}
            <code>NEXT_PUBLIC_META_APP_ID</code> and{' '}
            <code>NEXT_PUBLIC_META_CONFIG_ID</code> in your environment (Meta
            App dashboard → Facebook Login for Business → your Embedded Signup
            configuration), then restart the app. Until then, use the manual
            configuration form below.
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageCircle className="size-5 text-green-500" />
          Connect WhatsApp (Coexistence)
        </CardTitle>
        <CardDescription>
          Link your existing WhatsApp Business App number and keep using it on
          your phone while the CRM sends and receives on the same number. Runs
          Meta&apos;s official Embedded Signup — you&apos;ll scan a QR code with
          the WhatsApp Business app to finish.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button onClick={launch} disabled={!sdkReady || connecting}>
          {renderButtonInner({ connecting, sdkReady })}
        </Button>
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Copy className="mt-0.5 size-3 shrink-0" />
          After connecting, if a webhook verify token is shown, it&apos;s copied
          to your clipboard — paste it into Meta App dashboard → WhatsApp →
          Configuration along with the callback URL from the panel below.
        </p>
      </CardContent>
    </Card>
  );
}
