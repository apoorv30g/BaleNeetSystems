# Go2Market meeting — what to ask

Personal cheat-sheet (the formal version is `Go2Market_Integration_Requirements.docx`).
Goal: leave the meeting able to answer **"can we build this, and how long will it take?"**

**Ask for a technical/solutions person on the call.** A salesperson cannot answer Q1 reliably,
and a wrong answer there costs weeks.

---

## Before anything else: kill the biggest misunderstanding

Go2Market sells an AI voicebot product. You do **not** want it. Open by saying so:

> "We have our own AI voice engine — speech recognition, conversation logic, and speech
> synthesis all run on our servers. We are not looking for your voicebot or your IVR builder.
> We want Go2Market to be the telephony layer only: place the call from our client's registered
> 1600 number, and give our application access to the live audio."

If you skip this, most of the meeting will be a demo of their bot.

---

## Q1 — THE question. Everything depends on it.

> **"During a live call, can your platform send the customer's audio to a server we control,
> in real time, and play back audio we send you — continuously, in both directions, for the
> whole call?"**

### How to tell a real answer from a vague one

| They say | What it means | Follow up with |
|---|---|---|
| "Yes, we support AI voicebots" | Probably **their** bot | "I mean *our* bot on *our* servers. Can the audio reach our endpoint?" |
| "Yes, we have APIs" | Probably click-to-call only | "Does that API carry live audio, or only start and stop calls?" |
| "Yes, via SIP" | Real answer — go to Q3 | "SIP trunk to our IP, or do we register to you?" |
| "Yes, WebSocket / media streaming" | **Best case** — go to Q2 | "Can you send the protocol documentation?" |
| "We can build it for you" | Custom work — timeline and cost risk | "Is it in production with another customer today?" |
| Hesitation, or "let me check" | Likely no | Ask for a written answer within 48h |

### The comparison that makes it concrete

> "Exotel calls this their **Voicebot Applet**. Twilio calls it **Media Streams**. Do you have
> an equivalent?"

Naming a competitor's feature is the fastest way past the marketing layer — most technical
people recognise it immediately.

---

## Q2 — If YES to streaming (the good path)

These are exactly what I need to write the adapter:

1. **Send the protocol docs** — message format, event names, connection lifecycle.
2. **Audio format** — linear PCM16, µ-law or A-law? Sample rate: 8k / 16k / 24k?
3. **"Audio finished playing" event?** — is there a signal telling us our audio has finished
   playing to the customer?
   → *Why it matters: this is how the bot knows to stop talking and start listening. Without it
   there is no natural turn-taking — the bot speaks over people.*
4. **Can we cancel audio already queued for playback?**
   → *Why it matters: this is barge-in. Without it, when a customer interrupts, the bot keeps
   talking for several seconds.*
5. **Is the endpoint URL set per call, or fixed per number?** Can we add our own query
   parameters (customer ref, call ref)?
6. **How is the connection authenticated?** Token, shared secret, IP allowlist?
7. **Typical round-trip audio latency?**

> **3 and 4 are make-or-break.** A platform that streams audio but has neither cannot support a
> natural conversation. If they are unsure, that itself is the answer — press for specifics.

---

## Q3 — If SIP only

1. Do you terminate to a **static IP we provide**, or do we register to your SIP registrar?
2. Which **codecs**? (G.711 a-law/µ-law, Opus?)
3. Which **RTP port ranges** must we open? Is a static public IP required?
4. Do you support **SIP over TLS** and **SRTP**?
5. Do you offer — or partner with — a **SIP-to-WebSocket bridge**?

> SIP-only means we additionally need a media gateway (Jambonz/FreeSWITCH). Feasible, but it is
> new infrastructure and a materially bigger build. Worth saying openly: *"If it's SIP-only,
> what's the fastest path other customers have taken to connect an external AI bot?"*

---

## Q4 — Call control (needed either way)

1. **Outbound call API** — endpoint, authentication, parameters. Send docs.
2. **Can the caller ID be set per individual call?**
   → *We are multi-tenant; each lender dials from their own registered number. This is a hard
   requirement, not a preference.*
3. Can we set **ring timeout** and **max call duration** per call?
4. **Status webhooks** — which events (ringing, answered, completed, busy, no-answer, failed)?
   Send a sample payload.
5. **Can we attach our own reference ID to a call and get it back on the webhook?**
   → *Without this we cannot reconcile your call records with ours.*
6. Can we **hang up a call** via API mid-conversation?
7. **DTMF** — can keypad input be forwarded to us live?
8. **Recording** — available? Where stored? How retrieved?

---

## Q5 — The 1600 number specifically

1. Is the client's existing 1600 number **already enabled for outbound**, or inbound-only?
2. **DLT / PE / TM registration** — which parts are yours, which are the NBFC's?
3. Do our **call scripts need pre-registered content templates**? Approval turnaround? What
   happens when we change a script?
4. Any restrictions on **calling windows, content, or consent records** specific to 1600?
5. **DNC/NDNC scrubbing** — your side or ours?
6. Any restriction on using an **AI/automated voice** on this series? Mandatory disclosure
   wording?
7. **Multi-client:** if we onboard a second NBFC, does each need its own 1600 number and its own
   registration? What is the lead time?

---

## Q6 — Capacity, environments, commercials

1. **Concurrent call limit** and **CPS** (calls per second)?
2. **Sandbox/test account** — available? *(Ask directly: "Can we have sandbox credentials this
   week?")*
3. **Where are your media servers hosted?** *(We are moving to India-hosted infrastructure;
   latency and residency both matter.)*
4. **Data residency** — where do call audio, recordings and CDR live at rest?
5. Per-minute rate on the 1600 route, setup fees, monthly minimum, contract term.
6. Do you **allowlist customer IPs**? *(We will have a new static IP — we need to know the
   process.)*

---

## Leave the meeting with

- [ ] A **written** yes/no on Q1 (email is fine — verbal is not enough to plan on)
- [ ] API and/or SIP documentation
- [ ] Sample webhook / CDR payload
- [ ] Sandbox credentials, or a date for them
- [ ] Named technical contact (not just the account manager)
- [ ] Pricing

## Closing line

> "The single thing that decides our timeline is whether our own AI can connect to the live
> audio. Could you confirm that in writing this week, even if the rest takes longer?"

---

## What each answer means for us

| Answer | Effort | Notes |
|---|---|---|
| **WebSocket streaming** | Weeks | Adapter + protocol layer. Conversation engine reused unchanged. |
| **SIP only** | Months | Plus a media gateway and new infra to run. |
| **Neither** | Not viable as designed | Only their bot calling our APIs — we would lose the flow engine, grounding filter, self-training and compliance auditing. That is the product. |
