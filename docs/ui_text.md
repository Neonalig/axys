<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# UI text

Every string a person reads in Axys: labels, tooltips, dialogs, toasts, hints, readouts and screen
reader announcements. Log lines and code comments are not covered here.

The base is the GNOME Human Interface Guidelines, which are written for desktop application chrome.
Where they are silent, Apple's Human Interface Guidelines settle alerts and the Microsoft Writing
Style Guide settles error messages. When a string is in doubt, find how a mainstream editor says the
same thing (a DAW, Photoshop, VS Code, Office) and say it that way.

- GNOME writing style: https://developer.gnome.org/hig/guidelines/writing-style.html
- GNOME tooltips: https://developer.gnome.org/hig/patterns/feedback/tooltips.html
- GNOME dialogs: https://developer.gnome.org/hig/patterns/feedback/dialogs.html
- Apple alerts: https://developer.apple.com/design/human-interface-guidelines/alerts
- Microsoft error messages: https://learn.microsoft.com/en-us/style-guide/procedures-instructions/writing-error-messages

## The rule behind every other rule

UI text is a label on a control, not a sentence in a story. Say what the control is or does, in the
words every other program uses, and stop. Never say why it exists, what it used to do, or how it
works inside.

## By kind

| Kind                       | Form                         | Capitals      | Period                 | Length           |
| -------------------------- | ---------------------------- | ------------- | ---------------------- | ---------------- |
| Button, menu item, command | Verb or verb-noun            | Title Case    | No                     | 1 to 3 words     |
| Heading, tab, panel title  | Noun phrase                  | Title Case    | No                     | 1 to 3 words     |
| Field label                | Noun                         | Title Case    | No                     | 1 to 2 words     |
| Checkbox, radio button     | Noun or verb phrase          | Sentence case | No                     | Short            |
| Tooltip                    | Fragment, what it does or is | Sentence case | No                     | About 8 words    |
| Dialog title               | Question or verb-noun        | Title Case    | No, `?` for a question | Short            |
| Dialog body                | One or two plain sentences   | Sentence case | Yes                    | 1 to 2 sentences |
| Toast, announcement        | Result, past participle      | Sentence case | No                     | 2 to 6 words     |
| Error                      | What failed, then the fix    | Sentence case | Yes when two sentences | 1 to 2 sentences |
| Hint, empty state          | Imperative                   | Sentence case | No                     | One line         |
| Readout, status item       | Label and value              | As labels     | No                     | Minimal          |

A toolbar button's tooltip is its label and shortcut, `Save Project (Ctrl+S)`, and nothing more.

## Standard words

Use the term most mainstream programs use for the same thing, never a paraphrase of it. A label
names what it does, never what it does not: no "Don't" or "No" labels.

| Use                   | Not                          |
| --------------------- | ---------------------------- |
| Apply, Cancel         | Keep it, Drop it, Abort      |
| Save, Discard, Cancel | Don't Save, Save First       |
| Discard               | Throw away, Lose, Don't Keep |
| Delete, Remove        | Take away, Get rid of        |
| Reset                 | Go back, Restore as sung     |
| Open, Import, Export  | Bring in, Write out          |
| Relink                | Find again, Point at         |
| Mute, Solo            | Silence, Hear alone          |
| Unsaved changes       | Edits that are not saved     |
| Not found, Missing    | Could not be found anywhere  |
| Enter, Esc            | the Return key, Escape       |

Name things by their label in the UI, in Title Case where the UI writes them that way: "Open
Correction", "Choose a Guide Track".

## Banned patterns

- **Rationale.** No "because", "so that", "which is why", "rather than". A control says what it
  does.
  - No: "Leaves this blob out of scale correction and MIDI guidance. It still sounds, and edits
    made on it by hand still apply"
  - Yes: "Skip this blob in correction and MIDI guidance"
- **Narrating the consequence in prose.** State the consequence as a fact, once.
  - No: "Phrase has edits that are not saved. Starting a new project discards them."
  - Yes: title "Save Changes to Phrase?", body "Unsaved changes will be lost.", buttons Save,
    Discard, Cancel.
- **Pronouns for things with names.** No "it", "them", "this one" where the object has a name. A
  string is read out of context.
- **Second sentences that restate the first.**
- **Colloquial verbs for standard actions.** "Keeps", "drops", "throws away", "takes back".
  - No: "Drag the handles to shape the curve. Enter keeps it, Escape drops it"
  - Yes: "Drag handles to shape. Enter to apply, Esc to cancel"
- **Internal terms.** Say what the user sees, not the model behind it. "Plan", "layer", "voice",
  "worklet", "core", "session" do not appear in UI text. "Blob", "Clip", "Source", "Reference" and
  "Guide" do, because they are on screen.
- **Hedging and filler.** "Just", "simply", "please", "actually", "at all", "anyway".
- **Typographic flourish.** ASCII only: no em or en dash, no curly quotes, no ellipsis character.
  `...` only on a command that asks for more input before it acts.

## Dialogs

A confirmation is a title, at most one body sentence, and buttons named for what they do. The
button that does the asked-for thing names the action; Cancel is always Cancel.

| Case            | Title                   | Body                                     | Buttons                  |
| --------------- | ----------------------- | ---------------------------------------- | ------------------------ |
| Unsaved changes | Save Changes to {Name}? | Unsaved changes will be lost.            | Save, Discard, Cancel    |
| Delete          | Delete {Name}?          | This cannot be undone. (only if true)    | Delete, Cancel           |
| Choice          | Import Audio            | Import {Name} as a vocal or a reference? | Vocal, Reference, Cancel |

## Errors

What failed, then what to do, in the user's words. No stack of clauses, no blame.

- No: "this audio is not phrase.wav, which the project was made from"
- Yes: "Audio does not match phrase.wav. Choose the original file."
- No: "The audio engine could not be downloaded, so nothing can play."
- Yes: "Audio engine failed to load. Check your connection and reload."

## Toasts and announcements

The result, not the story: "Project saved", "3 blobs selected", "Loop cleared", "Imported
phrase.wav". Add a second clause only for a next step the user must take: "Imported 2 files. 1 is
missing its audio".
