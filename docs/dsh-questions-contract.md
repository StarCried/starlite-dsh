# DSH ordinary question lifecycle

StarLite answers only `user-questions/request`; it never answers tool permission approvals.
Real Session, Agent and tool-call identities remain in the Host. The companion receives
validated question text, per-request random references and public wait metadata only.

## Blocking and timed foreground questions

A blocking request retains its original waterfall result. A timed request first verifies
the exact live root through the public Agent directory, then consumes
`userQuestions.attachWait(agent, callId, signal)`. Its first `remainingMs` frame supplies
the deadline. StarLite keeps the stream claim until answer, cancellation, delegation or
deadline; an overdue answer is rejected even if the event loop has not run the timer.
Expiry uses the official `UserQuestionError` / `ASK_TIMED_OUT` error vocabulary so DSH
can create its own pending result. No timeout or duration is invented.

Disconnect, privacy/input unavailability and plugin disposal release the claim and
delegate to the next official answerer. Invalid frames or missing public capabilities
also delegate. Owner cancellation withdraws the request without reopening it elsewhere.

Timed interactions carry `wait: {state: "timed", deadline, issuedAt}`. Both timestamps
use the Host clock; `issuedAt` is refreshed when the interaction is read. The companion
uses their difference and local `performance.now()` elapsed time, rather than comparing
WSL and Windows wall clocks. Time spent loading after the opening status frame is
deducted, and newer Host frames may only shorten the display countdown. Inbound
transport or scheduling delay can make the display slightly late; it never grants
extra answer time. The Host alone enforces expiry and rejects late answers.

The complete interaction, including wait metadata, must fit the 32 KiB wire limit
before publication. Oversized timed requests release their claim and delegate;
oversized continued forms stay with DSH. Invalid or oversized interaction reads
return a controlled HTTP rejection without terminating the Host.

## Continued questions

The public `sessionProjections.onChanged` feed triggers reads of
`stateOf(session, "userQuestions").questions.active`. Only `continued` questions owned
by an exact live runtime root become late-answer forms. Before submission StarLite
rechecks the root, current question state and exact question batch, retires the random
reference, then awaits `userQuestions.answer`. The official atomic owner refuses
expired or already queued replies; HTTP success is sent only after that result.

A continued form does not change the Host's actual working/idle state or animation.
New foreground questions take priority. Tool permission approvals and errors retain
their own presentation. A turn ending withdraws foreground waits but does not erase
still-answerable continued questions. Disposed roots cannot submit late answers.

Choosing “转到 DSH 回答” suppresses the session's current continued questions; automatic
availability updates do not reclaim them. A genuinely new foreground question or a
new continued call permits reconsideration. Nothing is persisted.

## Qualification

`tools/dsh-questions-contract.mjs` checks the public declaration shapes for the
Agent directory, claim duration, business error, atomic reply, projection registration,
change feed and authoritative state read. Old builds without timed declarations keep
blocking-only behavior. A build advertising timed questions must expose every seam.
Unit and authenticated HTTP tests cover deadline boundaries, release, delegation,
late reply races, state priority and identity isolation without model/API requests.
