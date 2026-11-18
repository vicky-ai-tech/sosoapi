# Try a release, get a Threads draft

No SosoAPI login or Threads connection is needed. Here's a real change from the [public Threads benchmark](https://github.com/vicky-ai-tech/sosoapi/blob/60a18483f8db0011cb61e9efa93d076d9803df23/README.md#benchmark).

**Release notes**

- In one matched run, publishing identical text to the same Threads account used 387,385 total model tokens in Chrome and 93,975 with the CLI.
- Both used the same model, started already authorized and returned a confirmed Threads link.

**One possible draft**

> Same Threads post, same model, same account. Chrome used 387,385 tokens. Our CLI used 93,975. That's 75.7% fewer in this one test. Both runs returned a confirmed post link.

**Try your own:** Paste the [draft-only prompt](../README.md#try-it-with-your-own-release) and your notes into Codex or Claude Code. Or [open the single-file browser demo](threads-draft.html): on GitHub, choose **Download raw file**, then open the saved HTML in your browser. It works offline. The browser demo formats custom notes locally; it doesn't invoke a model.

When you're happy with the text, you can [connect Threads](https://sosoapi.ai/docs/quickstart). You choose the account and when to publish.
