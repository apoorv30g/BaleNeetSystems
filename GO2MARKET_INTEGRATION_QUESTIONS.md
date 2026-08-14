# Technical Integration Requirements — AI Voice Calling on Existing 1600-Series Number

**To:** Go2Market — Technical / Solutions Team
**Subject:** Integrating our AI voice application with our existing 1600-series number

---

## Background

We operate an AI voice-calling platform used by lending clients in India. Our client already holds a **registered 1600-series number on your platform**, and we want to use that existing number for outbound service and transactional calls — EMI due reminders, overdue reminders, payment assistance, and repayment servicing. Promotional or cross-sell content is explicitly out of scope for this route.

**Our intended split of responsibilities:**

- **Go2Market** remains the originating telecom provider for the 1600-series leg, presenting the registered CLI, and provides call control plus a live audio interface.
- **Our platform** provides the entire conversation: speech-to-text, conversation logic, text-to-speech, campaign orchestration, transcripts, outcomes, and audit.

To be explicit about scope: we are **not** looking for a hosted IVR, a drag-and-drop call-flow builder, or a packaged voicebot product. Our AI engine already exists and handles the conversation. What we need from Go2Market is the telecom leg and a way to exchange live call audio with our application.

---

## Question 1 — The one that determines everything else

> **During an active call, can your platform exchange live audio bidirectionally with an external application that we host?**
>
> That is: stream the customer's audio to us in real time, *and* play back audio that we send you, continuously, in both directions, for the duration of the call.

This is the capability other providers call:
- **Exotel** — "Voicebot Applet"
- **Twilio** — "Media Streams"
- Others — "bidirectional media streaming", "audio streaming API", or SIP/RTP media connectivity

**If you can answer only one question in this document, please answer this one** — it determines our entire integration approach, timeline, and commercial decision.

Please indicate which of the following you support:

- [ ] **1a.** Real-time bidirectional audio streaming over WebSocket (or similar API) to a customer-hosted endpoint
- [ ] **1b.** SIP trunking / SIP URI routing / RTP media to a customer-hosted endpoint
- [ ] **1c.** SIPREC-style media connectivity
- [ ] **1d.** None of the above — live media cannot be exposed to an external application

---

## Section 2 — If you support WebSocket / API media streaming (1a)

2.1 Please share the protocol documentation: message and frame schema, event names, and connection lifecycle.

2.2 What audio encoding is used — linear PCM16, µ-law, or A-law? Which sample rates are supported (8 kHz / 16 kHz / 24 kHz)?

2.3 What packetization / frame size is expected? Must we pace outbound audio to real time, or may we send ahead of playback?

2.4 **Is there a playback-completion signal** — an event telling us when audio *we* sent has finished playing to the customer?
*This is how our system knows when to stop speaking and begin listening. Without it, natural turn-taking is not achievable.*

2.5 **Can we flush or cancel audio already queued for playback, mid-utterance?**
*This is required for "barge-in" — when a customer interrupts, the bot must stop speaking immediately. Without it, the system talks over customers.*

2.6 Is the media endpoint URL configured per call at dial time, or statically against the number? Can we append our own query parameters (e.g. an internal customer/call reference)?

2.7 How is the connection authenticated — bearer token, shared secret, IP allowlist, mTLS?

2.8 What is the typical round-trip audio latency on this path?

---

## Section 3 — If SIP / RTP is the integration path (1b or 1c)

3.1 What trunk model is used — do you terminate to a static IP that we provide, or do we register to your SIP registrar?

3.2 Which codecs are supported (G.711 a-law/µ-law, G.729, Opus)?

3.3 Which RTP port ranges must be open on our side? Is a static public IP mandatory?

3.4 Do you support SIP over TLS and SRTP?

3.5 Do you offer, or partner with, any SIP-to-WebSocket media bridge or similar gateway?

3.6 What is the SIP signalling and media termination location (city/region)?

---

## Section 4 — Call control and lifecycle

*(Required regardless of which media path applies.)*

4.1 Do you provide an **outbound call initiation API** for our registered 1600-series number? Please share endpoint, authentication scheme, and full parameter list.

4.2 **Can the caller ID be set per individual call?** Our platform is multi-tenant, and different clients originate from different numbers.

4.3 Can we configure a **ring timeout** and a **maximum call duration** per call?

4.4 **Call status webhooks** — which lifecycle events do you post back (ringing, answered, completed, busy, no-answer, failed)? Please share the payload schema and your retry behaviour on delivery failure.

4.5 **Custom metadata passthrough** — can we attach our own correlation ID when initiating a call and receive it back unchanged on status webhooks and CDR?
*This is how we reconcile your call records against ours. Our current provider supports this via a custom field parameter.*

4.6 Can we **terminate an in-progress call** programmatically from our side?

4.7 **DTMF** — can keypad input be captured and forwarded to our application in real time?

4.8 **Warm transfer** — can a live call be transferred to a human agent (or an external number) while preserving the customer leg? Please describe the mechanism.
*Required for escalation on disputes, hardship cases, and grievance handling.*

4.9 **Call recording** — is it available, where is audio stored, for how long, and how is it retrieved (recording URL on CDR)?

---

## Section 5 — Capacity, reliability, and environments

5.1 What is the **concurrent call limit** on our account, and how can it be increased?

5.2 What is the supported **CPS (calls per second)** rate, and what throttling applies?

5.3 What **API rate limits** apply?

5.4 What **retry rules** does your platform apply on failed calls, and can we control or disable them (we manage retry policy ourselves)?

5.5 Is a **sandbox / test environment** available before production? We would need credentials, API documentation, sample webhook and CDR payloads.

5.6 **Where are your media servers physically located?** Real-time voice is highly latency-sensitive and we need to co-locate our infrastructure accordingly.

5.7 What **SLA / uptime commitment** applies, and what are your support channels and hours?

5.8 What failover arrangements exist if a media server or trunk becomes unavailable mid-campaign?

---

## Section 6 — Security and data handling

6.1 What authentication and encryption are supported on the API and media paths?

6.2 What are your **data retention** periods for call audio, CDR, and logs — and can retention be configured?

6.3 What **audit logging** is available to us?

6.4 What **India data-residency** controls apply to call audio, recordings, and metadata for BFSI traffic? Where is this data stored at rest?

6.5 Do you support least-privilege / scoped API credentials, and credential rotation?

---

## Section 7 — Regulatory (1600-series specific)

7.1 Is the client's existing 1600-series number **already enabled for outbound** transactional calls, or is it currently inbound-only? If additional provisioning is needed, what is the process and timeline?

7.2 **DLT / PE / TM registration** — please confirm which responsibilities sit with Go2Market and which with the NBFC (Principal Entity registration, telemarketer registration, header and content template approval).

7.3 Do our call scripts require **pre-registered content templates**? If so, what is the approval process and typical turnaround time, and how are changes to a script handled?

7.4 Are there restrictions specific to the 1600 series regarding **calling windows, permitted content, or consent record-keeping** that differ from standard numbers?

7.5 **DNC / NDNC scrubbing** — is this performed on your side, on ours, or both?

7.6 Are there any restrictions or disclosure requirements for using an **automated / AI voice agent** on this number series? If specific disclosure language is mandated, please provide it.

7.7 Please confirm the **originating route** for this number is fully provisioned through the authorised access-provider arrangement — we will not consider any design that presents the 1600 CLI over an unrelated telecom path.

---

## Section 8 — Commercials

8.1 Per-minute outbound rate on the 1600-series route.

8.2 Any charges for SIP trunking, media streaming, or API usage.

8.3 Number rental and channel/concurrency charges.

8.4 Call recording and storage charges.

8.5 One-time setup or integration fees.

8.6 Minimum monthly commitment, contract term, and notice period.

---

## What we would like to receive

To begin implementation on our side, we would need:

1. A definitive answer to **Question 1**
2. API and/or SIP integration documentation
3. Sandbox credentials
4. Sample webhook and CDR payloads
5. Supported codec and audio format specification
6. Pricing per Section 8

An early answer to Question 1 alone is more useful to us than a complete response later, as it determines our architecture.

---

*Prepared as a technical integration requirement. Final number allocation, DLT setup, calling scripts, calling windows, frequency limits, and recording/retention policy remain subject to validation by the NBFC's compliance team and the licensed access provider.*
