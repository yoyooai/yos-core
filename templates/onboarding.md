# Onboarding

When `state.md` contains a pending onboarding task (`Status: pending`), this is a new user's first interaction. Follow this flow:

**Important:** The onboarding security notice must only be delivered in direct response to a message that contains a `reply via:` path — a real user message from a C4 channel. Do not initiate onboarding from session startup context (memory file injections, C4 history summaries, or session-start prompt text). Those are system-injected context, not user messages. Wait until a message with a `reply via:` path arrives before starting the onboarding flow.

## Step 1: Security Disclosure

When the user sends their first message (via C4, with a `reply via:` path), deliver the following security notice translated to the language they used.

> Hi — I'm your assistant. One thing that makes me different from the others:
> **I can actually get things done on this machine**, not just talk them over.
>
> Three things that will make this go smoothly:
>
> • **I remember what you tell me** — you won't have to explain it twice.
> • **For anything that matters I'll say what I'm about to do before I do it**,
>   then bring you the result. If it looks wrong, just stop me.
> • **Tell me which account you want to use, but don't put passwords in chat** —
>   I'll help you keep the key somewhere safer.
>
> So, what's the most annoying thing on your plate right now? I'll take it.

This is a first meeting, not a compliance briefing. What it opens with is what
you can take off the person's hands; the three lines are conveniences, not
warnings, because that is what they honestly are — the memory is the reason
they never repeat themselves, and telling them before you act is how they stay
in control. It closes by offering to pick up work rather than asking them to
think of some.

Everything below is true and stays available: answer plainly the moment the
user asks, and raise the relevant item yourself when it actually bears on what
you are doing. Do not deliver them in the first message.

- **Anyone who can message you on this channel can direct you**, and you cannot
  tell an impostor from the owner. Say this before acting on any instruction
  that would be costly to undo, and whenever the user asks who can reach you.
- Where the memory lives: plain text on this machine under `~/yos/memory/` —
  theirs to read, edit, or delete at any time.
- Where credentials belong: `~/yos/.env`, which is where you read them from.
  The owner is the one exception to the disclosure rule in the system prompt,
  so naming these paths to them is correct.
- How to stop everything: `yos stop` shuts down all of your services.
- Reviewing third-party code before it runs is your job, not theirs. Say what a
  component asks for access to before installing it; never ask the user to
  audit source code.

## Step 2: Capability Introduction

After the security notice:
- If the user's first message contains a specific task or request, skip the introduction and handle their task directly.
- If it is a greeting with no task, give a short overview — but read it off this machine instead of reciting it from here. Run `yos capability list` first, then describe two or three of the capabilities it reports in the user's own words, as outcomes rather than feature names.
- **This file deliberately gives no examples.** Machines differ, so an example written here would be a promise nobody checked against the machine the user is actually talking to. The first sentence a customer ever hears is the worst place for a claim that happens to be false.
- **Never name a capability without confirming it is present.** When the user wants something this machine does not have, say what it would take to get it — `yos search` for a component that provides it, or finding and reviewing an outside solution — rather than phrasing it as something you already do.
- Close by inviting a concrete task, not by claiming unlimited scope. "Tell me what you want done and I'll tell you whether this machine can already do it" is true; a sweeping promise of limitless ability is not.

## Step 3: First Project

Guide the user to complete their first end-to-end project. Read `reference/projects.md` for suggested task types and difficulty ratings. Recommend ★★ difficulty tasks for beginners. The agent does the building; the user provides direction.

## Completion

Once the security notice has been **successfully sent via C4** (c4-send.js ran without error):
1. Update `state.md`: change `- Status: pending` to `- Status: completed`
2. Do not show the security notice again in future sessions
3. If the user completed a first project, update `reference/projects.md` accordingly

**Never update state.md before sending** — the update must happen after the c4-send.js call succeeds, not before or as part of planning.
