# nvim-explorer

A Claude Code mod that keeps a file tree docked beside the chat, drawn the way Neovim's nvim-tree draws one: indent markers, folder arrows, optional Nerd Font icons, a cursorline, `~` past the end of the buffer and a lualine-style status bar. It moves with vim keys, shows git status, and puts files into your prompt as `@` mentions.

```text
skills-and-agents
▸ .github
▾ agents
└   relatorio-semanal.md        ✗
▸ mods                          ●
▸ skills
  LICENSE
  README.md
~
 NORMAL  NvimTree        All 3:8
```

## Use it

The pane opens by itself when the terminal is wide enough (144 columns, or 110 once you have opened it before) and Claude Code is in fullscreen mode. Claude Code places the dock; a mod can't choose its side. `/tree` opens or closes it at any width.

Click the tree once to give it the keyboard, then:

| Keys | Does |
| --- | --- |
| `j` `k`, arrows | down / up |
| `gg` `G`, Home End | top / bottom |
| `Ctrl-d` `Ctrl-u` | half page down / up |
| `Ctrl-f` `Ctrl-b`, PageDown PageUp | page down / up |
| `l` | open a folder or step into an open one; on a file, `@mention` it |
| `h` | close a folder, or go to its parent |
| `Enter` `o` | toggle a folder; on a file, `@mention` it in the prompt |
| `@` | `@mention` the row under the cursor, file or folder |
| `Backspace` | close the parent folder |
| `P` | go to the parent folder |
| `K` `J` | first / last sibling |
| `y` `Y` `gy` | copy the name / relative path / absolute path |
| `H` | show or hide dotfiles |
| `I` | show or hide git-ignored files |
| `W` | collapse every folder |
| `R` | refresh |
| `q` | close the pane |
| `?` | show the keys |

`Esc` hands the keyboard back to the prompt. With the mouse, a click on a folder toggles it and a second click on a file mentions it.

Git marks follow nvim-tree: `✗` changed, `✓` staged, `★` untracked, `➜` renamed, `!` conflicted, `◌` ignored (the row is dimmed), and `●` on a folder that holds changes. The tree re-reads the disk and git after Claude writes or runs a command, and every five seconds while it is shown.

## Install

Load it for one session from this repository:

```bash
claude --plugin-dir mods/nvim-explorer
```

## Options

| Option | Values | Default |
| --- | --- | --- |
| `icons` | `unicode` draws `▸`/`▾` arrows with any font; `nerd` adds nvim-tree's folder and nvim-web-devicons file icons | `unicode` |

`nerd` needs a [Nerd Font](https://www.nerdfonts.com/) as your terminal's font, or its icons show as boxes. On Windows Terminal, install CaskaydiaCove Nerd Font (Cascadia Code with the icons patched in), pick it under Settings → your profile → Appearance → Font face, then set `icons` to `nerd` in `/config`.

## Develop

```bash
claude plugin validate mods/nvim-explorer
claude plugin test mods/nvim-explorer
```

`hooks/register.tsx` reads the disk and git and keeps the open folders in session state; `hooks/tree.tsx` is the `Client` that draws the tree and takes the keys; `hooks/git.ts` parses `git status`.
