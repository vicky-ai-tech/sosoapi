# Threads CLI versus browser benchmark

Use the same authorized Threads test account, exact text, model, reasoning effort, agent harness and provider-confirmed outcome. Compare the CLI `posts publish` path with the native browser composer. Record the exact CLI version and comparable starting context. Resolve credentials, account identity and permission before the warm runs. Count any handoff or wait that occurs during a run.

## New-user run

From a clean CLI environment, give the agent one prompt with an exact caption and the intended Threads handle. Start the timer with the prompt. Record each human handoff for tool approval, SosoAPI registration/sign-in, agent consent, Threads consent, account selection or post confirmation. Count distinct handoffs and keep the individual consent events visible. End when a confirmed Threads permalink is returned. Verify the exact account and text at that link.

## Warm pair

Use independent sessions with the original benchmark model and effort where available. Record the initial input-cache percentage in each arm. For comparison with a warm run, both must start at 90% or greater cached input. Keep other observations and label different conditions. Use the exact same approved caption inside a pair. Account selection, retries, ambiguous results and failed runs belong in the record.

For each arm capture:

- Wall-clock seconds from prompt to provider-confirmed link, including model/tool work and any human wait.
- Input tokens, cached input tokens and output tokens from the final accumulated usage once.
- Total tokens as input plus output. Uncached input as input minus cached input.
- Provider confirmation and exact-text verification. Keep test post IDs, screenshots and raw logs private.

Report the measurements with the cache condition and CLI version.

The [November 16 live result](../README.md#benchmark) records the completed same-model pair for `sosoapi@0.5.25`. Both sessions started with working authorization. The run captured final accumulated cache counts. Initial cache percentages were unavailable. Chrome's elapsed time includes the recorded browser-control relay queue.

## Dual CLI development measurement

On November 18, 2026, each cell used a fresh Codex session with the same model and effort (`gpt-6.2-sol`, `xhigh`). The task, destinations, content and completion rule matched within each pair. Browser runs drove real Chromium with synthetic native pages. API runs invoked the actual `sosoapi@0.5.25` executable with a loopback service. Connected cases checked the exact text, one submission per target, a confirmed link per destination and the photo digest when applicable. No test contacted a live social account.

| Task | Route | Input | Cached input (included) | Output | Total | Seconds | Shell calls |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Connected Threads text | Browser | 85,115 | 57,472 | 184 | 85,299 | 23.8 | 1 |
| Connected Threads text | API | 85,102 | 71,040 | 235 | 85,337 | 25.9 | 1 |
| Connected Facebook, Instagram and Threads photo | Browser | 115,851 | 100,608 | 348 | 116,199 | 29.6 | 3 |
| Connected Facebook, Instagram and Threads photo | API | 115,636 | 100,608 | 330 | 115,966 | 34.1 | 3 |
| First use up to native login handoff | Browser | 85,956 | 57,472 | 518 | 86,474 | 36.3 | 2 |
| First use up to SosoAPI login handoff | API | 85,975 | 71,296 | 386 | 86,361 | 31.1 | 2 |

Each connected run completed without a human handoff. Each disconnected run stopped once for sign-in with zero submissions. Installation was timed separately using the real installer against a locally staged skill and a cached installer. Internet downloads, human registration, OAuth and 2FA completion were outside that measurement. The usage figures include Codex's session context. One run per route and different cache hits limit conclusions about cost and timing. This development comparison covers the Threads and three-Meta cases. X and YouTube are outside the token sample.
