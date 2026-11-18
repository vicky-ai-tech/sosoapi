# Post to Threads with your coding agent

**[Try it with your agent →](https://sosoapi.ai/try/threads)**

Give Codex or Claude Code a post or an idea. Your agent keeps your finished wording or drafts from your idea, then shows you the text and Threads account. Once you approve, it publishes through SosoAPI and follows the result until Threads confirms.

The demo opens your text in Codex. For Claude Code or an existing Codex chat, copy the prompt from the same page.

<a id="try-it-with-your-own-release"></a>

## Try it with your own post

Paste this into your coding agent and add your text:

```text
Use SosoAPI to publish one Threads post. Keep my finished wording, or draft a post from my idea.
Show me the exact text and intended Threads account for approval.
Once I approve, publish it once and return the confirmed Threads link if available.
Reuse my existing connection. If I need setup, follow
https://github.com/vicky-ai-tech/sosoapi/blob/main/AGENTS.md.

My post or idea:
<paste your text here>
```

[See an example of the writing step](examples/try-a-draft.md) · [Read the publishing benchmark](#benchmark).

## Connect Threads when you're ready

Already happy with the text? Open the [SosoAPI Quick Start](https://sosoapi.ai/docs/quickstart) and choose your workspace and Threads account. Connecting does not publish the draft.

To use Codex with the hosted MCP, follow the [connection guide](https://sosoapi.ai/setup.md). For the CLI workflow, use the prompt below after you approve the text, account and timing.

## Publish an approved post

Use a coding agent with terminal access and Node.js 20 or newer. Open this repo in the agent, or ask it to read the [publishing instructions](https://github.com/vicky-ai-tech/sosoapi/blob/main/AGENTS.md). Give it a prompt like this, replacing the handle and text:

```text
Publish this exact text now to @myhandle on Threads using SosoAPI:
<your post text>

Use this repo's AGENTS.md. Return the confirmed Threads link.
```

The agent runs the public `sosoapi@0.5.25` CLI. It resolves your workspace and account, sends the post once, and follows the same Post ID until Threads confirms. If the destination is ambiguous, it asks which account to use before posting.

If your agent already has access to the workspace and Threads is connected, it goes straight to publishing the exact text you requested. If CLI access is missing, approve workspace access in SosoAPI. Meta approval and SosoAPI's account review are only for connecting a Threads account. You can register during CLI sign-in. For a shared workspace, accept the owner's invitation before granting agent access. Your coding agent may separately ask for terminal permission.

## Check the install without signing in

```sh
npx -y sosoapi@0.5.25 posts --help
```

The help should list `posts publish` and `posts status`. After signing in, run `node examples/threads-target.mjs` from this repo to check which Threads connection the CLI can use. This example displays account selection and readiness; it makes no publish call.

For more terminal commands, see the [SosoAPI CLI reference](https://sosoapi.ai/docs/cli-reference).

## Benchmark

On November 16, 2026, both agents used `gpt-6.1-sol` at `xhigh` to publish the same text to the same Threads account. Both started with working authorization and returned a verified Threads post link. The terminal run used `sosoapi@0.5.25`. The browser run used the native Threads composer in Chrome through a browser-control relay.

| Measured result | SosoAPI CLI | Chrome |
| --- | ---: | ---: |
| Total model tokens | **93,975** | **387,385** |
| Cached input tokens | 88,704 | 345,216 |
| Uncached input tokens | 5,029 | 41,345 |
| Output tokens | 242 | 824 |
| Elapsed time per completed run | **49.44 s** | **156.72 s** |

The CLI used **87.8% fewer uncached input tokens** in this pair. Total tokens include all input and output, including cached input.

**Chrome's 156.72 seconds include 69.45 seconds waiting in the browser-control relay queue.** The timings describe this benchmark setup. See the [benchmark protocol](docs/benchmark.md) for the measurement method.

If the quickstart helps you, star this repo. Report a reproducible issue through [GitHub Issues](https://github.com/vicky-ai-tech/sosoapi/issues) with the CLI version and a redacted error message.
