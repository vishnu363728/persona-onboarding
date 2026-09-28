# Persona onboarding

A conversational onboarding experience for a personal AI, presented in an iPhone-style interface with messages and browser audio calls.

**[Try the live demo](https://persona-onboarding-demo.vercel.app/)**

## Experience

- Name your agent in chat, then accept its incoming call or continue by text.
- The agent learns your name and something you want help with, and offers an optional Gmail connection.
- Skip steps, change your mind, correct details, or begin getting help immediately.
- Move between calls and messages with shared conversation history and saved onboarding progress.
- Gmail connection instructions are spoken during the call and paired with a real connection card in messages.
- Conversation memory is private to the browser session. A new conversation starts fresh.

Voice uses **OpenAI GPT-Live 1**. Text and structured memory updates use **Together AI GLM-5.3-Flash**. Voice transcripts are retained for continuity without appearing as duplicate message bubbles.

## Run locally

Requires Node.js 22 or newer.

```sh
npm ci
npm run dev
```

Open [localhost:4317](http://127.0.0.1:4317).

Configure provider credentials privately before using live integrations. Local development can store session data on disk; production requires private Vercel Blob storage. Calls, text generation, and Gmail authorization report unavailable when their credentials are missing. No environment files or credentials are included in this repository.

## Architecture

- **Next.js and React:** phone interface, messages, call controls, and route handlers.
- **GPT-Live over WebRTC:** continuous audio with server-authenticated transcript and action handling.
- **Together AI:** conversational text and validated memory/onboarding updates.
- **Private Vercel Blob:** browser-scoped conversation records and a shared model-spending allowance.
- **Google OAuth:** verifies the connected Gmail account; the demo does not fetch inbox messages or send email.

A random HttpOnly cookie identifies each browser conversation. API credentials and encrypted Google tokens remain server-side. Calls save transcript fragments and finish pending memory work before text continuation. Concurrent operations use session locks, request deduplication, and call-specific settlement.

`src/lib/prompt.ts` defines the shared conversational mission. `onboarding.ts` selects the next unfinished objective. `live-config.ts` configures voice behavior, while `live.ts` coordinates transcripts, backend actions, and graceful shutdown. `src/components/use-voice.ts` manages browser audio and call transitions.

## Validation

```sh
npm test
npm run typecheck
npm run build
```

Automated tests cover onboarding transitions, corrections, skipped steps, browser isolation, retries, OAuth, call lifecycle, pending transcript persistence, usage accounting, and responsive UI behavior. They do not make paid model calls.

The current voice journey harness is available with:

```sh
npm run test:voice -- --help
```

Live evaluations use real model APIs and the application's spending allowance. They require explicit execution flags. Generated reports, recordings, local sessions, and credentials are excluded from Git.

## Deploy

Deploy as a Next.js project on Vercel. Configure OpenAI, Together AI, private Blob storage, Google OAuth, encryption, and cleanup credentials through private hosting settings. Configure the Google OAuth redirect URI for the deployment's `/api/google/callback` route. Google test-mode applications require authorized test users.

The model-spending allowance is shared across visitors; conversation memory is isolated by browser. Calls have no fixed duration cap, but available model budget and connection health can end a call. Long calls renew their audio connection. Model context is bounded, so older details may be summarized or omitted; separately saved profile fields remain available. Long-call transport renewal has automated coverage but has not been verified with a full-length hosted call. Automatic provider history compaction requires appropriate API-key permissions.

Session records expire after seven days without updates. See the demo's [privacy page](https://persona-onboarding-demo.vercel.app/privacy) and [asset attribution](ASSETS.md).
