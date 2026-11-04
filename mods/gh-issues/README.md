# gh-issues

A Claude Code mod that keeps the GitHub issues of your projects docked beside the chat, drawn like FileTree's: one folder per project, its issues under it, a cursorline and a lualine-style status bar. Open an issue and it shows in a sheet above the prompt, as wide as the chat, with its description and comments rendered as Markdown. Then hand it to Claude: in the conversation, in the prompt box for you to add to, or to a subagent working in the background.

```text
work
▾ backend  acme/backend                   2
│ #42 Login breaks on Safari             2d
└ #12 Typo in README                     3w
▾ frontend  acme/web                      1
└ #7 Dark mode                           3h
  scripts  no GitHub remote
~
 NORMAL  Issues                open All 2:6
```

It needs the [GitHub CLI](https://cli.github.com/), signed in: `gh auth status` should say so. The mod only reads issues. It never comments on, edits or closes them.

## Use it

The pane opens by itself when the session's folder holds a GitHub project, the terminal is wide enough (144 columns, or 110 once you have opened it before) and Claude Code is in fullscreen mode. `/issues` opens or closes it at any width. With FileTree loaded too, the two panes share the dock as tabs.

Click the pane once to give it the keyboard, then in the list:

| Keys | Does |
| --- | --- |
| `j` `k`, arrows | down / up |
| `gg` `G`, Home End | top / bottom |
| `Ctrl-f`, PageDown / PageUp | page down / up |
| `Ctrl-u` | half page up |
| `l` | open a project; on an issue, show it in the sheet above the prompt |
| `Enter` `o` | open or close a project, as nvim-tree's do; on an issue, show it, or put it away when the sheet already shows it |
| `x` | put the sheet away |
| `h` | close a project, or go to it from one of its issues |
| `Backspace` | close the project the cursor is on or in |
| `K` `J`, `P` | first / last sibling, the project above |
| `/` | search, as GitHub's own search box reads it (see below) |
| `s` | list open, then closed, then all issues |
| `m` | list only the issues assigned to you, or all of them again |
| `W` | close every project |
| `q` | put the sheet away, or close the pane when none shows |

The sheet sits under a line naming the issue, with its actions under that, each key in brackets:

```text
── getuliobr/civsim#12 ──────────────────────────────────────────── [-]
[ c ] Send to Claude   [ i ] Fill prompt   [ a ] Agent   [ b ] Browser   [ x ] Close
```

Then come the issue's title, state, author, labels, description and comments, and the list marks its row with `◆`. The mouse wheel scrolls the sheet; its `[-]` folds it down to a line. Its keys work once you click the sheet or press `Ctrl-x Tab`, and then the arrows scroll it. In VS Code and on mobile, which draw no sheet, the pane itself shows the issue.

On an issue in the list:

| Keys | Does |
| --- | --- |
| `c` | send it to Claude in this conversation; it starts once Claude is free |
| `i` | put that request in the prompt box, for you to add to and send |
| `a` | start a subagent on it in the project's folder, while you keep talking |
| `gx` | open it in the browser |
| `@` | put `owner/repo#42` in the prompt |
| `y` `Y` | copy `#42` / its address |
| `R` | read GitHub again |
| `?` | show the keys |

`Esc` hands the keyboard back to the prompt, and so do `Ctrl-d` and `Ctrl-b`, which Claude Code keeps for itself, so they never reach the pane. The keys are read as typed: with Caps Lock on, `j` arrives as `J`. With the mouse, a click on a project opens or closes it, and a second click on an issue shows it.

## Search

`/` opens a line at the bottom of the pane, as vim's search does, holding the search in force. Type in GitHub's search syntax and press `Enter`; every project lists only what matches, and the search stays at the top of the pane:

```text
/assignee:@me label:bug
/is:closed author:alice "dark mode"
/no:assignee sort:updated-desc
```

`Backspace` edits it, `Ctrl-u` clears the line, and `Enter` on an empty line lists everything again. `Backspace` on an empty line puts it away without searching. From the prompt, `/issues assignee:@me` opens the pane on that search. `s` and `m` still apply on top of the search, but an `is:open` or `is:closed` in it wins over `s`. The search is GitHub's, so it reads `label:`, `author:`, `mentions:`, `milestone:`, `no:label`, words in the title or body, and the rest of its qualifiers.

What Claude gets names the issue, its repository, the project's folder and the address, and asks Claude to read the issue and its comments with `gh issue view <n> --repo <owner/repo> --comments` before starting. The issue's own text, its title included, is not pasted into the request. Anyone who can open an issue wrote that text, so it reaches Claude as a command's output rather than as your words.

## Where the issues come from

The pane lists the issues of the folder the session started in, if it is a git repository, and of each folder just under it that is one. Started in a folder holding a `backend` and a `frontend` repository side by side, it lists both. A project's GitHub repository is its `upstream` remote, as a fork's is, or else its `origin`. Two clones of one repository are listed once, and a repository with no GitHub remote is shown dimmed, without issues. The pane reads at most eight repositories and the newest 50 issues of each, with how long ago each was last updated. A count of `50+` means there are more: `gx` opens the rest on GitHub.

The pane reads GitHub when it opens, on `R`, every five minutes while it is shown, and after Claude runs a `gh issue` or `gh pr` command. A failed read says why under its project, such as `Not signed in: run gh auth login`. An issue with a very long description or many comments is cut to fit, and the sheet says what it left out.

## Install

Load it for one session from this repository:

```bash
claude --plugin-dir mods/gh-issues
```

## Develop

```bash
claude plugin validate mods/gh-issues
claude plugin test mods/gh-issues
```

`hooks/register.tsx` finds the projects, runs `git` and `gh`, keeps the open projects, the filter and the open issue in session state, draws the sheet in the band above the prompt, and answers what the pane posts. `hooks/issues.tsx` is the `Client` that draws the list and takes the keys. `hooks/github.ts` reads remotes and `gh`'s JSON and words the request to Claude. `hooks/shared.ts` shares each read between the pane's draws, and reads again when Claude Code drops a draw midway.
