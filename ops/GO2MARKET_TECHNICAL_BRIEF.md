# Technical Brief & Integration Questions — Go2Market

**For:** Go2Market engineering team
**Subject:** Connecting our AI voice application to an existing 1600-series number

---

## 1. What we are asking for

We operate an AI voice-calling platform for Indian lending clients. Our client holds a
**registered 1600-series number on your platform**, used for outbound service and transactional
calls (EMI reminders, payment assistance, repayment servicing). Promotional content is out of
scope for this route.

**The split we need:**

| | |
|---|---|
| **Go2Market provides** | The telephony leg — place the outbound call, present the registered 1600 CLI, and give our application access to the live call audio |
| **We provide** | The entire conversation — speech recognition, dialogue logic, speech synthesis, transcripts, outcomes, compliance auditing |

**To be explicit:** we are **not** looking for a hosted IVR, a drag-and-drop call-flow builder,
or a packaged voicebot. Our conversational engine already exists and is in production. We need
the telephony layer and a way to exchange live audio with it.

---

## 2. Our stack

| Layer | Technology |
|---|---|
| **Runtime** | Node.js 22 |
| **API / call engine** | Express 4, `ws` (WebSocket server) |
| **Real-time audio** | Custom bidirectional streaming engine — VAD, turn-taking, barge-in, playback synchronisation |
| **Speech-to-text** | Sarvam AI (`saaras:v3`), streaming |
| **Text-to-speech** | Sarvam AI (`bulbul:v3`) |
| **LLM** | Sarvam AI (`sarvam-30b`) |
| **Database** | PostgreSQL 18 |
| **Queue** | Redis 7 + BullMQ (outbound dispatch, pacing, concurrency control) |
| **Dashboard** | Next.js 14 |
| **Deployment** | Docker Compose on a single Linux host, Caddy reverse proxy (TLS + WebSocket) |
| **Hosting** | Migrating to India-hosted infrastructure (data-residency requirement); we will have a **static IP** |

**Note on AI providers:** we use Sarvam AI exclusively for STT, TTS and LLM. Non-Indian AI
providers were removed from the stack for data-residency compliance, since borrower audio and
transcripts must not leave Indian jurisdiction. The same constraint applies to any component
Go2Market would host on our behalf.

**Architecture:** multi-tenant. Each lending client has isolated data, its own playbooks and
brand identity, its own calling policy — and **its own outbound caller ID**, since each is a
separately registered entity.

---

## 3. How our current integration works (reference implementation)

We are integrated with **Exotel** today via their **Voicebot Applet**. Describing it precisely
is the fastest way for you to tell us whether an equivalent path exists on your platform.

**Call setup:** we call Exotel's REST API to dial. The request carries the destination number,
the caller ID, ring timeout, max duration, a status-callback URL, and a `StreamUrl` pointing at
a WebSocket endpoint we host.

**Media:** Exotel connects to our WebSocket and exchanges JSON frames:

| Direction | Event | Purpose |
|---|---|---|
| → us | `start` | Call metadata, stream ID, negotiated media format |
| → us | `media` | Base64-encoded customer audio |
| ← us | `media` | Base64-encoded synthesised audio for playback |
| ← us | `mark` | Marker we attach to a piece of audio |
| → us | `mark` | Returned when that audio **finishes playing** to the customer |
| ← us | `clear` | Discard audio already queued for playback (barge-in) |
| → us | `stop` | Call ended |

**Audio format:** raw **linear PCM16**, mono, **8 kHz** (16 kHz and 24 kHz also supported).
Outbound audio is chunked on 320-byte boundaries (320 bytes = 160 samples = 20 ms) and **paced
to real time** so the provider's playback buffer does not overrun.

**Correlation:** we attach our own call identifier at dial time and receive it back unchanged on
status webhooks, so provider records reconcile against ours.

---

## 4. Questions

### Tier 1 — these determine whether the integration is possible

**Q1. Can your platform exchange live audio bidirectionally with an application we host?**
That is: stream customer audio to our endpoint in real time, and play back audio we send, in
both directions, for the duration of the call.

Please indicate which you support:
- [ ] Real-time bidirectional streaming over WebSocket (or similar API)
- [ ] SIP trunking / SIP URI / RTP to a customer-hosted endpoint
- [ ] SIPREC-style media connectivity
- [ ] None of the above

*Equivalent features elsewhere: Exotel "Voicebot Applet", Twilio "Media Streams".*

**Q2. Is there an event indicating that audio we sent has finished playing to the customer?**
*Why we need it: this is how our engine knows to stop speaking and start listening. Without it,
natural turn-taking is not achievable — the system either talks over the customer or leaves
long silences.*

**Q3. Can we discard audio already queued for playback, mid-utterance?**
*Why we need it: this is barge-in. When a customer interrupts, playback must stop immediately.
Stopping our side of the stream is not sufficient — audio already buffered on your side
continues to play.*

### Tier 2 — these determine effort and timeline

**Q4. Audio format.** Linear PCM16, µ-law, or A-law? Sample rate — 8 kHz, 16 kHz? Is the format
**the same in both directions**? Any required frame/packet size?

**Q5. Can the caller ID be set per individual call**, via the dial API?
*Why we need it: we are multi-tenant. Each lender is a separately registered entity and a
1600-series number is registered to that entity, so calls must originate from the correct
client's number. This is a hard requirement.*

**Q6. Can we attach our own reference ID to a call and receive it back** on status webhooks and
CDR? *(Exotel supports this via a `CustomField` parameter.)*

**Q7. Status webhooks.** Which lifecycle events do you post (ringing, answered, completed, busy,
no-answer, failed)? Please share a **sample payload** and your retry behaviour.
*Why we need it: besides recording outcomes, our dispatcher releases a concurrency slot when a
call reaches a terminal state. Without terminal events, throughput degrades badly.*

**Q8. Outbound dial API** — endpoint, authentication scheme, full parameter list. Please share
documentation.

**Q9.** Can we set **ring timeout** and **maximum call duration** per call? Can we **terminate a
call** via API mid-conversation?

**Q10. Media endpoint configuration** — is the streaming URL set per call at dial time, or fixed
per number? Can we append our own query parameters? How is the connection authenticated —
token, shared secret, mTLS, IP allowlist?

### Tier 3 — if SIP is the only path

**Q11.** Do you terminate to a **static IP we provide**, or do we register to your SIP registrar?
**Q12.** Which **codecs** are supported? Do you support **SIP over TLS** and **SRTP**?
**Q13.** Which **RTP port ranges** must we open? Is a static public IP mandatory?
**Q14.** **Has any customer connected an external AI application to you over SIP?** If so, what
did they use as the media bridge? *(This tells us whether we are on a proven path.)*

### Tier 4 — operational, regulatory, commercial

**Q15.** Concurrent call limit, **CPS** (calls per second), API rate limits, throttling.
**Q16.** Is a **sandbox/test environment** available? We would like credentials to begin
integration work.
**Q17.** **Where are your media servers hosted?** Where do call audio, recordings and CDR reside
at rest? *(Data residency is a hard requirement for us.)*
**Q18.** Do you **allowlist customer IPs**? We will be providing a new static IP.
**Q19.** Is the client's 1600 number **already enabled for outbound**, or inbound-only?
**Q20.** **DLT / PE / TM registration** — which responsibilities are yours and which are the
NBFC's? Do our call scripts require **pre-registered content templates**, and what is the
approval turnaround when a script changes?
**Q21.** **DNC / NDNC scrubbing** — your side or ours?
**Q22.** Any restrictions or mandatory disclosure wording for using an **automated/AI voice** on
this number series?
**Q23.** **If we onboard a second NBFC**, does each require its own 1600 number and its own
registration? What is the provisioning lead time?
**Q24.** Call **recording** — available? Storage location, retention, retrieval method?
**Q25.** Commercials — per-minute rate on the 1600 route, setup fees, channel/concurrency
charges, monthly minimum, contract term.

---

## 5. What we would like to take away

1. A definitive answer to **Q1** — in writing, even if the remaining answers follow later
2. API and/or SIP integration documentation
3. Sample status-webhook / CDR payload
4. Audio format specification
5. Sandbox credentials, or a date for them
6. A named technical contact for follow-up

**Q1 determines our architecture and timeline**, so an early answer to that alone is more useful
to us than a complete response later.

---

*Final number allocation, DLT setup, calling scripts, calling windows and retention policy
remain subject to validation by the NBFC's compliance team and the licensed access provider.*
