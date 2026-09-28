export default function Privacy() {
  return (
    <main className="privacy-page">
      <a href="/">← Back to your persona</a>
      <h1>A little privacy context.</h1>
      <p>
        This is a working assessment demo of a personal AI onboarding
        experience, not a production inbox assistant.
      </p>
      <h2>Your conversation</h2>
      <p>
        Messages, voice transcripts, and the details you choose to share are
        stored server-side until seven days after your last activity; expired
        records are removed by a daily cleanup. A private browser cookie
        identifies your conversation. Anyone using the same browser profile can
        return to it. Drafts and messages waiting for delivery confirmation stay
        in this browser, so you can retry after a connection problem.
      </p>
      <h2>Voice and AI</h2>
      <p>
        Your messages and conversation context, including voice transcripts, are
        sent to Together AI for replies and onboarding actions. Voice calls
        stream microphone audio to OpenAI’s GPT-Live; the app saves transcripts,
        not audio recordings. Calls can continue while the shared demo spending
        allowance is available. You can interrupt, mute, hang up, or continue in
        text at any time.
      </p>
      <h2>Gmail</h2>
      <p>
        Connecting Gmail uses Google’s authorization page. We never ask for your
        password. This demo requests read-only Gmail permission to verify the
        account connection, but only retrieves your email address and connection
        status. It does not fetch message contents, send mail, or change your
        inbox. Google tokens are encrypted on the server.
      </p>
      <p>
        You can disconnect in the conversation’s details panel, or revoke access
        in your Google account settings. Disconnecting removes the stored tokens
        and asks Google to revoke access.
      </p>
      <h2>Starting over</h2>
      <p>
        New conversation creates a separate session; it does not immediately
        erase the old one. The old conversation expires automatically. Avoid
        sharing sensitive information with this assessment demo.
      </p>
    </main>
  );
}
