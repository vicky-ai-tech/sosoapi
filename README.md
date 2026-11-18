# Post to social media with your coding agent

Install one skill to post to Threads, Facebook Pages, Instagram, X and YouTube. Give your agent the accounts, caption and any media, then ask for the links. You can name several destinations in one request.

## Install

From your project with Node.js 22.20 or newer, run the command for your agent. It installs the skill in this project without interactive prompts. Restart the agent session to pick it up.

| Agent | Project install |
| --- | --- |
| Codex | `npx --yes skills add vicky-ai-tech/sosoapi --skill meta-browser-post -a codex -y` |
| Claude Code | `npx --yes skills add vicky-ai-tech/sosoapi --skill meta-browser-post -a claude-code -y` |

## Choose how to post

**1. Use my browser.** Start with your native social account in Google Chrome. You can use this route without signing up for SosoAPI. On first use the skill installs its pinned browser driver automatically. Your agent can open a dedicated Chrome profile for native sign-in and 2FA. You can also use a local Chrome debugging session you control.

**2. Use the SosoAPI CLI.** Register or sign in to SosoAPI and connect the accounts in your workspace once. The agent sends your request through the official API and gets a compact result. The original live Threads benchmark used 75.7% fewer total model tokens than manually driving the browser; the newer browser skill has its own measured comparison. [Benchmarks](#benchmark) · [SosoAPI Quick Start](https://sosoapi.ai/docs/quickstart)

The skill remembers your first choice. Say “use the browser” or “use SosoAPI” to override it for one new post, or ask the agent to change your default. A pending post stays on the route that submitted it.

<a id="try-it-with-your-own-release"></a>
<a id="post-directly-from-a-browser"></a>

## Try it with your own post

> Use my browser to post “Give me a rabbit hole worth losing 15 minutes to.” on Threads as @myhandle. Send me the link.

> Use SosoAPI to post this photo and caption to @mythreads on Threads, @myinstagram on Instagram and my Facebook Page with the connected handle @mypage. Show me the preview first.

Use your own accounts and supply the photo for the second example. Your agent checks every destination before submitting. If one is still pending, it can check that post while keeping the successful results. For YouTube, give the MP4, channel, exact title, visibility and audience. The browser route uses the channel ID from your YouTube Studio URL. The API route accepts the connected handle or SosoAPI account ID.

[Open the Threads demo](https://sosoapi.ai/try/threads) · [Try a draft](examples/try-a-draft.md) · [Skill commands](skills/meta-browser-post/SKILL.md)

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

### Browser skill and API skill

In one matched Codex development run per route, both routes returned every expected link. The browser used real Chromium against intercepted native pages. The API used the published SosoAPI CLI against a local service fixture. These runs count all session input and output tokens. Use the measured differences as observations for these tasks.

| Approved task | Browser CLI | SosoAPI CLI |
| --- | ---: | ---: |
| One Threads text post | 85,299 tokens · 23.8 s | 85,337 tokens · 25.9 s |
| One photo to Facebook, Instagram and Threads | 116,199 tokens · 29.6 s | 115,966 tokens · 34.1 s |

Total tokens differed by at most 0.21% in these two pairs and the lower-token route varied by task. [Token breakdown and first-use handoffs](docs/benchmark.md#dual-cli-development-measurement)

### Earlier live Threads benchmark

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
