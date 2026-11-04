# gh-prs

A Claude Code mod that keeps the GitHub pull requests of your projects docked beside the chat, drawn like gh-issues and FileTree: one folder per project, its pull requests under it with their checks, a cursorline and a lualine-style status bar. Open a pull request and it shows in a sheet above the prompt, as wide as the chat: its conversation, reviews and checks as Markdown, or, with `d`, its changed files as colored diffs. Then hand it to Claude: to review it, to fix what its reviews and checks found, in the prompt box for you to add to, or to a subagent reviewing it in the background.

```text
work
▾ backend  acme/backend                   2
│ #42 Fix login on Safari             ✗ 2d
└ #12 Bump deps                         3w
▾ frontend  acme/web                      1
└ #7 Dark mode                        ✓ 3h
  scripts  no GitHub remote
~
 NORMAL  PRs                   open All 2:6
```

The number is drawn in the color of GitHub's icon for the pull request: green while open, gray as a draft, purple once merged, red when closed. The mark after the title sums up its checks: `✗` when any failed, `●` while any still runs, `✓` when all passed, nothing when it has none.

It needs the [GitHub CLI](https://cli.github.com/), signed in: `gh auth status` should say so. The mod only reads pull requests. It never comments on, approves, merges or checks out anything itself.

## Use it

The pane opens by itself when the session's folder holds a GitHub project, the terminal is wide enough (144 columns, or 110 once you have opened it before) and Claude Code is in fullscreen mode. `/prs` opens or closes it at any width. With gh-issues or FileTree loaded too, the panes share the dock as tabs.

Click the pane once to give it the keyboard, then in the list:

| Keys | Does |
| --- | --- |
| `j` `k`, arrows | down / up |
| `gg` `G`, Home End | top / bottom |
| `Ctrl-f`, PageDown / PageUp | page down / up |
| `Ctrl-u` | half page up |
| `l` | open a project; on a pull request, show it in the sheet above the prompt |
| `Enter` `o` | open or close a project, as nvim-tree's do; on a pull request, show it, or put it away when the sheet already shows it |
| `d` | show the pull request's changed files; on the one the sheet shows, turn between its files and its conversation |
| `x` | put the sheet away |
| `h` | close a project, or go to it from one of its pull requests |
| `Backspace` | close the project the cursor is on or in |
| `K` `J`, `P` | first / last sibling, the project above |
| `/` | search, as GitHub's own search box reads it (see below) |
| `s` | list open, then merged, then closed, then all pull requests |
| `m` | list everyone's, then yours, then those waiting on your review |
| `W` | close every project |
| `q` | put the sheet away, or close the pane when none shows |

The sheet sits under a line naming the pull request, with its actions under that, each key in brackets:

```text
── acme/backend#42 ──────────────────────────────────────────────────── [-]
[ c ] Review   [ f ] Fix   [ i ] Fill prompt   [ a ] Agent   [ d ] Diff   [ b ] Browser   [ x ] Close
```

Then comes the pull request: its title and state, who opened it from which branch into which, its additions and deletions, the review decision and any conflict with the base branch, its labels and the reviewers asked, its checks (each failing or running one by name), its description, and its comments and reviews in the order they came. `d` turns the sheet to the changed files instead: each file with its additions and deletions, a rename, a new, deleted or binary file said beside its name, and its hunks drawn as a diff, colored and numbered. The list marks the pull request's row with `◆`. The mouse wheel scrolls the sheet; its `[-]` folds it down to a line. Its keys work once you click the sheet or press `Ctrl-x Tab`, and then the arrows scroll it. In VS Code and on mobile, which draw no sheet, the pane itself shows the pull request, with the same actions as buttons.

On a pull request in the list:

| Keys | Does |
| --- | --- |
| `c` | ask Claude in this conversation to review it; it starts once Claude is free |
| `f` | ask Claude to fix what its reviews and failing checks found, on its branch |
| `i` | put a request naming it in the prompt box, for you to say what to do and send |
| `a` | start a subagent reviewing it in the project's folder, while you keep talking |
| `gx` | open it in the browser |
| `@` | put `owner/repo#42` in the prompt |
| `y` `Y` | copy `#42` / its address |
| `R` | read GitHub again |
| `?` | show the keys |

`Esc` hands the keyboard back to the prompt, and so do `Ctrl-d` and `Ctrl-b`, which Claude Code keeps for itself, so they never reach the pane. The keys are read as typed: with Caps Lock on, `j` arrives as `J`. With the mouse, a click on a project opens or closes it, and a second click on a pull request shows it.

## What Claude is asked

Every request names the pull request, its repository, the project's folder and the address, and asks Claude to read the pull request with `gh` before starting. Its own text, title and branch name included, is not pasted into the request. Anyone who can open a pull request wrote that text, so it reaches Claude as a command's output rather than as your words.

- **Review** (`c`) asks Claude to read the pull request and its comments (`gh pr view --comments`), its changes (`gh pr diff`) and its checks (`gh pr checks`), and to report what it finds, the most serious first. Claude is told to leave the pull request as it is on GitHub and not to check out its branch.
- **Fix** (`f`) asks Claude to check out the branch in the project's folder with `gh pr checkout`, stopping to ask first if the working tree has changes of its own, then to read the pull request, the comments on its code and its checks, and to commit the fixes on that branch. It is told not to push or reply on GitHub until you say so.
- **Fill prompt** (`i`) names the pull request and how to read it, and leaves the rest of the request to you.
- **Agent** (`a`) is the review, run by a subagent in the project's folder that reports back without editing files or checking out the branch.

## Search

`/` opens a line at the bottom of the pane, as vim's search does, holding the search in force. Type in GitHub's search syntax and press `Enter`; every project lists only what matches, and the search stays at the top of the pane:

```text
/label:bug draft:false
/author:alice "dark mode"
/review:approved status:failure
```

`Backspace` edits it, `Ctrl-u` clears the line, and `Enter` on an empty line lists everything again. `Backspace` on an empty line puts it away without searching. From the prompt, `/prs label:bug` opens the pane on that search. `s` and `m` still apply on top of the search, but an `is:` in it wins over `s`. The search is GitHub's, so it reads `label:`, `author:`, `review:`, `status:`, `draft:`, `base:`, `head:`, words in the title or body, and the rest of its qualifiers.

## Where the pull requests come from

The pane lists the pull requests of the folder the session started in, if it is a git repository, and of each folder just under it that is one. Started in a folder holding a `backend` and a `frontend` repository side by side, it lists both. A project's GitHub repository is its `upstream` remote, as a fork's is, or else its `origin`. Two clones of one repository are listed once, and a repository with no GitHub remote is shown dimmed, without pull requests. The pane reads at most eight repositories and the newest 50 pull requests of each, with how long ago each was last updated. A count of `50+` means there are more: `gx` opens the rest on GitHub.

The pane reads GitHub when it opens, on `R`, every five minutes while it is shown (every two while a listed pull request's checks still run), and after Claude runs a `gh pr` command that changes a pull request or a `git push`. A failed read says why under its project, such as `Not signed in: run gh auth login`. A pull request with a very long description or conversation is cut to fit, and so is a long diff, whole files at a time: a file past the room is listed without its hunks, and the sheet says what it left out.

## Install

Load it for one session from this repository:

```bash
claude --plugin-dir mods/gh-prs
```

## Develop

```bash
claude plugin validate mods/gh-prs
claude plugin test mods/gh-prs
```

`hooks/register.tsx` finds the projects, runs `git` and `gh`, keeps the open projects, the filter, the open pull request and the sheet's tab in session state, draws the sheet in the band above the prompt, and answers what the pane posts. `hooks/prs.tsx` is the `Client` that draws the list and takes the keys. `hooks/github.ts` reads remotes, `gh`'s JSON and unified diffs, writes the pull request as Markdown and words the requests to Claude. `hooks/shared.ts` shares each read between the pane's draws, and reads again when Claude Code drops a draw midway.
